// Entry point: `pnpm bridge` (server) or `pnpm bridge:dry` (recorded fixture, no Telegram).
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeConfigFromEnv, loadEnv } from './env';
import { runDryRun, loadFixture } from './dryrun';
import { labelTeams } from './labels';
import { stripMediaTalk } from './media';
import { openClawConfigFromEnv, triggerOpenClaw } from './openclaw';
import { buildTriggerMessage } from './prompts';
import { UpdateScheduler } from './scheduler';
import { createBridgeServer } from './server';
import { BridgeStore } from './store';
import { sendTelegramText, telegramConfigFromEnv, telegramConfigured } from './telegram';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_FIXTURE = join(HERE, '..', 'fixtures', 'synth-balanced.recorded.json');

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}

async function dryRun(): Promise<void> {
  const env = loadEnv(process.cwd());
  const fixturePath = argValue('--fixture') ?? DEFAULT_FIXTURE;
  const fixture = loadFixture(fixturePath);
  const gapMs = Number(argValue('--gap-ms') ?? env.BRIDGE_DRY_GAP_MS ?? 20_000);
  const samples = await runDryRun({
    store: new BridgeStore({ snapshotDir: env.BRIDGE_SNAPSHOT_DIR || join(process.cwd(), '.snapshots') }),
    fixture,
    apiKey: (env.CEREBRAS_API_KEY || '').trim(),
    model: (env.CEREBRAS_KIMI_MODEL || '').trim(),
    baseUrl: env.CEREBRAS_BASE_URL,
    count: 3,
    gapMs: Number.isFinite(gapMs) ? Math.max(0, gapMs) : 20_000,
  });
  if (samples.length) {
    const latencies = samples.map((s) => s.ms);
    console.log('');
    console.log(`dry-run complete: ${samples.filter((s) => !s.skipped).length} sent, ${samples.filter((s) => s.skipped).length} skipped, latencies ${latencies.join(' / ')} ms`);
  }
}

async function serve(): Promise<void> {
  const env = loadEnv(process.cwd());
  const cfg = bridgeConfigFromEnv(env);
  const store = new BridgeStore({ snapshotDir: cfg.snapshotDir });
  const oc = openClawConfigFromEnv(env);
  const chatId = (env.TELEGRAM_CHAT_ID || '').trim();
  const telegram = telegramConfigFromEnv(env);
  const directPing = cfg.pingMode === 'commentary' && telegramConfigured(telegram);
  let triggering = false;
  let lastPingText = '';

  let scheduler: UpdateScheduler;
  scheduler = new UpdateScheduler({
    cadenceMs: cfg.cadenceMs,
    minGapMs: cfg.minGapMs,
    isMeaningful: () => store.memory.meaningful(),
    onTrigger: async (info) => {
      if (triggering) return false;
      triggering = true;
      try {
        // Fast path: forward the line already visible in the Theatre chat. No extra model call.
        if (directPing) {
          const line = store.memory.commentary;
          const now = Date.now();
          // Nothing new to forward is 'idle', not a failed trigger: it must not start a stall backoff.
          if (!line || now - line.at > Math.max(cfg.cadenceMs * 2, 15_000)) return 'idle';
          const text = labelTeams(stripMediaTalk(line.text), store.memory.teamLabels);
          if (!text || text === lastPingText) return 'idle';
          const sent = await sendTelegramText(telegram, text);
          if (!sent.ok) {
            console.log(`[scheduler] Telegram ping #${info.updateNumber} failed: ${sent.error ?? 'unknown error'}`);
            return false;
          }
          lastPingText = text;
          store.memory.addUpdate(text, false);
          scheduler.recordUpdate(text, false, line.t);
          console.log(`[scheduler] ping #${info.updateNumber} sent (Theatre line, ${text.length} chars)`);
          return true;
        }

        const snapshotPath = store.memory.snapshot?.path ?? null;
        const message = buildTriggerMessage(store.memory, {
          updateNumber: info.updateNumber,
          includeStatLine: info.includeStatLine,
          chatId,
          snapshotPath,
          triggerId: info.triggerId,
          triggeredAt: info.triggeredAt,
        });
        if (!chatId) {
          console.log('[scheduler] TELEGRAM_CHAT_ID is not set; not triggering.');
          return false;
        }
        if (!oc.token) {
          console.log('[scheduler] OPENCLAW_HOOK_TOKEN is not set; would trigger OpenClaw now.');
          return false;
        }
        const r = await triggerOpenClaw(oc, message);
        if (r.ok) console.log(`[scheduler] update #${info.updateNumber} triggered (run ${r.runId ?? 'accepted'})`);
        else console.log(`[scheduler] update #${info.updateNumber} not admitted: ${r.error ?? 'unknown error'}`);
        return r.ok;
      } finally {
        triggering = false;
      }
    },
  });

  const bridge = createBridgeServer({
    token: cfg.token,
    host: cfg.host,
    port: cfg.port,
    store,
    logger: (line) => console.log(`[bridge] ${line}`),
    recordUpdate: (text, skipped, triggerId) => {
      const r = scheduler.recordUpdate(text, skipped, store.memory.latest?.t ?? 0, triggerId);
      if (r.stale) {
        console.log('[agent] STALE update ignored (its trigger expired or was superseded)');
        return { stale: true };
      }
      console.log(`[agent] ${skipped ? 'SKIP' : 'update recorded'}${skipped ? '' : `: ${text.slice(0, 100)}`}`);
      return { stale: false };
    },
  });

  const addr = await bridge.listen();
  console.log(`TacticLens bridge listening on http://${addr.host}:${addr.port}`);
  console.log(`  MCP:       http://${addr.host}:${addr.port}/mcp  (streamable-http, Bearer BRIDGE_TOKEN)`);
  console.log(`  Extension: open the Theatre with ?bridge=1 (or enable the popup toggle)`);
  console.log(`  OpenClaw:  ${oc.url}  agent=${oc.agentId}${oc.token ? '' : '  [OPENCLAW_HOOK_TOKEN missing]'}`);
  console.log(`  Telegram:  ${chatId ? 'chat configured' : 'TELEGRAM_CHAT_ID missing (the agent cannot send)'}`);
  console.log(`  Cadence:   ${(cfg.cadenceMs / 1000).toFixed(0)}s live play · ping source=${directPing ? 'Theatre commentary (no extra model call)' : cfg.pingMode}`);
  console.log('  Secrets stay in .env; this process never prints them.');

  let lastLog = 0;
  const timer = setInterval(() => {
    void scheduler.tick(store.memory.latest).then((r) => {
      const now = Date.now();
      if (now - lastLog >= 10_000) {
        lastLog = now;
        const s = store.memory.latest;
        console.log(`[scheduler] ${r.action}/${r.reason} · live play ${(r.liveMs / 1000).toFixed(0)}s of ${(cfg.cadenceMs / 1000).toFixed(0)}s` +
          (s ? ` · scene ${s.scene} · liveness ${s.liveness} · ball ${s.ball?.state}` : ''));
      }
    });
  }, 1000);
  timer.unref?.();

  const shutdown = async (): Promise<void> => {
    clearInterval(timer);
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

const main = process.argv.includes('--dry') ? dryRun : serve;
main().catch((e: Error) => {
  console.error(`[bridge] ${e.message}`);
  process.exit(1);
});
