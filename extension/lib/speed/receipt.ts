// Network-receipt clock mapping.
//
// The fetch stream is read in the background worker, so that is where a token's arrival time must be
// taken. Its performance.now() clock has a different zero from the page's, so every event carries
// (receipt perf time, worker timeOrigin). Shifting the worker stamps by the difference of the two
// timeOrigins puts them on the page's monotonic clock. Because start / first token / each delta / done
// all come from the same clock, TTFT and TPS are exact even if the two timeOrigins differ.
// Pure: no DOM, no network, no imports at runtime.
import type { LLMEvent } from '@tacticlens/core';

/** Stamped by the background at the point an SSE event is parsed out of the network stream. */
export interface RecvStamp {
  /** performance.now() in the worker, ms. */
  tRecv: number;
  /** performance.timeOrigin in the worker (epoch ms). */
  tOrigin: number;
}

/** Worker perf time -> page perf time. */
export function toLocalClock(t: number, stamp: Pick<RecvStamp, 'tOrigin'>, localOrigin: number): number {
  return t + stamp.tOrigin - localOrigin;
}

/** Receipt time of an event on the page clock. */
export function receiptTime(stamp: RecvStamp, localOrigin: number): number {
  return toLocalClock(stamp.tRecv, stamp, localOrigin);
}

/** Copy of the event whose absolute timestamps are on the page clock (durations are untouched). */
export function localizeEvent(e: LLMEvent, stamp: Pick<RecvStamp, 'tOrigin'>, localOrigin: number): LLMEvent {
  const shift = (t: number): number => toLocalClock(t, stamp, localOrigin);
  switch (e.type) {
    case 'start':
      return { ...e, tRequest: shift(e.tRequest) };
    case 'first_byte':
      return { ...e, tFirstByte: shift(e.tFirstByte) };
    case 'first_token':
      return { ...e, tFirstToken: shift(e.tFirstToken) };
    case 'done': {
      const t = e.result.timing;
      return {
        ...e,
        result: {
          ...e.result,
          timing: {
            ...t,
            tRequest: shift(t.tRequest),
            tFirstByte: t.tFirstByte == null ? null : shift(t.tFirstByte),
            tFirstToken: t.tFirstToken == null ? null : shift(t.tFirstToken),
            tDone: t.tDone == null ? null : shift(t.tDone),
          },
        },
      };
    }
    default:
      return e;
  }
}
