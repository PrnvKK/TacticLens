// The one colour setting used by the renderer, the HUD, Kimi prompts, annotated vision frames and the
// Telegram bridge. Colours always come from the picture (measured); core's resolver adds a scorebug
// read only when measurement has nothing yet.
import {
  resolveTeamColours,
  type ResolvedTeamColours, type TeamColourPair, type TeamColours,
} from '@tacticlens/core';

export interface ColourSetting {
  /** Raw shirt colours (before the renderer's on-grass display mapping). */
  raw: TeamColourPair;
  confidence: number;
  origin: ResolvedTeamColours['origin'];
}

/** Stateless wrapper around core's pure resolver: ask for the effective pair on every snapshot. */
export class TeamColourResolver {
  resolve(measured?: TeamColours | null, scout?: TeamColourPair | null): ColourSetting | null {
    const resolved = resolveTeamColours({
      measured: measured ?? null,
      scout: scout ?? null,
    });
    if (!resolved) return null;
    return {
      raw: { A: resolved.A, B: resolved.B },
      confidence: resolved.confidence,
      origin: resolved.origin,
    };
  }
}
