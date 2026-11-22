// Safety governor: single in-flight per lane (cancel-and-replace or drop), token bucket (<= 90 req/min, burst 6),
// dedupe window, and 429 backoff with jitter.
import type { LLMRequest } from './providers';

export type Lane = LLMRequest['lane'];
export interface GovernorOptions {
  capPerMin?: number;        // default 90
  burst?: number;            // default 6
  dedupeMs?: number;         // default 1000
  now?: () => number;
  random?: () => number;
  backoffBaseMs?: number;    // default 500
  backoffMaxMs?: number;     // default 8000
}
export type Admission =
  | { admit: true; signal: AbortSignalLike; release: () => void; replaced: boolean }
  | { admit: false; reason: 'rate' | 'dedupe' | 'backoff' | 'busy'; retryInMs?: number };

export interface AbortSignalLike { aborted: boolean; addEventListener(t: 'abort', fn: () => void): void; removeEventListener(t: 'abort', fn: () => void): void }
interface ControllerLike { signal: AbortSignalLike; abort(): void }
const g = globalThis as unknown as { AbortController: new () => ControllerLike };

export class Governor {
  private tokens: number;
  private lastRefill: number;
  private inflight = new Map<Lane, ControllerLike>();
  private recentKeys = new Map<string, number>();
  private blockedUntil = 0;
  private consecutive429 = 0;
  private o: Required<GovernorOptions>;

  constructor(opts: GovernorOptions = {}) {
    this.o = {
      capPerMin: opts.capPerMin ?? 90, burst: opts.burst ?? 6, dedupeMs: opts.dedupeMs ?? 1000,
      now: opts.now ?? (() => Date.now()), random: opts.random ?? Math.random,
      backoffBaseMs: opts.backoffBaseMs ?? 500, backoffMaxMs: opts.backoffMaxMs ?? 8000,
    };
    this.tokens = this.o.burst;
    this.lastRefill = this.o.now();
  }

  private refill() {
    const t = this.o.now();
    this.tokens = Math.min(this.o.burst, this.tokens + ((t - this.lastRefill) / 60000) * this.o.capPerMin);
    this.lastRefill = t;
  }

  /**
   * policy 'replace': abort the lane's in-flight call and start the new one (default).
   * policy 'drop': refuse if the lane is busy.
   */
  acquire(lane: Lane, opts: { key?: string; policy?: 'replace' | 'drop' } = {}): Admission {
    const t = this.o.now();
    if (t < this.blockedUntil) return { admit: false, reason: 'backoff', retryInMs: this.blockedUntil - t };
    if (opts.key) {
      for (const [k, at] of this.recentKeys) if (t - at > this.o.dedupeMs) this.recentKeys.delete(k);
      const k = `${lane}:${opts.key}`;
      if (this.recentKeys.has(k)) return { admit: false, reason: 'dedupe' };
    }
    const cur = this.inflight.get(lane);
    if (cur && opts.policy === 'drop') return { admit: false, reason: 'busy' };
    this.refill();
    if (this.tokens < 1) return { admit: false, reason: 'rate', retryInMs: Math.ceil(((1 - this.tokens) / this.o.capPerMin) * 60000) };
    this.tokens -= 1;
    if (opts.key) this.recentKeys.set(`${lane}:${opts.key}`, t);
    let replaced = false;
    if (cur) { cur.abort(); replaced = true; }
    const ac = new g.AbortController();
    this.inflight.set(lane, ac);
    return {
      admit: true, signal: ac.signal, replaced,
      release: () => { if (this.inflight.get(lane) === ac) this.inflight.delete(lane); },
    };
  }

  inFlight(lane: Lane): boolean { return this.inflight.has(lane); }
  cancel(lane: Lane): void { this.inflight.get(lane)?.abort(); this.inflight.delete(lane); }
  cancelAll(): void { for (const l of [...this.inflight.keys()]) this.cancel(l); }

  /** Call on HTTP 429 (retryAfterMs from the header if present). Exponential backoff with jitter. */
  notify429(retryAfterMs?: number): number {
    this.consecutive429++;
    const exp = Math.min(this.o.backoffMaxMs, this.o.backoffBaseMs * 2 ** (this.consecutive429 - 1));
    const wait = Math.max(retryAfterMs ?? 0, exp * (0.5 + this.o.random() * 0.5));
    this.blockedUntil = this.o.now() + wait;
    return wait;
  }
  notifySuccess(): void { this.consecutive429 = 0; }
  get backingOff(): boolean { return this.o.now() < this.blockedUntil; }
}
