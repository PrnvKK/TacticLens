// One place that decides what the two team colours are.
//
// Perception measures the kits every frame and that measurement is the source of truth. A scorebug
// read is only a fallback when the teams fit has nothing. The same resolver feeds the renderer, the
// LLM match block, the annotated vision frames and the bridge (Telegram); nothing downstream needs its
// own colour heuristic.
import type { TeamColours } from '../types';

export interface TeamColourPair {
  A: string;
  B: string;
}

export type TeamColourOrigin = 'measured' | 'scout';

export interface ResolvedTeamColours extends TeamColourPair {
  /** 0..1 confidence of the underlying source. */
  confidence: number;
  origin: TeamColourOrigin;
  /** The measured pair that was seen alongside the resolution, if any (diagnostics/tests). */
  measured: TeamColourPair | null;
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

function validPair(pair: { A?: unknown; B?: unknown } | null | undefined): pair is TeamColourPair {
  return !!pair && typeof pair.A === 'string' && typeof pair.B === 'string'
    && HEX_RE.test(pair.A) && HEX_RE.test(pair.B);
}

export interface ResolveTeamColoursOpts {
  /** Fresh cluster measurement from the teams module. */
  measured?: TeamColours | null;
  /** Scorebug/LLM read, used only when perception has no colours yet. */
  scout?: TeamColourPair | null;
}

/**
 * The common colour setting: measured kit colours, then a scorebug read.
 * Returns null only when there is no colour information at all, so callers can keep their last value.
 */
export function resolveTeamColours(o: ResolveTeamColoursOpts): ResolvedTeamColours | null {
  const measured = validPair(o.measured ?? null) ? { A: o.measured!.A, B: o.measured!.B } : null;
  if (measured) {
    return {
      ...measured,
      confidence: o.measured?.confidence ?? 1,
      origin: 'measured',
      measured,
    };
  }
  if (validPair(o.scout ?? null)) {
    return {
      A: o.scout!.A,
      B: o.scout!.B,
      confidence: 1,
      origin: 'scout',
      measured: null,
    };
  }
  return null;
}
