// Budget governor: a rolling 60 s window of requests and tokens, all from the REAL usage of each response.
// It decides how often each lane may launch (the degrade ladder), with hysteresis, and backs a lane off with
// jitter on HTTP 429. It never queues: a launch is either allowed now or refused.
//
// It also owns the hard ceilings the adaptive director must not cross: a launch is refused when the next
// request would exceed 85% of the 1,000 requests/min limit or when the real uncached usage plus the calls
// already in flight would exceed 85% of the 50k uncached tokens/min limit.
import { percentile } from './timing';
import { QueueRetryMeter } from './retry';

export type BudgetLane = 'director' | 'watch' | 'analyst';

export interface BudgetLimits { uncachedPerMin: number; totalPerMin: number; requestsPerMin: number }
/** Cerebras limits for the Kimi trial key (admin update 2026-11-21): 50k uncached tokens/min, 500k total tokens/min, 1000 requests/min, 10 images/request. */
export const CEREBRAS_LIMITS: BudgetLimits = { uncachedPerMin: 50_000, totalPerMin: 500_000, requestsPerMin: 1000 };

/** Conservative per-call uncached token estimate before the first real usage sample of a lane. */
const DEFAULT_UNCACHED: Record<BudgetLane, number> = { director: 800, watch: 900, analyst: 800 };

export interface BudgetOptions {
  limits?: BudgetLimits;
  /** Fraction of each limit we aim to stay under (default 0.85: the documented hard ceiling, leaving 15% headroom). */
  targetFrac?: number;
  /** Fraction of the target below which the ladder may step back down (default 0.7). */
  recoverFrac?: number;
  baseDirectorHz?: number;     // default 1
  baseWatchHz?: number;        // default 0.4 (one annotated frame per 2.5 s)
  windowMs?: number;           // default 60000
  upDwellMs?: number;          // min time between steps up, default 4000
  downDwellMs?: number;        // min time between steps down, default 10000
  now?: () => number;
  random?: () => number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface UsageSample { lane: BudgetLane; prompt: number; cached: number; completion: number; ok?: boolean }
interface Rec extends UsageSample { at: number }

export const LADDER_NAMES = [
  'full', 'watch 1/2 rate', 'watch 1/4 rate', 'watch off', 'director 2/3 rate', 'director 1/3 rate', 'analyst off',
] as const;
export const MAX_LEVEL = LADDER_NAMES.length - 1;

export interface Rates {
  level: number;
  levelName: string;
  /** null = the watch lane is off. */
  watchIntervalMs: number | null;
  directorIntervalMs: number;
  analystEnabled: boolean;
}

export interface BudgetSnapshot {
  level: number;
  levelName: string;
  requestsPerMin: number;
  /** prompt - cached + completion over the last minute: the number compared with the 100k limit. */
  uncachedPerMin: number;
  /** prompt - cached only, kept alongside. */
  uncachedPromptPerMin: number;
  completionPerMin: number;
  totalPerMin: number;
  cachedPct: number;
  limits: BudgetLimits;
  targets: BudgetLimits;
  inFlight: number;
  backoffMs: Record<BudgetLane, number>;
  errors429: number;
}

const LANES: BudgetLane[] = ['director', 'watch', 'analyst'];
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export class BudgetGovernor {
  private recs: Rec[] = [];
  private launches: number[] = [];
  private level = 0;
  private lastChangeAt = -Infinity;
  private lastLaunch: Record<BudgetLane, number> = { director: -Infinity, watch: -Infinity, analyst: -Infinity };
  private blockedUntil: Record<BudgetLane, number> = { director: 0, watch: 0, analyst: 0 };
  private consecutive429: Record<BudgetLane, number> = { director: 0, watch: 0, analyst: 0 };
  private inflight: Record<BudgetLane, number> = { director: 0, watch: 0, analyst: 0 };
  private n429 = 0;
  private o: Required<BudgetOptions>;

  constructor(opts: BudgetOptions = {}) {
    this.o = {
      limits: opts.limits ?? CEREBRAS_LIMITS, targetFrac: opts.targetFrac ?? 0.85, recoverFrac: opts.recoverFrac ?? 0.7,
      baseDirectorHz: opts.baseDirectorHz ?? 1, baseWatchHz: opts.baseWatchHz ?? 0.4, windowMs: opts.windowMs ?? 60_000,
      upDwellMs: opts.upDwellMs ?? 4000, downDwellMs: opts.downDwellMs ?? 10_000,
      now: opts.now ?? (() => Date.now()), random: opts.random ?? Math.random,
      backoffBaseMs: opts.backoffBaseMs ?? 500, backoffMaxMs: opts.backoffMaxMs ?? 8000,
    };
  }

  private prune(t: number): void {
    const cut = t - this.o.windowMs;
    let i = 0;
    while (i < this.recs.length && this.recs[i]!.at < cut) i++;
    if (i) this.recs.splice(0, i);
  }

  private pruneLaunches(t: number): void {
    const cut = t - this.o.windowMs;
    let i = 0;
    while (i < this.launches.length && this.launches[i]! < cut) i++;
    if (i) this.launches.splice(0, i);
  }

  /** Record the usage of one finished response (real numbers from the API). */
  record(u: UsageSample): void {
    const t = this.o.now();
    this.recs.push({ ...u, at: t });
    this.prune(t);
    this.evaluate();
  }

  targets(): BudgetLimits {
    const f = this.o.targetFrac, l = this.o.limits;
    return { uncachedPerMin: l.uncachedPerMin * f, totalPerMin: l.totalPerMin * f, requestsPerMin: l.requestsPerMin * f };
  }

  /** Rolling sums scaled to a per-minute figure; `spanMs` < the full span gives a short-term projection. */
  private sums(spanMs: number): { req: number; unc: number; uncPrompt: number; comp: number; total: number; prompt: number; cached: number } {
    const t = this.o.now();
    this.prune(t);
    const from = t - spanMs;
    const k = 60_000 / spanMs;
    let req = 0, uncPrompt = 0, comp = 0, prompt = 0, cached = 0;
    for (const r of this.recs) {
      if (r.at < from) continue;
      req++; prompt += r.prompt; cached += r.cached; comp += r.completion;
      uncPrompt += Math.max(0, r.prompt - r.cached);
    }
    return { req: req * k, unc: (uncPrompt + comp) * k, uncPrompt: uncPrompt * k, comp: comp * k, total: (prompt + comp) * k, prompt: prompt * k, cached: cached * k };
  }

  private util(spanMs: number): number {
    const s = this.sums(spanMs), g = this.targets();
    return Math.max(s.unc / g.uncachedPerMin, s.total / g.totalPerMin, s.req / g.requestsPerMin);
  }

  /** Step the ladder: up when the 60 s span is over target and the last 10 s confirm it; down only when both are well under. */
  evaluate(): number {
    const t = this.o.now();
    const win = this.util(this.o.windowMs);
    const recent = this.util(Math.min(10_000, this.o.windowMs));
    if (win > 1 && recent > 0.95 && this.level < MAX_LEVEL && t - this.lastChangeAt >= this.o.upDwellMs) {
      this.level++; this.lastChangeAt = t;
    } else if (win < this.o.recoverFrac && recent < this.o.recoverFrac && this.level > 0 && t - this.lastChangeAt >= this.o.downDwellMs) {
      this.level--; this.lastChangeAt = t;
    }
    return this.level;
  }

  rates(): Rates {
    const L = this.level;
    const dirHz = this.o.baseDirectorHz * (L >= 5 ? 1 / 3 : L >= 4 ? 2 / 3 : 1);
    const watchBase = 1000 / this.o.baseWatchHz;
    const watchIntervalMs = L >= 3 ? null : watchBase * (L === 2 ? 4 : L === 1 ? 2 : 1);
    return { level: L, levelName: LADDER_NAMES[L]!, watchIntervalMs, directorIntervalMs: 1000 / dirHz, analystEnabled: L < 6 };
  }

  get currentLevel(): number { return this.level; }

  /** Rolling average of REAL uncached tokens per finished response on a lane. */
  avgUncached(lane: BudgetLane): number {
    const t = this.o.now();
    this.prune(t);
    const from = t - this.o.windowMs;
    let n = 0, sum = 0;
    for (const r of this.recs) {
      if (r.at < from || r.lane !== lane) continue;
      sum += Math.max(0, r.prompt - r.cached) + r.completion;
      n++;
    }
    return n ? sum / n : DEFAULT_UNCACHED[lane];
  }

  /**
   * How many concurrent director calls the uncached-token and request targets allow at a p50 time-to-
   * decision of `p50Ms`. With 8 in flight at high latency this stays inside 85k uncached/min and 850
   * req/min; at low latency it prevents the faster cadence from blowing the same ceilings.
   */
  concurrencyLimit(lane: BudgetLane, p50Ms: number, cap = 8): number {
    const p50 = Math.max(1, p50Ms);
    const avg = Math.max(1, this.avgUncached(lane));
    const g = this.targets();
    const byTokens = Math.floor((g.uncachedPerMin * p50) / (60_000 * avg));
    const byRequests = Math.floor((g.requestsPerMin * p50) / 60_000);
    return clamp(Math.min(cap, byTokens, byRequests), 1, cap);
  }

  /** Honest 429 handling: back this lane off with jitter. Returns the wait. Nothing is queued. */
  note429(lane: BudgetLane, retryAfterMs?: number): number {
    this.n429++;
    const n = ++this.consecutive429[lane];
    const exp = Math.min(this.o.backoffMaxMs, this.o.backoffBaseMs * 2 ** (n - 1));
    const wait = Math.max(retryAfterMs ?? 0, exp * (0.5 + this.o.random() * 0.5));
    this.blockedUntil[lane] = this.o.now() + wait;
    return wait;
  }
  /**
   * A queue_full retry of an already-admitted call. It counts as a request in the rolling 60 s span
   * (the API saw it) but never touches the lane backoff: the shared queue is not our rate limit.
   */
  noteRetry(_lane: BudgetLane): void {
    const t = this.o.now();
    this.pruneLaunches(t);
    this.launches.push(t);
  }
  noteOk(lane: BudgetLane): void { this.consecutive429[lane] = 0; }
  backoffLeftMs(lane: BudgetLane): number { return Math.max(0, this.blockedUntil[lane] - this.o.now()); }

  /**
   * Ask to launch one call on `lane` now. Refused (never queued) while backing off, when the ladder says
   * the lane is too fast, or when the next request would cross the hard request/uncached ceilings.
   * Event-triggered reactions skip the ladder cadence but still respect a 429 backoff and the hard ceilings.
   */
  tryLaunch(lane: BudgetLane, opts: { event?: boolean } = {}): boolean {
    const t = this.o.now();
    if (t < this.blockedUntil[lane]) return false;
    if (!opts.event) {
      const r = this.rates();
      const interval = lane === 'director' ? r.directorIntervalMs : lane === 'watch' ? r.watchIntervalMs : r.analystEnabled ? 0 : null;
      if (interval === null) return false;
      if (t - this.lastLaunch[lane] < interval) return false;
    }
    // Hard ceilings, including the calls already in flight (their usage has not been recorded yet).
    this.prune(t);
    this.pruneLaunches(t);
    const g = this.targets();
    if (this.launches.length + 1 > g.requestsPerMin) return false;
    const s = this.sums(this.o.windowMs);
    const projected = s.unc + Math.max(1, this.avgUncached(lane)) * (this.inFlight() + 1);
    if (projected > g.uncachedPerMin) return false;
    this.lastLaunch[lane] = t;
    this.launches.push(t);
    return true;
  }

  begin(lane: BudgetLane): void { this.inflight[lane]++; }
  end(lane: BudgetLane): void { this.inflight[lane] = Math.max(0, this.inflight[lane] - 1); }
  inFlight(lane?: BudgetLane): number { return lane ? this.inflight[lane] : LANES.reduce((a, l) => a + this.inflight[l], 0); }

  snapshot(): BudgetSnapshot {
    const s = this.sums(this.o.windowMs);
    const r = this.rates();
    return {
      level: r.level, levelName: r.levelName,
      requestsPerMin: Math.round(s.req), uncachedPerMin: Math.round(s.unc), uncachedPromptPerMin: Math.round(s.uncPrompt),
      completionPerMin: Math.round(s.comp), totalPerMin: Math.round(s.total),
      cachedPct: s.prompt > 0 ? Math.round((s.cached / s.prompt) * 100) : 0,
      limits: this.o.limits, targets: this.targets(), inFlight: this.inFlight(),
      backoffMs: { director: this.backoffLeftMs('director'), watch: this.backoffLeftMs('watch'), analyst: this.backoffLeftMs('analyst') },
      errors429: this.n429,
    };
  }
}

/** Rolling decision rate and time-to-first-token for the on-screen counter. */
export class SpeedMeter {
  /** queue_full vs rate_limited attempts over the last 20 calls, shared by director and watch. */
  readonly queue = new QueueRetryMeter();
  private decisions: number[] = [];
  private ttfts: { at: number; ms: number }[] = [];
  private lastDecisionAt: number | null = null;
  constructor(private now: () => number = () => Date.now(), private rateWindowMs = 5000, private ttftWindowMs = 30_000) {}

  /** One fresh decision was applied (newest-wins accepted it; accepted or rejected by the validator). */
  decision(): void { const t = this.now(); this.decisions.push(t); this.lastDecisionAt = t; this.trim(); }
  ttft(ms: number): void { this.ttfts.push({ at: this.now(), ms }); this.trim(); }

  private trim(): void {
    const t = this.now();
    while (this.decisions.length && this.decisions[0]! < t - this.rateWindowMs) this.decisions.shift();
    while (this.ttfts.length && this.ttfts[0]!.at < t - this.ttftWindowMs) this.ttfts.shift();
  }

  decisionsPerS(): number { this.trim(); return Math.round((this.decisions.length / (this.rateWindowMs / 1000)) * 10) / 10; }
  ttftP50(): number { this.trim(); return Math.round(percentile(this.ttfts.map((x) => x.ms), 50)); }
  ttftP95(): number { this.trim(); return Math.round(percentile(this.ttfts.map((x) => x.ms), 95)); }
  lastTtftMs(): number { this.trim(); return this.ttfts.length ? Math.round(this.ttfts[this.ttfts.length - 1]!.ms) : 0; }
  sinceDecisionMs(): number | null { return this.lastDecisionAt === null ? null : Math.max(0, this.now() - this.lastDecisionAt); }

  /** HUD state: a congested shared queue, no fresh decision for >2 s, a slow last TTFT, or live. */
  kimiState(): 'live' | 'thinking' | 'slow' | 'congested' {
    if (this.queue.congested()) return 'congested';
    const since = this.sinceDecisionMs();
    if (since === null || since > 2000) return 'thinking';
    return this.lastTtftMs() > 3000 ? 'slow' : 'live';
  }
}

export interface KimiSpeedSnapshot {
  decisionsPerS: number;
  ttftP50: number;
  cachedPct: number;
  level: number;
  levelName: string;
  requestsPerMin: number;
  uncachedPerMin: number;
  uncachedLimit: number;
  totalPerMin: number;
  inFlight: number;
  watchFps: number;
  /** HUD state: Kimi is congested (shared queue >50%), live, thinking (>2 s without a decision) or slow (last TTFT >3 s). */
  kimiState: 'live' | 'thinking' | 'slow' | 'congested';
  lastTtftMs: number;
  sinceDecisionMs: number | null;
  /** Shared-queue statistics over the last 20 attempts (data for ?perf=1). */
  queueFull: number;
  rateLimited: number;
  queueCongestionPct: number;
  retrySuccessPct: number;
  /** Adaptive director settings exposed in the ?perf=1 detail. */
  staleLimitS: number;
  intervalMs: number;
  maxInFlight: number;
  directorInFlight: number;
  /** Configuration error for the HUD (for example "Set CEREBRAS_KIMI_MODEL"). */
  error?: string;
}

export interface SpeedPipelineInfo {
  staleLimitS: number;
  intervalMs: number;
  maxInFlight: number;
  directorInFlight: number;
  error?: string;
}

export function speedSnapshot(b: BudgetGovernor, m: SpeedMeter, pipeline?: Partial<SpeedPipelineInfo>): KimiSpeedSnapshot {
  const s = b.snapshot();
  const r = b.rates();
  return {
    decisionsPerS: m.decisionsPerS(), ttftP50: m.ttftP50(), cachedPct: s.cachedPct, level: s.level, levelName: s.levelName,
    requestsPerMin: s.requestsPerMin, uncachedPerMin: s.uncachedPerMin, uncachedLimit: s.limits.uncachedPerMin,
    totalPerMin: s.totalPerMin, inFlight: s.inFlight, watchFps: r.watchIntervalMs ? Math.round((1000 / r.watchIntervalMs) * 100) / 100 : 0,
    kimiState: m.kimiState(), lastTtftMs: m.lastTtftMs(), sinceDecisionMs: m.sinceDecisionMs(),
    queueFull: m.queue.queueFull, rateLimited: m.queue.rateLimited,
    queueCongestionPct: m.queue.congestionPct(), retrySuccessPct: m.queue.retrySuccessPct(),
    staleLimitS: pipeline?.staleLimitS ?? 3,
    intervalMs: pipeline?.intervalMs ?? Math.round(r.directorIntervalMs),
    maxInFlight: pipeline?.maxInFlight ?? 0,
    directorInFlight: pipeline?.directorInFlight ?? 0,
    ...(pipeline?.error ? { error: pipeline.error } : {}),
  };
}
