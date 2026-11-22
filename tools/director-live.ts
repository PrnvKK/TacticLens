// Live director smoke test: at most 5 real calls against Kimi on Cerebras, 15 s apart, with a payload
// built from a recorded fixture. Never runs in `pnpm test`. No fallback model.
// Usage: pnpm director:live. Needs CEREBRAS_API_KEY and CEREBRAS_KIMI_MODEL in the repo-root .env.
import { readFileSync } from 'node:fs';
import { parseSession } from '../core/src/replay/reader';
import { toFrameStates } from '../core/src/replay/run';
import { Engine, type EngineOutput } from '../core/src/engine/index';
import type { Event, FrameState } from '../core/src/types';
import {
  DIRECTOR_MAX_TOKENS, DIRECTOR_SCHEMA, DIRECTOR_SCHEMA_NAME, DIRECTOR_SYSTEM_PROMPT,
  Director, buildMenu, buildPayload, validateDecision, type DirectorCaller, type DirectorContext,
} from '../core/src/director/index';
import { KIMI_MODEL_ENV, resolveProvider, streamChat } from '../core/src/llm/index';
import type { LLMRequest } from '../core/src/llm/providers';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const key = /^CEREBRAS_API_KEY\s*=\s*(.+)$/m.exec(envText)?.[1]?.trim().replace(/^["']|["']$/g, '');
const model = /^CEREBRAS_KIMI_MODEL\s*=\s*(.+)$/m.exec(envText)?.[1]?.trim().replace(/^["']|["']$/g, '');
if (!key || !model) {
  console.log(`[director-live] set CEREBRAS_API_KEY and ${KIMI_MODEL_ENV} in .env; skipping.`);
  process.exit(0);
}

const file = process.argv[2] ?? 'fixtures/synth-balanced.jsonl';
const session = parseSession(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const { frames } = toFrameStates(session);
const engine = new Engine();
const recent: Event[] = [];
let best: { frame: FrameState; out: EngineOutput; events: Event[] } | null = null;
for (const f of frames) {
  const out = engine.update(f);
  recent.push(...out.events);
  while (recent.length && f.t - recent[0]!.t > 20) recent.shift();
  if (out.match.liveness !== 'LIVE' || f.scene.kind !== 'WIDE') continue;
  const live = new Set(f.tracks.filter((t) => t.cls !== 'referee' && t.timeSinceUpdate <= 0.4 && t.age >= 0.3).map((t) => t.id));
  const menu = buildMenu(out, f.t, live);
  if (!best || menu.items.length > buildMenu(best.out, best.frame.t, new Set(best.frame.tracks.map((t) => t.id))).items.length) {
    best = { frame: f, out, events: [...recent] };
  }
}
if (!best) {
  console.log('[director-live] no live wide frame with a menu');
  process.exit(1);
}
const { frame, out, events } = best;
const liveIds = frame.tracks.filter((t) => t.cls !== 'referee' && t.timeSinceUpdate <= 0.4 && t.age >= 0.3).map((t) => t.id);
const live = new Set(liveIds);
const menu = buildMenu(out, frame.t, live);
const ctx: DirectorContext = {
  nowS: Date.now() / 1000, t: frame.t, playbackRate: 1, liveness: 'LIVE', scene: frame.scene.kind,
  ballState: frame.ball.state, ballXY: frame.ball.xy, match: out.match, out, events, liveIds,
  onScreen: null, sinceLastGraphicS: 15, calm: { ready: true, reason: 'calm ready' },
};
const payload = buildPayload(ctx, menu);
console.log(`[director-live] fixture ${file} t=${frame.t.toFixed(1)}s menu=${menu.items.map((i) => i.id).join(',')}`);

const provider = resolveProvider('cerebras-kimi', key, { model });
const request: LLMRequest = {
  lane: 'director', framesSent: 0,
  schema: { name: DIRECTOR_SCHEMA_NAME, schema: DIRECTOR_SCHEMA },
  maxCompletionTokens: DIRECTOR_MAX_TOKENS, reasoningEffort: 'low',
  messages: [
    { role: 'system', content: DIRECTOR_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(payload) },
  ],
};
const caller: DirectorCaller = async (req) => {
  const r = await streamChat({ provider, request: req });
  return { status: r.ok ? 'ok' : 'error', parsed: r.parsed, timing: r.timing, error: r.error };
};

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
const N = Math.min(5, Number(process.env.DIRECTOR_LIVE_CALLS ?? 5));
let wall = Date.now() / 1000;
for (let i = 0; i < N; i++) {
  const d = new Director(caller, { now: () => wall, intervalS: 2 });
  const t0 = Date.now();
  const outcome = await d.tick({ ...ctx, nowS: wall });
  const res = outcome?.log;
  const parsed = outcome?.decision;
  console.log(JSON.stringify({
    call: i + 1,
    elapsedMs: Date.now() - t0,
    statusOk: !!outcome,
    action: parsed?.action ?? res?.action,
    graphic: parsed?.graphic ?? res?.graphic,
    targets: parsed?.targets ?? [],
    ttftMs: res?.ttftMs, totalMs: res?.totalMs,
    accepted: outcome?.accepted ?? false,
    reason: outcome?.reason ?? res?.reason ?? '',
    caption: parsed?.caption ?? '',
  }));
  wall += 15;
  if (i + 1 < N) await sleep(15_000);
}
