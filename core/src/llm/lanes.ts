// Lane runner: governor + client + latency tracker. Reflex (text-only, on events) and Watch (frames + tracks, ~3 s).
import type { LLMProvider } from '../types';
import { streamChat, type CallResult, type FetchLike, type LLMEvent } from './client';
import { Governor, type AbortSignalLike, type Lane } from './governor';
import { countImages, type LLMRequest } from './providers';
import { LatencyTracker, toStamp, type CallTiming } from './timing';
import type { LatencyStamp } from '../types';
import type { MockProfile } from './mock';

export type LaneOutcome =
  | { status: 'ok' | 'error' | 'aborted'; result: CallResult; stamp: LatencyStamp }
  | { status: 'skipped'; reason: 'rate' | 'dedupe' | 'backoff' | 'busy' | 'no_images' };

export interface LaneEvents {
  onTiming?: (t: CallTiming, stamp: LatencyStamp) => void;  // feeds latency stamp, pulse strip, race panel
  onEvent?: (lane: Lane, e: LLMEvent) => void;               // streaming say text, partials
}

export class LaneRunner {
  readonly tracker: LatencyTracker;
  constructor(
    public governor: Governor = new Governor(),
    private events: LaneEvents = {},
    private fetchImpl?: FetchLike,
    tracker?: LatencyTracker,
  ) { this.tracker = tracker ?? new LatencyTracker(); }

  private parallel = new Map<string, () => void>();
  setEvents(e: LaneEvents) { this.events = e; }
  cancelCall(id: string): void { this.parallel.get(id)?.(); }

  async run(
    provider: LLMProvider, request: LLMRequest,
    opts: { key?: string; policy?: 'replace' | 'drop' | 'parallel'; callId?: string; mockProfile?: MockProfile; onEvent?: (e: LLMEvent) => void } = {},
  ): Promise<LaneOutcome> {
    // Reflex is text-only by construction; frames on a provider without image support are refused.
    if (!provider.supportsImages && (request.framesSent ?? countImages(request.messages)) > 0) return { status: 'skipped', reason: 'no_images' };
    // 'parallel': pipelined lanes (director, watch) own their cadence through the BudgetGovernor; no per-lane
    // replace and no token bucket here. Each call has its own abort handle (cancelCall).
    const parallel = opts.policy === 'parallel';
    let adm: { admit: true; signal: AbortSignalLike; release: () => void } | { admit: false; reason: 'rate' | 'dedupe' | 'backoff' | 'busy' };
    if (parallel) {
      const ac = new (globalThis as unknown as { AbortController: new () => { signal: AbortSignalLike; abort(): void } }).AbortController();
      if (opts.callId) this.parallel.set(opts.callId, () => ac.abort());
      adm = { admit: true, signal: ac.signal, release: () => { if (opts.callId) this.parallel.delete(opts.callId); } };
    } else adm = this.governor.acquire(request.lane, { key: opts.key, policy: opts.policy as 'replace' | 'drop' | undefined });
    if (!adm.admit) return { status: 'skipped', reason: adm.reason };
    try {
      const result = await streamChat({
        provider, request, signal: adm.signal, fetchImpl: this.fetchImpl, mockProfile: opts.mockProfile,
        onEvent: (e) => { this.events.onEvent?.(request.lane, e); opts.onEvent?.(e); },
      });
      if (!parallel) {
        const kind = result.errorKind ?? (result.status === 429 ? 'rate_limited' : null);
        if (kind === 'rate_limited') this.governor.notify429(result.retryAfterMs);
        else if (result.ok) this.governor.notifySuccess();
      }
      const stamp = toStamp(result.timing);
      if (!result.aborted) {
        this.tracker.record(result.timing);
        this.events.onTiming?.(result.timing, stamp);
      }
      return { status: result.aborted ? 'aborted' : result.ok ? 'ok' : 'error', result, stamp };
    } finally {
      adm.release();
    }
  }
}
