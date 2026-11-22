// Watch lane (vision model): one annotated frame per second (rate set by the budget governor). Its answer becomes a
// compact "what the frame shows" line in the director's delta tail, so the director never waits for it.
import type { LLMEvent } from '../llm/client';
import type { LLMRequest } from '../llm/providers';
import type { CallTiming } from '../llm/timing';
import { PromptBuilder } from '../llm/cache/builder';
import type { MatchBlock } from '../llm/cache/spec';
import { BudgetGovernor, SpeedMeter } from '../llm/budget';
import { withQueueRetry } from '../llm/retry';
import { looksQueueFull } from '../llm/errors';
import { WATCH_MAX_TOKENS, WATCH_SCHEMA, WATCH_SCHEMA_NAME, type WatchObservation } from './kimiPrompt';
import type { DirectorCallResult } from './director';

export type WatchCaller = (request: LLMRequest, onEvent: (e: LLMEvent) => void) => Promise<DirectorCallResult>;

export interface WatchOptions {
  builder: PromptBuilder;
  budget?: BudgetGovernor;
  speed?: SpeedMeter;
  match?: () => MatchBlock | null;
  now?: () => number;
  /** An observation older than this stops feeding the director (default 5 s). */
  maxAgeMs?: number;
  /** queue_full retry policy (same shared schedule as the director by default). */
  queueRetry?: { maxRetries?: number; sleep?: (ms: number) => Promise<void>; random?: () => number };
}

export function isWatchObservation(x: unknown): x is WatchObservation {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.phase === 'string' && typeof o.shape === 'string' && Array.isArray(o.hot) && typeof o.ball_side === 'string' && typeof o.pressure === 'string';
}

/** The compact observation that goes into the director delta. No digits other than ids. */
export function compactObservation(o: WatchObservation, liveIds?: ReadonlySet<number>): string {
  const hot = o.hot.filter((i) => Number.isInteger(i) && (!liveIds || liveIds.has(i))).slice(0, 4);
  const shape = o.shape.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return `${o.phase}; ${shape}; ball ${o.ball_side}; pressure ${o.pressure}${hot.length ? `; hot ${hot.map((i) => `[[${i}]]`).join(' ')}` : ''}`;
}

export class WatchLane {
  private busy = false;
  private last: { at: number; obs: WatchObservation } | null = null;
  private now: () => number;
  stats = { launched: 0, ok: 0, invalid: 0, errors: 0, queueFull: 0, queueRetries: 0 };

  constructor(private call: WatchCaller, private o: WatchOptions) { this.now = o.now ?? (() => Date.now()); }

  get observation(): WatchObservation | null { return this.last?.obs ?? null; }

  /** The line the director sees, or null when there is no fresh observation. */
  seen(liveIds?: ReadonlySet<number>): string | null {
    if (!this.last || this.now() - this.last.at > (this.o.maxAgeMs ?? 5000)) return null;
    return compactObservation(this.last.obs, liveIds);
  }

  /** `frame` is a base64 JPEG data URL (768x432 by default). Returns false when the budget or in-flight cap says no. */
  async tick(frame: string, live: { t: number; ids: number[] }): Promise<boolean> {
    if (this.busy) return false;
    const b = this.o.budget;
    if (b && !b.tryLaunch('watch')) return false;
    this.busy = true;
    b?.begin('watch');
    this.stats.launched++;
    try {
      const built = this.o.builder.build({ lane: 'watch', match: this.o.match?.() ?? null, image: frame, tail: { t: live.t, live: live.ids.slice().sort((x, y) => x - y) } });
      const request: LLMRequest = {
        lane: 'watch', framesSent: 1, schema: { name: WATCH_SCHEMA_NAME, schema: WATCH_SCHEMA },
        maxCompletionTokens: WATCH_MAX_TOKENS, reasoningEffort: 'low', messages: built.messages,
      };
      let tm: CallTiming | undefined;
      let res: DirectorCallResult;
      const callOnce = async (): Promise<DirectorCallResult> => {
        try { return await this.call(request, () => undefined); } catch (err) { return { status: 'error', error: String((err as Error)?.message ?? err), errorKind: 'network' }; }
      };
      res = await withQueueRetry(callOnce, (r) => (r.status !== 'ok' && r.errorKind === 'queue_full'
        ? { kind: 'queue_full', ...(r.errorCode ? { code: r.errorCode } : {}), ...(r.errorMessage ? { message: r.errorMessage } : {}) }
        : null), {
        ...this.o.queueRetry,
        meter: this.o.speed?.queue,
        onRetry: () => { this.stats.queueRetries++; b?.noteRetry('watch'); },
      });
      tm = res.timing;
      if (tm && tm.usageReported) b?.record({ lane: 'watch', prompt: tm.tokensIn, cached: tm.cachedTokens ?? 0, completion: tm.tokensOut, ok: res.status === 'ok' });
      if (res.status === 'ok') b?.noteOk('watch');
      if (res.status === 'ok' && isWatchObservation(res.parsed)) { this.last = { at: this.now(), obs: res.parsed }; this.stats.ok++; }
      else if (res.status === 'ok') this.stats.invalid++;
      else {
        this.stats.errors++;
        const kind = res.errorKind
          ?? (looksQueueFull(res.error) ? 'queue_full' : res.error && /HTTP 429/.test(res.error) ? 'rate_limited' : null);
        if (kind === 'rate_limited') b?.note429('watch');
        else if (kind === 'queue_full') this.stats.queueFull++;
      }
      return true;
    } finally {
      this.busy = false;
      b?.end('watch');
    }
  }
}
