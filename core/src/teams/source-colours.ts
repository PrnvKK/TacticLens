// One place that decides what the two team colours are.
//
// Perception measures the kits every frame, but a few demo clips are known ahead of time. Those clips
// carry a hardcoded kit pair so a noisy frame, a close-up of a warm-up jacket or a colour-cast can never
// rename the teams in the HUD, the Kimi prompts or the Telegram analyst. Any other clip keeps the
// measured colours, so new footage is detected exactly as before.
//
// The same resolver feeds the renderer, the LLM match block, the annotated vision frames and the bridge
// (Telegram); nothing downstream needs its own colour heuristic.
import type { TeamColours } from '../types';

export interface TeamColourPair {
  A: string;
  B: string;
}

export interface KnownClipColours {
  /** Stable id for tests/logging. */
  id: string;
  /** Human-readable description of the clip and the two kits. */
  label: string;
  /** Tested against the normalised source name (lower-case, punctuation collapsed to spaces). */
  matches: (source: string) => boolean;
  /** Hardcoded shirt colours. A follows the teams module's lighter-kit convention. */
  kit: TeamColourPair;
  /** Colour words used by the HUD, Kimi prompts and Telegram ("Team Blue", "Team White"). */
  names: TeamColourPair;
}

/**
 * Known demo clips. Add a row here to pin a new clip; every other source falls back to perception.
 * `A`/`B` follow the teams module's convention (A is the lighter kit), so the hardcoded words stay
 * attached to the same side for the whole clip.
 */
export const KNOWN_CLIP_COLOURS: readonly KnownClipColours[] = [
  {
    id: 'eafc26-ps5-pro',
    label: 'EA FC 26 on PS5 Pro: Manchester City (light blue) vs Real Madrid (white)',
    // The PS5 Pro + EA FC pair is specific enough for this demo clip. The graphics phrase used to be
    // required too, but a re-encoded/renamed copy dropped it and the clip silently fell back to
    // perception, where the pale City kit and Madrid white are genuinely hard to separate.
    matches: (source) => /\bps5\s*pro\b/.test(source) && /\bea\s*(?:sports\s*)?fc\b/.test(source),
    kit: { A: '#f2f2f2', B: '#5aa9dd' },
    names: { A: 'White', B: 'Blue' },
  },
  {
    id: 'footage-orange-dark-blue',
    label: 'footage.mp4: orange vs dark blue',
    matches: (source) => /^footage(?: |$)/.test(source),
    kit: { A: '#e8542e', B: '#1f2f5c' },
    names: { A: 'Orange', B: 'Dark blue' },
  },
];

/** Lower-case the source, strip accents and collapse every run of punctuation to one space. */
export function normaliseSourceName(raw: string | null | undefined): string {
  if (!raw) return '';
  let source = raw;
  try { source = decodeURIComponent(source); } catch { /* a malformed URL keeps its raw text */ }
  return source
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Last path segment, with query/hash removed (works for Windows and URL paths). */
function basenameOf(raw: string): string {
  let source = raw;
  try { source = decodeURIComponent(source); } catch { /* keep the raw text */ }
  const clean = source.replace(/[?#].*$/, '').replace(/\\/g, '/');
  const parts = clean.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? clean;
}

/** The hardcoded profile for a clip, or null when this source should be detected from the picture. */
export function knownClipFor(sourceName: string | null | undefined): KnownClipColours | null {
  if (!sourceName) return null;
  const source = normaliseSourceName(basenameOf(sourceName));
  if (!source) return null;
  return KNOWN_CLIP_COLOURS.find((clip) => clip.matches(source)) ?? null;
}

export type TeamColourOrigin = 'clip' | 'measured' | 'scout';

export interface ResolvedTeamColours extends TeamColourPair {
  /** 0..1 confidence of the underlying source; a clip override is 1. */
  confidence: number;
  origin: TeamColourOrigin;
  /** Explicit colour words for a known clip; null means derive them from the display kit as before. */
  names: TeamColourPair | null;
  /** The matched clip, if any. */
  clip: KnownClipColours | null;
  /** The measured pair that was seen alongside the resolution, if any (diagnostics/tests). */
  measured: TeamColourPair | null;
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

function validPair(pair: { A?: unknown; B?: unknown } | null | undefined): pair is TeamColourPair {
  return !!pair && typeof pair.A === 'string' && typeof pair.B === 'string'
    && HEX_RE.test(pair.A) && HEX_RE.test(pair.B);
}

export interface ResolveTeamColoursOpts {
  /** Video filename, URL or page title; only used to recognise a known clip. */
  sourceName?: string | null;
  /** Fresh cluster measurement from the teams module. */
  measured?: TeamColours | null;
  /** Scorebug/LLM read, used only when perception has no colours yet. */
  scout?: TeamColourPair | null;
}

/**
 * The common colour setting: known clip first, then measured kit colours, then a scorebug read.
 * Returns null only when there is no colour information at all, so callers can keep their last value.
 */
export function resolveTeamColours(o: ResolveTeamColoursOpts): ResolvedTeamColours | null {
  const measured = validPair(o.measured ?? null) ? { A: o.measured!.A, B: o.measured!.B } : null;
  const clip = knownClipFor(o.sourceName);
  if (clip) {
    return {
      ...clip.kit,
      confidence: 1,
      origin: 'clip',
      names: clip.names,
      clip,
      measured,
    };
  }
  if (measured) {
    return {
      ...measured,
      confidence: o.measured?.confidence ?? 1,
      origin: 'measured',
      names: null,
      clip: null,
      measured,
    };
  }
  if (validPair(o.scout ?? null)) {
    return {
      A: o.scout!.A,
      B: o.scout!.B,
      confidence: 1,
      origin: 'scout',
      names: null,
      clip: null,
      measured: null,
    };
  }
  return null;
}
