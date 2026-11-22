// pnpm llm:soak  -  headless soak of the director pipeline against a recorded fixture, no browser.
// Defaults: 60 s, adaptive cadence from a 3/s base (min 330 ms), up to 8 in flight, plus the watch lane
// every 3 s with a real 768x432 JPEG. Hard cap on requests (LLM_SOAK_MAX, default 150).
// Reads CEREBRAS_API_KEY and CEREBRAS_KIMI_MODEL from .env, never prints either. No fallback model.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseSession } from '../../core/src/replay/reader';
import { toFrameStates } from '../../core/src/replay/run';
import { Engine } from '../../core/src/engine/index';
import {
  DIRECTOR_SCHEMA, DIRECTOR_SCHEMA_NAME, DirectorPipeline, KIMI_PROMPT_SPEC, REFERENCE_MATCH, WatchLane, WATCH_SCHEMA, WATCH_SCHEMA_NAME,
  buildMenu, type DirectorContext, type PipelineCaller,
} from '../../core/src/director/index';
import { BUNDLED_CALIBRATION, BudgetGovernor, PromptBuilder, SpeedMeter, streamChat, percentile, type Calibration } from '../../core/src/llm/index';
import { liveSetup } from './common';

const setup = liveSetup();
if (!setup) { console.log('[soak] set CEREBRAS_API_KEY and CEREBRAS_KIMI_MODEL in .env; nothing to do.'); process.exit(0); }
const { provider, model } = setup;

const SECONDS = Number(process.env.LLM_SOAK_SECONDS ?? 60);
const HZ = Number(process.env.LLM_SOAK_HZ ?? 3);
const MAX = Number(process.env.LLM_SOAK_MAX ?? 150);
const WATCH_EVERY_S = Number(process.env.LLM_SOAK_WATCH_EVERY_S ?? 3);

let cal: Calibration = BUNDLED_CALIBRATION;
try { cal = JSON.parse(readFileSync(new URL('../../core/src/llm/cache/calibration.json', import.meta.url), 'utf8')) as Calibration; } catch { /* bundled */ }
const builder = new PromptBuilder(KIMI_PROMPT_SPEC, { model, calibration: cal });
console.log(`[soak] model ${model}, prompt ${KIMI_PROMPT_SPEC.version}, calibrated ${builder.calibrated}, ${SECONDS}s at ${HZ}/s, cap ${MAX} requests`);

// ---- recorded fixture -> contexts ----
const session = parseSession(readFileSync(new URL('../../fixtures/synth-balanced.jsonl', import.meta.url), 'utf8'));
const { frames } = toFrameStates(session);
const engine = new Engine();
const ctxs: DirectorContext[] = [];
const recent: import('../../core/src/types').Event[] = [];
for (const f of frames) {
  const out = engine.update(f);
  recent.push(...out.events);
  while (recent.length && f.t - recent[0]!.t > 20) recent.shift();
  if (out.match.liveness !== 'LIVE' || f.scene.kind !== 'WIDE') continue;
  const liveIds = f.tracks.filter((t) => t.cls !== 'referee' && t.timeSinceUpdate <= 0.4 && t.age >= 0.3).map((t) => t.id);
  ctxs.push({
    nowS: 0, t: f.t, playbackRate: 1, liveness: 'LIVE', scene: f.scene.kind, ballState: f.ball.state, ballXY: f.ball.xy,
    match: out.match, out, events: [...recent], liveIds, onScreen: null, sinceLastGraphicS: 15, calm: { ready: true, reason: 'calm ready' },
  });
}
if (!ctxs.length) { console.error('[soak] fixture has no LIVE wide frames'); process.exit(1); }
console.log(`[soak] fixture contexts ${ctxs.length}, with menu ${ctxs.filter((c) => c.out.detail.facts.overload.valid || c.out.detail.facts.keyPlayer.valid).length}`);

const frame768 = `data:image/jpeg;base64,${readFileSync(new URL('./fixtures/frame-768.jpg', import.meta.url)).toString('base64')}`;

// ---- run ----
const budget = new BudgetGovernor({ baseDirectorHz: HZ, baseWatchHz: 1 });
const speed = new SpeedMeter();
let requests = 0;
let n429 = 0;
const finals: { ttft: number; prompt: number; cached: number; completion: number; lane: string; valid: boolean; status: number; queueFull: boolean }[] = [];
const levels = new Set<string>();

// The director pipeline and the watch lane own the queue_full retry policy (newest-wins included);
// this caller is one HTTP attempt, so its counter already includes retries.
const caller = (lane: 'director' | 'watch', schema: { name: string; schema: object }): PipelineCaller => async (req, onEvent, ctl) => {
  requests++;
  const r = await streamChat({ provider, request: req, onEvent, signal: (ctl && ctl.id > 0 ? ctl.signal : undefined) as never });
  const t = r.timing;
  if (r.status === 429) n429++;
  const valid = r.ok && r.parseOk && schema.name.length > 0 && hasRequired(r.parsed, schema.schema);
  finals.push({ ttft: t.tFirstToken != null ? t.ttftMs : 0, prompt: t.usageReported ? t.tokensIn : 0, cached: t.cachedTokens ?? 0, completion: t.usageReported ? t.tokensOut : 0, lane, valid, status: r.status, queueFull: r.errorKind === 'queue_full' });
  return {
    status: r.ok ? 'ok' : r.aborted ? 'aborted' : 'error', parsed: r.parsed, timing: t, error: r.error,
    statusCode: r.status,
    ...(r.errorKind ? { errorKind: r.errorKind } : {}),
    ...(r.errorCode ? { errorCode: r.errorCode } : {}),
    ...(r.errorMessage ? { errorMessage: r.errorMessage } : {}),
  };
};

function hasRequired(v: unknown, schema: object): boolean {
  const s = schema as { required?: string[]; properties?: Record<string, { enum?: unknown[]; type?: string }> };
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  for (const k of s.required ?? []) if (!(k in o)) return false;
  for (const [k, p] of Object.entries(s.properties ?? {})) {
    if (p.enum && !p.enum.includes(o[k])) return false;
    if (p.type === 'string' && typeof o[k] !== 'string') return false;
    if (p.type === 'number' && typeof o[k] !== 'number') return false;
    if (p.type === 'array' && !Array.isArray(o[k])) return false;
  }
  return true;
}

const watch = new WatchLane(async (req, onEvent) => caller('watch', { name: WATCH_SCHEMA_NAME, schema: WATCH_SCHEMA })(req, onEvent, { signal: { aborted: false }, id: 0 }), {
  builder, budget, speed, match: () => REFERENCE_MATCH,
});
const reasonCounts: Record<string, number> = {};
const pipe = new DirectorPipeline(caller('director', { name: DIRECTOR_SCHEMA_NAME, schema: DIRECTOR_SCHEMA }), {
  builder, budget, speed, intervalMs: Math.round(1000 / HZ), maxInFlight: 4, maxInFlightCap: 8,
  strictSchema: false,   // match the live Theatre: the prompt carries the schema, usage keeps only completion
  match: () => REFERENCE_MATCH, seen: () => watch.seen(),
  fresh: () => {
    const c = cur();
    return { liveIds: c.liveIds, onScreen: null, calm: { ready: true, reason: 'calm ready' }, playbackRate: 1, menu: buildMenu(c.out, c.t, new Set(c.liveIds)) };
  },
  onOutcome: (o) => {
    if (o.accepted) return;
    const key = (o.reason ?? 'unknown').split(':')[0]!.trim() || 'unknown';
    reasonCounts[key] = (reasonCounts[key] ?? 0) + 1;
  },
});
const t0 = Date.now();
const cur = (): DirectorContext => ctxs[Math.floor(((Date.now() - t0) / 1000 / 0.2)) % ctxs.length]!;
let lastWatch = -Infinity;
let applied0 = 0;

while ((Date.now() - t0) / 1000 < SECONDS && requests < MAX) {
  const c = cur();
  pipe.pump({ ...c, nowS: Date.now() / 1000 });
  if (Date.now() - lastWatch >= WATCH_EVERY_S * 1000 && requests < MAX - 5) {
    lastWatch = Date.now();
    void watch.tick(frame768, { t: c.t, ids: c.liveIds });
  }
  levels.add(budget.rates().levelName);
  await new Promise<void>((r) => setTimeout(r, 15));
}
// let in-flight calls finish (counted, then discarded)
const drainStart = Date.now();
while (pipe.inFlight > 0 && Date.now() - drainStart < 15_000) await new Promise<void>((r) => setTimeout(r, 50));
await new Promise<void>((r) => setTimeout(r, 500));
const wall = (Date.now() - t0) / 1000;
void applied0;

const d = finals.filter((f) => f.lane === 'director' && f.status === 200);
const ttft = d.filter((f) => f.ttft > 0).map((f) => f.ttft);
const all = finals.filter((f) => f.status === 200);
const prompt = all.reduce((a, f) => a + f.prompt, 0);
const cachedT = all.reduce((a, f) => a + f.cached, 0);
const comp = all.reduce((a, f) => a + f.completion, 0);
const perMin = 60 / wall;
const snap = budget.snapshot();
const result = {
  model, seconds: Math.round(wall * 10) / 10, requests, directorCalls: pipe.stats.launched, watchCalls: watch.stats.launched,
  decisionsPerS: Math.round((pipe.stats.applied / wall) * 100) / 100,
  directorCallsPerS: Math.round((pipe.stats.launched / wall) * 100) / 100,
  applied: pipe.stats.applied, discardedOlder: pipe.stats.discarded, accepted: pipe.stats.accepted, rejectedByValidator: pipe.stats.rejected,
  staleDropped: pipe.stats.stale, rejectionReasons: reasonCounts,
  ttftP50Ms: Math.round(percentile(ttft, 50)), ttftP90Ms: Math.round(percentile(ttft, 90)), ttftP95Ms: Math.round(percentile(ttft, 95)),
  decisionP50Ms: Math.round(pipe.latency.p50()), decisionP90Ms: Math.round(pipe.latency.p90()),
  adaptive: { staleLimitS: Math.round(pipe.staleLimitS * 10) / 10, intervalMs: Math.round(pipe.launchIntervalMs), maxInFlight: pipe.maxInFlightNow },
  cacheHitPct: prompt ? Math.round((cachedT / prompt) * 1000) / 10 : 0,
  promptTokensPerMin: Math.round(prompt * perMin), cachedTokensPerMin: Math.round(cachedT * perMin), completionTokensPerMin: Math.round(comp * perMin),
  uncachedPromptTokensPerMin: Math.round((prompt - cachedT) * perMin),
  uncachedPlusCompletionPerMin: Math.round((prompt - cachedT + comp) * perMin),
  totalTokensPerMin: Math.round((prompt + comp) * perMin),
  requestsPerMin: Math.round(requests * perMin),
  queueFullRefusals: speed.queue.queueFull, rateLimitRefusals: speed.queue.rateLimited,
  retryAttempts: speed.queue.retries, retrySuccesses: speed.queue.retrySuccess, retrySuccessPct: speed.queue.retrySuccessPct(),
  retriesDropped: speed.queue.retriesDropped, queueCongestionPct: speed.queue.congestionPct(),
  queueFullFinal: finals.filter((f) => f.queueFull).length,
  http429: n429, nonOkResponses: finals.filter((f) => f.status !== 200).length,
  validSchemaPct: all.length ? Math.round((finals.filter((f) => f.valid).length / all.length) * 1000) / 10 : 0,
  budgetLevelsSeen: [...levels], finalBudget: { level: snap.levelName, uncachedPerMin: snap.uncachedPerMin, total: snap.totalPerMin },
  watchObservations: watch.stats.ok,
  speedState: speed.kimiState(),
};
console.log(JSON.stringify(result, null, 2));
writeFileSync(new URL('./soak-result.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
