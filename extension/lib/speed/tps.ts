// TPS maths for the demo. Official Cerebras definition, per streamed call:
//   TPS = (output tokens - 1) / (t_last_token - t_first_token)
// i.e. decode speed, excluding time to first token. All timestamps are ms on one monotonic clock.
// Pure and dependency-free so it can run in the page, the background worker or a test.

/** Calls shorter than this do not count towards PEAK (2-token calls give noisy huge numbers). */
export const MIN_PEAK_TOKENS = 8;

/**
 * A streamed SSE chunk carries one or more tokens; the wire format does not say how many. Before
 * usage arrives, estimate from the text length (the same ~3.5 chars/token the packer uses). The
 * exact `completion_tokens` from usage reconciles the aggregate at the end of the call, so the
 * per-call TPS stays official and the "all calls" window is not stuck at chunks/s.
 */
const CHARS_PER_TOKEN = 3.5;
function tokensIn(text: string | undefined): number {
  return Math.max(1, Math.ceil((text?.length ?? 0) / CHARS_PER_TOKEN));
}

export function officialTps(outputTokens: number, tFirstMs: number | null, tLastMs: number | null): number {
  if (tFirstMs == null || tLastMs == null || outputTokens < 2) return 0;
  const dt = (tLastMs - tFirstMs) / 1000;
  return dt > 0 ? (outputTokens - 1) / dt : 0;
}

export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

/** One streamed call. Token count: usage.completion_tokens when reported, else the delta count. */
export class CallMeter {
  tFirst: number | null = null;
  tLast: number | null = null;
  tDone: number | null = null;
  deltaTokens = 0;
  usageTokens: number | null = null;
  constructor(readonly id: string, public tStart: number, readonly lane = '', readonly provider = '') {}
  get tokens(): number { return this.usageTokens ?? this.deltaTokens; }
  get done(): boolean { return this.tDone != null; }
  get ttftMs(): number { return this.tFirst != null ? this.tFirst - this.tStart : (this.tDone ?? this.tStart) - this.tStart; }
  get totalMs(): number { return (this.tDone ?? this.tLast ?? this.tStart) - this.tStart; }
  get tps(): number { return officialTps(this.tokens, this.tFirst, this.tLast); }
  /** `count` tokens arrived at time t (default one delta = one token). Out-of-order receipt
   *  stamps are absorbed: the first stamp only moves earlier and the last only moves later. */
  delta(t: number, count = 1): void {
    if (this.tFirst == null || t < this.tFirst) this.tFirst = t;
    this.tLast = this.tLast == null ? t : Math.max(this.tLast, t);
    this.deltaTokens += count;
  }
  setUsage(completionTokens: number): void { if (completionTokens > 0) this.usageTokens = completionTokens; }
  /** A reordered `start` can move the request stamp earlier (never later). */
  setStart(t: number): void { if (t < this.tStart) this.tStart = t; }
  /** Fallback when no deltas were seen (non-streamed or timing-only result). */
  setFirst(t: number): void { if (this.tFirst == null) this.tFirst = t; }
  finish(t: number): void {
    this.tDone = t;
    if (this.tLast == null && this.tFirst != null) this.tLast = t;
  }
}

export interface CallSummary {
  id: string; lane: string; provider: string;
  ttftMs: number; tps: number; tokens: number; totalMs: number; tDone: number;
}

export interface SpeedSnapshot {
  now: number;
  /** Big number: best live per-call TPS among active calls, else the last finished call. */
  headlineTps: number;
  /** Total output tokens/s across all concurrent calls (sliding window). */
  aggregateTps: number;
  p50Tps: number;
  peakTps: number;
  peakAggregateTps: number;
  /** TTFT of the fastest measured call (the one that set PEAK), so it is never confused with TPS. */
  peakTtftMs: number;
  /** Rolling p50 of time to first token over finished calls, ms. */
  ttftP50Ms: number;
  /** TTFT of the most recently finished call, ms. */
  lastTtftMs: number;
  decisionsPerS: number;
  decisionsTotal: number;
  tokensTotal: number;
  active: number;
  /** Newest first. */
  calls: CallSummary[];
  /** Aggregate tokens/s samples, oldest first. */
  history: number[];
}

export interface TrackerOptions {
  aggregateWindowMs?: number;
  decisionWindowMs?: number;
  p50Calls?: number;
  keepCalls?: number;
  historyLen?: number;
}

export class SpeedTracker {
  private active = new Map<string, CallMeter>();
  private finished: CallSummary[] = [];
  /** Token arrivals for the aggregate window. `n` starts as an estimate and is scaled to usage. */
  private arrivals: { t: number; n: number; id: string }[] = [];
  private hist: number[] = [];
  private peak = 0;
  private peakTtft = 0;
  private peakAgg = 0;
  private tokensDone = 0;
  private decisions = 0;
  private lastTps = 0;
  private o: Required<TrackerOptions>;
  constructor(opts: TrackerOptions = {}) {
    this.o = { aggregateWindowMs: 1000, decisionWindowMs: 4000, p50Calls: 50, keepCalls: 200, historyLen: 120, ...opts };
  }

  begin(id: string, t: number, lane = '', provider = ''): CallMeter {
    const m = new CallMeter(id, t, lane, provider);
    this.active.set(id, m);
    return m;
  }
  meter(id: string): CallMeter | undefined { return this.active.get(id); }
  delta(id: string, t: number, count = 1): void {
    const m = this.active.get(id);
    if (!m) return;
    m.delta(t, count);
    this.arrivals.push({ t, n: count, id });
    if (m.tokens >= MIN_PEAK_TOKENS && m.tps > this.peak) { this.peak = m.tps; this.peakTtft = m.ttftMs; }
  }
  usage(id: string, completionTokens: number): void {
    const m = this.active.get(id);
    if (!m) return;
    m.setUsage(completionTokens);
    this.reconcile(id, completionTokens, m.deltaTokens);
  }
  /**
   * Scale this call's estimated arrivals to the exact completion_tokens from usage. Chunks carry
   * several tokens each, so counting one per chunk under-reported the all-calls rate by 2-4x.
   * Scale by the call's full estimate, not just the entries still in the 4 s window, so a long
   * call does not dump all of its tokens into the last window.
   */
  private reconcile(id: string, actual: number, estimatedTotal: number): void {
    if (!(actual > 0) || !(estimatedTotal > 0)) return;
    const scale = actual / estimatedTotal;
    if (Math.abs(scale - 1) < 0.05) return;
    for (const a of this.arrivals) if (a.id === id) a.n = Math.max(1, a.n * scale);
  }
  end(id: string, t: number): CallSummary | null {
    const m = this.active.get(id);
    if (!m) return null;
    m.finish(t);
    this.active.delete(id);
    const s: CallSummary = { id, lane: m.lane, provider: m.provider, ttftMs: m.ttftMs, tps: m.tps, tokens: m.tokens, totalMs: m.totalMs, tDone: t };
    this.finished.push(s);
    if (this.finished.length > this.o.keepCalls) this.finished.shift();
    this.tokensDone += m.tokens;
    this.decisions++;
    if (s.tps > 0) this.lastTps = s.tps;
    if (m.tokens >= MIN_PEAK_TOKENS && s.tps > this.peak) { this.peak = s.tps; this.peakTtft = s.ttftMs; }
    return s;
  }
  /** A failed or aborted call: forget it without counting a decision. */
  drop(id: string): void { this.active.delete(id); }

  aggregateTps(now: number): number {
    const w = this.o.aggregateWindowMs;
    const cut = now - w;
    let i = 0;
    while (i < this.arrivals.length && this.arrivals[i]!.t < cut - 4000) i++;
    if (i) this.arrivals.splice(0, i);
    let n = 0;
    for (const a of this.arrivals) if (a.t > cut && a.t <= now) n += a.n;
    return (n * 1000) / w;
  }
  /** Call at a steady cadence (~100 ms) to feed the sparkline and the aggregate peak. */
  sample(now: number): number {
    const a = this.aggregateTps(now);
    this.peakAgg = Math.max(this.peakAgg, a);
    this.hist.push(a);
    if (this.hist.length > this.o.historyLen) this.hist.shift();
    return a;
  }
  snapshot(now: number): SpeedSnapshot {
    let live = 0;
    for (const m of this.active.values()) if (m.tokens >= 3) live = Math.max(live, m.tps);
    const tail = this.finished.slice(-this.o.p50Calls);
    const recent = tail.map((c) => c.tps).filter((v) => v > 0);
    const ttfts = tail.map((c) => c.ttftMs).filter((v) => v > 0);
    const dw = this.o.decisionWindowMs;
    const inWin = this.finished.filter((c) => c.tDone > now - dw && c.tDone <= now).length;
    return {
      now,
      headlineTps: live || this.lastTps,
      aggregateTps: this.aggregateTps(now),
      p50Tps: percentile(recent, 50),
      peakTps: this.peak,
      peakAggregateTps: this.peakAgg,
      peakTtftMs: this.peakTtft,
      ttftP50Ms: percentile(ttfts, 50),
      lastTtftMs: this.finished.length ? this.finished[this.finished.length - 1]!.ttftMs : 0,
      decisionsPerS: (inWin * 1000) / dw,
      decisionsTotal: this.decisions,
      tokensTotal: this.tokensDone + [...this.active.values()].reduce((a, m) => a + m.tokens, 0),
      active: this.active.size,
      calls: this.finished.slice().reverse(),
      history: this.hist.slice(),
    };
  }
  reset(): void {
    this.active.clear(); this.finished = []; this.arrivals = []; this.hist = [];
    this.peak = 0; this.peakTtft = 0; this.peakAgg = 0; this.tokensDone = 0; this.decisions = 0; this.lastTps = 0;
  }
}

type DoneTiming = { tFirstToken: number | null; tDone: number | null; tokensOut: number; usageReported: boolean; lane?: string; provider?: string };

/** Structural subset of core's LLMEvent, so this file needs no import from core. */
export type TimingEvent =
  | { type: 'start'; tRequest: number }
  | { type: 'first_token'; tFirstToken: number; ttftMs?: number }
  | { type: 'delta'; text?: string }
  /** Hidden reasoning tokens: they are part of usage.completion_tokens, so they must count and,
   *  above all, place the first/last token times for the official decode window. */
  | { type: 'reasoning'; text?: string }
  | { type: 'done'; result: { timing: DoneTiming } }
  | { type: 'error' };

/**
 * Feed one LLM stream event into the tracker. `now` must be the time the event ARRIVED, on the
 * same clock as the start/first_token stamps (performance.now()). One delta counts as one token.
 * A late/reordered `start` never discards tokens already counted for the call.
 */
export function feedLLMEvent(tr: SpeedTracker, callId: string, e: TimingEvent | { type: string }, now: number, meta: { lane?: string; provider?: string } = {}): void {
  const ev = e as { type: string; tRequest?: number; result?: { timing: DoneTiming } };
  switch (ev.type) {
    case 'start': {
      const m = tr.meter(callId);
      if (m) m.setStart(ev.tRequest ?? now);
      else tr.begin(callId, ev.tRequest ?? now, meta.lane, meta.provider);
      break;
    }
    case 'delta':
    case 'reasoning': {
      if (!tr.meter(callId)) tr.begin(callId, now, meta.lane, meta.provider);
      tr.delta(callId, now, tokensIn((ev as { text?: string }).text));
      break;
    }
    case 'done': {
      const t = ev.result?.timing;
      if (!tr.meter(callId)) tr.begin(callId, now, meta.lane ?? t?.lane, meta.provider ?? t?.provider);
      const m = tr.meter(callId)!;
      if (t?.usageReported) tr.usage(callId, t.tokensOut);
      if (m.tFirst == null && t?.tFirstToken != null) m.setFirst(t.tFirstToken);
      tr.end(callId, t?.tDone ?? now);
      break;
    }
    case 'error': tr.drop(callId); break;
    default: break;
  }
}
