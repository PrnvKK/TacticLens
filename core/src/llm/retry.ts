// queue_full retry policy shared by the director, the watch lane, the live-LLM tools and the bridge.
// A queue refusal is not our rate limit: retry the SAME request after a short jittered delay instead
// of backing the lane off. Real 429s still go through the normal governor backoff path.
import type { LLMErrorInfo } from './errors';

/** jittered delay windows after queue-full refusal #1, #2, #3 */
export const QUEUE_RETRY_DELAYS_MS = [[100, 300], [300, 600], [600, 1200]] as const;
/** One initial attempt plus up to three retries. */
export const QUEUE_MAX_RETRIES = QUEUE_RETRY_DELAYS_MS.length;

export function queueRetryDelayMs(retry: number, random: () => number = Math.random): number {
  const band = QUEUE_RETRY_DELAYS_MS[retry - 1];
  if (!band) return 0;
  const [lo, hi] = band;
  return Math.round(lo + Math.min(1, Math.max(0, random())) * (hi - lo));
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const t = (globalThis as unknown as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout;
  if (t) t(() => resolve(), ms); else resolve();
});

export type RefusalKind = 'queue_full' | 'rate_limited';

/**
 * Rolling queue statistics for the speed meter and the tool reports. The congestion figure is the
 * queue_full share of the last `capacity` attempts (all calls, not just refusals).
 */
export class QueueRetryMeter {
  queueFull = 0;
  rateLimited = 0;
  retries = 0;
  retrySuccess = 0;
  retriesDropped = 0;
  private recent: ('queue_full' | 'rate_limited' | 'ok')[] = [];

  constructor(private capacity = 20) {}

  /** One finished HTTP attempt: a refusal kind, or null when the attempt was not a 429. */
  noteAttempt(kind: RefusalKind | null): void {
    if (kind === 'queue_full') this.queueFull++;
    else if (kind === 'rate_limited') this.rateLimited++;
    this.recent.push(kind ?? 'ok');
    while (this.recent.length > this.capacity) this.recent.shift();
  }

  /** A retry is about to be sent. */
  noteRetry(): void { this.retries++; }
  /** The retry's own outcome (success or another failure). */
  noteRetryResult(ok: boolean): void { if (ok) this.retrySuccess++; }
  /** A retry was due but the caller's newest-wins gate dropped it. */
  noteDroppedRetry(): void { this.retriesDropped++; }

  congestionPct(): number {
    if (!this.recent.length) return 0;
    let q = 0;
    for (const k of this.recent) if (k === 'queue_full') q++;
    return Math.round((q / this.recent.length) * 100);
  }
  retrySuccessPct(): number { return this.retries ? Math.round((this.retrySuccess / this.retries) * 100) : 0; }
  congested(): boolean { return this.congestionPct() > 50; }
}

export interface QueueRetryOptions {
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Optional newest-wins gate, checked when a retry is due. False drops the retry. */
  shouldRetry?: (info: LLMErrorInfo, retry: number) => boolean;
  meter?: QueueRetryMeter;
  onRetry?: (info: LLMErrorInfo, retry: number, delayMs: number) => void;
}

/**
 * Run one request and retry only queue_full refusals. Any other result (ok, rate_limited, server,
 * client, network) is returned immediately. Callers keep their own lane backoff for rate_limited.
 */
export async function withQueueRetry<T>(
  run: () => Promise<T>,
  classify: (result: T) => LLMErrorInfo | null,
  opts: QueueRetryOptions = {},
): Promise<T> {
  const max = opts.maxRetries ?? QUEUE_MAX_RETRIES;
  const sleep = opts.sleep ?? defaultSleep;
  for (let retry = 0; ; retry++) {
    const result = await run();
    const info = classify(result);
    const kind: RefusalKind | null = info?.kind === 'queue_full' || info?.kind === 'rate_limited' ? info.kind : null;
    opts.meter?.noteAttempt(kind);
    if (!info) {
      if (retry > 0) opts.meter?.noteRetryResult(true);
      return result;
    }
    if (retry > 0) opts.meter?.noteRetryResult(false);
    if (info.kind !== 'queue_full' || retry >= max) return result;
    if (opts.shouldRetry && !opts.shouldRetry(info, retry + 1)) {
      opts.meter?.noteDroppedRetry();
      return result;
    }
    const delay = queueRetryDelayMs(retry + 1, opts.random);
    await sleep(delay);
    // Re-check after the delay: the world may have moved (a newer director call started).
    if (opts.shouldRetry && !opts.shouldRetry(info, retry + 1)) {
      opts.meter?.noteDroppedRetry();
      return result;
    }
    opts.meter?.noteRetry();
    opts.onRetry?.(info, retry + 1, delay);
  }
}
