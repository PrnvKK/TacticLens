// Race harness: identical request to two providers at the same moment; both timings reported.
import type { LLMProvider } from '../types';
import { streamChat, type CallResult, type FetchLike, type LLMEvent } from './client';
import type { LLMRequest } from './providers';
import type { MockProfile } from './mock';

export interface RaceSide { provider: LLMProvider; fetchImpl?: FetchLike; mockProfile?: MockProfile }
export interface RaceResult {
  a: CallResult; b: CallResult;
  firstTokenWinner: 'a' | 'b' | 'tie' | 'none';
  ttftDeltaMs: number | null;      // b.ttft - a.ttft
  totalDeltaMs: number;            // b.total - a.total
}

export async function race(
  a: RaceSide, b: RaceSide, request: LLMRequest,
  opts: { onEvent?: (side: 'a' | 'b', e: LLMEvent) => void; signal?: Parameters<typeof streamChat>[0]['signal'] } = {},
): Promise<RaceResult> {
  // Both are started synchronously in the same tick with the same request object (identical body).
  const pa = streamChat({ provider: a.provider, request, fetchImpl: a.fetchImpl, mockProfile: a.mockProfile, signal: opts.signal, onEvent: (e) => opts.onEvent?.('a', e) });
  const pb = streamChat({ provider: b.provider, request, fetchImpl: b.fetchImpl, mockProfile: b.mockProfile, signal: opts.signal, onEvent: (e) => opts.onEvent?.('b', e) });
  const [ra, rb] = await Promise.all([pa, pb]);
  const ta = ra.timing.tFirstToken != null ? ra.timing.ttftMs : null;
  const tb = rb.timing.tFirstToken != null ? rb.timing.ttftMs : null;
  const firstTokenWinner = ta == null && tb == null ? 'none' : ta == null ? 'b' : tb == null ? 'a' : ta === tb ? 'tie' : ta < tb ? 'a' : 'b';
  return {
    a: ra, b: rb, firstTokenWinner,
    ttftDeltaMs: ta != null && tb != null ? tb - ta : null,
    totalDeltaMs: rb.timing.totalMs - ra.timing.totalMs,
  };
}
