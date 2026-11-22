// One place that turns a worker-stamped stream event into a store feed on the page clock.
// Pure (no DOM/browser imports) so the exact wiring used by the Theatre can be unit-tested.
import type { LLMEvent } from '@tacticlens/core';
import { localizeEvent, receiptTime, type RecvStamp } from './receipt';
import type { SpeedStore } from './store';

export interface FeedMeta { lane?: string; provider?: string }

export function feedStamped(
  store: SpeedStore, callId: string, e: LLMEvent, stamp: RecvStamp, localOrigin: number, meta: FeedMeta = {},
): void {
  store.feed(callId, localizeEvent(e, stamp, localOrigin), meta, receiptTime(stamp, localOrigin));
}
