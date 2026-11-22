// Stateless, pipelined director. Every call is the aligned stable prefix + a small delta tail. The launch
// cadence and the in-flight cap are ADAPTIVE: they come from a rolling p50/p90 of real time-to-decision, so
// the same pipeline keeps producing fresh decisions at 1 s or 20 s of Kimi latency. Only the
// NEWEST-STARTED result that arrives is applied, older ones that arrive later are discarded. Every applied
// result is re-validated on arrival against the CURRENT frame (live tracks, current facts, calm gate).
import type { LLMEvent } from '../llm/client';
import { looksQueueFull, type LLMErrorKind } from '../llm/errors';
import type { LLMRequest } from '../llm/providers';
import type { CallTiming } from '../llm/timing';
import { percentile } from '../llm/timing';
import { withQueueRetry } from '../llm/retry';
import { PromptBuilder, type BuiltPrompt } from '../llm/cache/builder';
import type { MatchBlock } from '../llm/cache/spec';
import { BudgetGovernor, SpeedMeter } from '../llm/budget';
import { DIRECTOR_MAX_TOKENS_FAST } from './kimiPrompt';
import { DIRECTOR_SCHEMA, DIRECTOR_SCHEMA_NAME } from './prompts';
import { allowedNumbers, buildPayload, scrubDecision, type DirectorCallResult, type DirectorContext } from './director';
import { buildMenu } from './menu';
import { validateDecision, type ValidateResult } from './validate';
import type {
  DirectorDecision, DirectorLogEntry, DirectorOutcome, DirectorPayload, GraphicsMenu, OnScreenGraphic,
} from './types';

export interface CallControl { signal: { aborted: boolean }; id: number }
export type PipelineCaller = (request: LLMRequest, onEvent: (e: LLMEvent) => void, ctl: CallControl) => Promise<DirectorCallResult>;

/** State that must be fresh at ARRIVAL time, not launch time. `menu` is the current frame's menu. */
export interface FreshState {
  liveIds: number[];
  onScreen: OnScreenGraphic | null;
  calm: { ready: boolean; reason: string };
  playbackRate: number;
  /** Facts/menu rebuilt from the frame that is current when the decision arrives. */
  menu?: GraphicsMenu;
}

export interface PipelineOptions {
  builder: PromptBuilder;
  intervalMs?: number;          // minimum launch gap, default 330
  maxInFlight?: number;         // base in-flight cap, default 4
  maxInFlightCap?: number;      // hard cap while adapting, default 8
  /** Fixed stale limit. When omitted the pipeline derives clamp(1.5 x p90, 3 s, 30 s). */
  staleS?: number;
  adaptive?: boolean;           // default true; false keeps intervalMs/staleS fixed
  repeatS?: number;
  maxCompletionTokens?: number; // default DIRECTOR_MAX_TOKENS_FAST
  /**
   * Send the strict response_format JSON schema (default true). A live demo can turn this off: the
   * schema is appended after the user message, is never cached, and costs ~200 uncached tokens on
   * every call. The stable prompt already contains the full output schema and the validator rejects
   * anything malformed, so dropping the API-level grammar buys ~2x more calls inside the budget.
   * Keep it on for the mock (it routes the scripted answer by schema name) and for tests.
   */
  strictSchema?: boolean;
  now?: () => number;           // wall ms
  budget?: BudgetGovernor;
  speed?: SpeedMeter;
  match?: () => MatchBlock | null;
  /** Latest compact "what the frame shows" observation from the watch lane. */
  seen?: () => string | null;
  /** Fresh state at arrival. */
  fresh?: () => FreshState | null;
  /** Ball trail of the last ~5 s as [x,y] percent. */
  trail?: () => [number, number][];
  onOutcome?: (o: DirectorOutcome, meta: { seq: number; ageMs: number }) => void;
  onDiscard?: (seq: number, reason: 'superseded' | 'error' | 'skipped') => void;
  /** queue_full retry policy; a retry is dropped as soon as a newer call has started (newest-wins). */
  queueRetry?: { maxRetries?: number; sleep?: (ms: number) => Promise<void>; random?: () => number };
}

export interface PipelineStats {
  launched: number; applied: number; discarded: number; errors: number; accepted: number; rejected: number; schemaInvalid: number; rate429: number; stale: number;
  /** Final queue_full refusals (after retries) and retries actually sent. */
  queueFull: number; queueRetries: number;
}

interface Pending {
  seq: number; startedMs: number; ctx: DirectorContext; menu: GraphicsMenu; payload: DirectorPayload; built: BuiltPrompt;
  settled: boolean; ttftMs: number; abort: { aborted: boolean }; timing: CallTiming | null; done: boolean;
  recorded: boolean;
}

const MIN_INTERVAL_MS = 330;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Classification fallback for injected callers that only carry the legacy HTTP string. */
function errorKindOf(res: DirectorCallResult): LLMErrorKind | null {
  if (res.errorKind) return res.errorKind;
  if (!res.error) return null;
  if (looksQueueFull(res.error)) return 'queue_full';
  if (/HTTP 429/.test(res.error)) return 'rate_limited';
  if (/HTTP 5\d\d/.test(res.error)) return 'server';
  return null;
}

/** Rolling time-to-decision samples (wall ms from launch to the JSON closing / call ending). */
export class DecisionLatency {
  private samples: { at: number; ms: number }[] = [];
  constructor(private now: () => number, private windowMs = 120_000, private maxSamples = 40) {}

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.samples.push({ at: this.now(), ms });
    this.trim();
  }

  private trim(): void {
    const cut = this.now() - this.windowMs;
    let i = 0;
    while (i < this.samples.length && this.samples[i]!.at < cut) i++;
    if (i) this.samples.splice(0, i);
    while (this.samples.length > this.maxSamples) this.samples.shift();
  }

  get count(): number { this.trim(); return this.samples.length; }
  p50(): number { this.trim(); return percentile(this.samples.map((s) => s.ms), 50); }
  p90(): number { this.trim(); return percentile(this.samples.map((s) => s.ms), 90); }
}

const g = globalThis as unknown as { AbortController: new () => { signal: { aborted: boolean }; abort(): void } };

export class DirectorPipeline {
  readonly log: DirectorLogEntry[] = [];
  readonly stats: PipelineStats = {
    launched: 0, applied: 0, discarded: 0, errors: 0, accepted: 0, rejected: 0, schemaInvalid: 0, rate429: 0, stale: 0,
    queueFull: 0, queueRetries: 0,
  };
  readonly latency: DecisionLatency;
  private lastShown = new Map<string, number>();
  private accepted: { atMs: number; a: DirectorDecision['action']; g: DirectorDecision['graphic'] }[] = [];
  private pending = new Map<number, Pending & { ac: { abort(): void } }>();
  private seq = 0;
  private newestApplied = 0;
  private lastLaunchMs = -Infinity;
  private now: () => number;

  constructor(private call: PipelineCaller, private o: PipelineOptions) {
    this.now = o.now ?? (() => Date.now());
    this.latency = new DecisionLatency(this.now);
  }

  get inFlight(): number { return this.pending.size; }
  get shown(): ReadonlyMap<string, number> { return this.lastShown; }
  noteShown(graphic: string, atMs: number): void { this.lastShown.set(graphic, atMs / 1000); }

  /** clamp(1.5 x p90, 3 s, 30 s) once two decisions have landed; before that the fixed default. */
  get staleLimitS(): number {
    if (this.o.adaptive === false) return this.o.staleS ?? 3;
    if (this.latency.count < 2) return this.o.staleS ?? 3;
    return clamp((1.5 * this.latency.p90()) / 1000, 3, 30);
  }

  /**
   * Base cap (4), raised with latency up to 8, then clamped by the budget governor's uncached-token and
   * request ceilings. While the shared queue is congested (>50% queue_full over the last 20 attempts)
   * the cap moves to the budget ceiling so extra in-flight calls absorb the fast refusals.
   */
  get maxInFlightNow(): number {
    const base = this.o.maxInFlight ?? 4;
    const cap = this.o.maxInFlightCap ?? 8;
    const congested = this.o.speed?.queue.congested() ?? false;
    if (this.o.adaptive === false) return clamp(base, 1, cap);
    if (this.latency.count < 2) {
      if (!congested) return clamp(base, 1, cap);
      const byBudget = this.o.budget?.concurrencyLimit('director', Math.max(1, base * MIN_INTERVAL_MS), cap) ?? cap;
      return clamp(Math.max(base, byBudget), 1, cap);
    }
    const byLatency = clamp(Math.max(base, Math.ceil(this.latency.p50() / MIN_INTERVAL_MS)), 1, cap);
    const byBudget = this.o.budget?.concurrencyLimit('director', Math.max(1, this.latency.p50()), cap) ?? cap;
    if (congested) return clamp(Math.max(byLatency, byBudget), 1, cap);
    return clamp(Math.min(byLatency, byBudget), 1, cap);
  }

  /** max(minimum gap, p50 / in-flight cap, the governor ladder's director interval). */
  get launchIntervalMs(): number {
    const base = this.o.intervalMs ?? MIN_INTERVAL_MS;
    let ms = base;
    if (this.o.adaptive !== false && this.latency.count >= 2) {
      ms = Math.max(ms, this.latency.p50() / Math.max(1, this.maxInFlightNow));
    }
    const ladder = this.o.budget?.rates().directorIntervalMs ?? 0;
    return Math.max(ms, ladder);
  }

  /** True when a call may launch now. `event` reactions skip the cadence (not the in-flight cap). */
  due(ctx: DirectorContext, event = false): boolean {
    if (ctx.liveness !== 'LIVE' || ctx.scene !== 'WIDE') return false;
    if (this.pending.size >= this.maxInFlightNow) return false;
    if (event) return true;
    return this.now() - this.lastLaunchMs >= this.launchIntervalMs;
  }

  /** Launch one call if allowed. Returns the sequence number or null. Never queues. */
  pump(ctx: DirectorContext, event = false): number | null {
    if (!this.due(ctx, event)) return null;
    const b = this.o.budget;
    if (b && !b.tryLaunch('director', { event })) return null;
    const t = this.now();
    this.lastLaunchMs = t;
    const live = new Set(ctx.liveIds);
    const menu = buildMenu(ctx.out, ctx.t, live);
    const payload = this.delta(ctx, menu, t);
    const built = this.o.builder.build({ lane: 'director', match: this.o.match?.() ?? null, tail: payload });
    const strict = this.o.strictSchema !== false;
    const request: LLMRequest = {
      lane: 'director', framesSent: 0, schema: strict ? { name: DIRECTOR_SCHEMA_NAME, schema: DIRECTOR_SCHEMA } : null,
      maxCompletionTokens: this.o.maxCompletionTokens ?? DIRECTOR_MAX_TOKENS_FAST, reasoningEffort: 'low', messages: built.messages,
    };
    const seq = ++this.seq;
    const ac = new g.AbortController();
    const p: Pending & { ac: { abort(): void } } = {
      seq, startedMs: t, ctx, menu, payload, built, settled: false, ttftMs: 0, abort: ac.signal, timing: null, done: false, recorded: false, ac,
    };
    this.pending.set(seq, p);
    this.stats.launched++;
    b?.begin('director');
    void this.run(p, request);
    return seq;
  }

  private delta(ctx: DirectorContext, menu: GraphicsMenu, nowMs: number): DirectorPayload {
    const base = buildPayload(ctx, menu);
    const recent = this.accepted.filter((a) => nowMs - a.atMs <= 30_000).slice(-3)
      .map((a) => ({ ago: Math.round((nowMs - a.atMs) / 1000), a: a.a, g: a.g }));
    const events = base.events.filter((e) => ctx.t - e.t <= 6).slice(-3);
    const out: DirectorPayload = { ...base, events, recent };
    const seen = this.o.seen?.();
    if (seen) out.seen = seen;
    const trail = this.o.trail?.();
    if (trail && trail.length) out.trail = trail.slice(-3);
    return out;
  }

  private async run(p: Pending & { ac: { abort(): void } }, request: LLMRequest): Promise<void> {
    const onEvent = (e: LLMEvent): void => {
      if (e.type === 'first_token') { p.ttftMs = e.ttftMs; this.o.speed?.ttft(e.ttftMs); }
      else if (e.type === 'json') this.settle(p, { status: 'ok', parsed: e.value });
    };
    const callOnce = async (): Promise<DirectorCallResult> => {
      try {
        return await this.call(request, onEvent, { signal: p.abort, id: p.seq });
      } catch (err) {
        return { status: 'error', error: String((err as Error)?.message ?? err), errorKind: 'network' };
      }
    };
    const res = await withQueueRetry(callOnce, (r) => (r.status !== 'ok' && r.errorKind === 'queue_full'
      ? { kind: 'queue_full', ...(r.errorCode ? { code: r.errorCode } : {}), ...(r.errorMessage ? { message: r.errorMessage } : {}) }
      : null), {
      ...this.o.queueRetry,
      meter: this.o.speed?.queue,
      // Newest-wins: never retry for a call that has been superseded while the retry delay ran.
      shouldRetry: () => p.seq === this.seq && !p.abort.aborted,
      onRetry: () => { this.stats.queueRetries++; this.o.budget?.noteRetry('director'); },
    });
    p.done = true;
    p.timing = res.timing ?? null;
    this.pending.delete(p.seq);
    this.o.budget?.end('director');
    const tm = res.timing;
    if (tm && tm.usageReported && this.o.budget) {
      this.o.budget.record({ lane: 'director', prompt: tm.tokensIn, cached: tm.cachedTokens ?? 0, completion: tm.tokensOut, ok: res.status === 'ok' });
    }
    if (res.status === 'ok') this.o.budget?.noteOk('director');
    if (!p.settled) this.settle(p, res);
  }

  /** Record one real time-to-decision sample, once per call. */
  private observe(p: Pending, atMs: number, decision: boolean): void {
    if (p.recorded) return;
    p.recorded = true;
    if (decision) this.latency.record(atMs - p.startedMs);
  }

  private settle(p: Pending, res: DirectorCallResult): void {
    if (p.settled) return;
    p.settled = true;
    const arrival = this.now();
    // The stale limit must be the one that applied BEFORE this call's own latency sample: a very late
    // decision cannot extend its own allowance.
    const staleLimitS = this.staleLimitS;
    if (res.status !== 'ok' || res.parsed === undefined) {
      this.observe(p, arrival, false);
      const kind = errorKindOf(res);
      // Only a real rate limit backs the lane off. A congested shared queue is retried fast and
      // must never starve the director; by here its retries (if any) were already used or dropped.
      if (kind === 'rate_limited') { this.stats.rate429++; this.o.budget?.note429('director'); }
      else if (kind === 'queue_full') this.stats.queueFull++;
      if (res.status !== 'aborted') this.stats.errors++;
      this.o.onDiscard?.(p.seq, res.status === 'skipped' ? 'skipped' : 'error');
      return;
    }
    this.observe(p, arrival, true);
    // Newest-started wins: anything older than the newest applied result is discarded on arrival.
    if (p.seq < this.newestApplied) {
      this.stats.discarded++;
      this.o.onDiscard?.(p.seq, 'superseded');
      return;
    }
    this.newestApplied = p.seq;
    // Older in-flight calls are NOT aborted: the server still bills them, and only a completed response reports
    // real usage to the budget governor. They finish, are counted, and are discarded on arrival.
    this.apply(p, res, arrival, staleLimitS);
  }

  private apply(p: Pending, res: DirectorCallResult, arrival: number, staleLimitS: number): void {
    this.stats.applied++;
    this.o.speed?.decision();
    const fresh = this.o.fresh?.() ?? null;
    const ctx = p.ctx;
    const rate = Math.max(0.25, fresh?.playbackRate ?? ctx.playbackRate);
    const ageS = Math.max(0, ((arrival - p.startedMs) / 1000) * rate);
    const live = new Set(fresh?.liveIds ?? ctx.liveIds);
    // Re-validate against the CURRENT frame: the menu (and therefore every fact) is rebuilt on arrival.
    const menu = fresh?.menu ?? p.menu;
    const allowed = allowedNumbers(p.payload);
    const parsed = res.parsed as Partial<DirectorDecision> | undefined;
    const v: ValidateResult = validateDecision({
      decision: scrubDecision(res.parsed, allowed), menu, liveIds: live, ageS, nowS: arrival / 1000,
      onScreen: fresh ? fresh.onScreen : ctx.onScreen, calm: fresh ? fresh.calm : ctx.calm, lastShown: this.lastShown,
      staleS: staleLimitS, repeatS: this.o.repeatS ?? 9,
    });
    if (v.reason?.startsWith('schema')) this.stats.schemaInvalid++;
    if (v.reason?.startsWith('stale')) this.stats.stale++;
    if (v.ok) this.stats.accepted++; else this.stats.rejected++;
    const raw = (parsed && typeof parsed === 'object' ? parsed : {}) as Partial<DirectorDecision>;
    const entry: DirectorLogEntry = {
      at: arrival / 1000, requestT: ctx.t,
      action: v.decision?.action ?? (typeof raw.action === 'string' ? raw.action : 'invalid'),
      graphic: v.decision?.graphic ?? (typeof raw.graphic === 'string' ? raw.graphic : 'unknown'),
      ttftMs: Math.round(p.ttftMs), totalMs: Math.round(arrival - p.startedMs),
      accepted: v.ok, reason: v.reason,
      caption: v.decision?.caption ?? (typeof raw.caption === 'string' ? raw.caption.slice(0, 80) : ''),
    };
    if (v.ok && v.decision) {
      this.accepted.push({ atMs: arrival, a: v.decision.action, g: v.decision.graphic });
      while (this.accepted.length > 8) this.accepted.shift();
      if (v.decision.action === 'show' && v.decision.graphic !== 'none') this.lastShown.set(v.decision.graphic, arrival / 1000);
    }
    this.log.push(entry);
    while (this.log.length > 10) this.log.shift();
    this.o.onOutcome?.({ decision: v.decision ?? null, accepted: v.ok, reason: v.reason, timing: p.timing, log: entry, payload: p.payload }, { seq: p.seq, ageMs: arrival - p.startedMs });
  }

  /** Cancel everything in flight (seek, stop). */
  cancelAll(): void { for (const q of this.pending.values()) { q.settled = true; try { q.ac.abort(); } catch { /* ignore */ } } }

  reset(): void { this.cancelAll(); this.lastShown.clear(); this.accepted.length = 0; this.log.length = 0; this.newestApplied = this.seq; }
}
