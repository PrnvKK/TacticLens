// The Theatre's one shared speed store, fed from the real LLM port. Every real streamed call
// (director, watch, ask/scout if it runs) passes through the background host, where its events are
// stamped at the network read; here they are moved onto the page clock and fed with that arrival time.
// Race events are deliberately excluded: they drive their own RaceStore.
import { setLlmEventTap } from '../llm/client';
import { feedStamped } from './feed';
import { SpeedStore } from './store';

export const theatreSpeed = new SpeedStore();

const pageOrigin = (): number => (typeof performance !== 'undefined' ? performance.timeOrigin : Date.now());

/**
 * Subscribe the store to the live LLM port. Returns the detach function.
 * `localOrigin` is injectable for tests / deterministic recordings.
 */
export function attachSpeedTap(store: SpeedStore, localOrigin: number = pageOrigin()): () => void {
  return setLlmEventTap((e, meta) => {
    if (meta.side) return;                 // the race view owns its own two lanes
    if (meta.preset === 'mock') return;    // simulated stream, not a measurement
    if (!meta.stamp) return;               // no network-receipt stamp: do not pretend
    feedStamped(store, meta.callId, e, meta.stamp, localOrigin, { lane: meta.lane, provider: meta.preset });
  });
}
