// The one colour setting used by the renderer, the HUD, Kimi prompts, annotated vision frames and the
// Telegram bridge. Known demo clips come from core's hardcoded table; every other source keeps the
// measured colours, so new footage is detected normally.
import {
  knownClipFor, resolveTeamColours,
  type KnownClipColours, type ResolvedTeamColours, type TeamColourPair, type TeamColours,
} from '@tacticlens/core';

export interface ColourSetting {
  /** Raw shirt colours (before the renderer's on-grass display mapping). */
  raw: TeamColourPair;
  /** Explicit colour words for a known clip ("White"/"Blue"); null means derive from the display kit. */
  names: TeamColourPair | null;
  confidence: number;
  origin: ResolvedTeamColours['origin'];
  /** The matched hardcoded clip, if any. */
  clip: KnownClipColours | null;
}

/**
 * Stateful wrapper around core's pure resolver: bind the current video source once, then ask for the
 * effective pair on every snapshot. Never returns a stale pair after the clip stops matching.
 */
export class TeamColourResolver {
  private sourceName: string | null = null;

  constructor(sourceName?: string | null) {
    this.setSource(sourceName);
  }

  setSource(sourceName: string | null | undefined): void {
    this.sourceName = sourceName ?? null;
  }

  get source(): string | null {
    return this.sourceName;
  }

  get activeClip(): KnownClipColours | null {
    return knownClipFor(this.sourceName);
  }

  resolve(measured?: TeamColours | null, scout?: TeamColourPair | null): ColourSetting | null {
    const resolved = resolveTeamColours({
      sourceName: this.sourceName,
      measured: measured ?? null,
      scout: scout ?? null,
    });
    if (!resolved) return null;
    return {
      raw: { A: resolved.A, B: resolved.B },
      names: resolved.names,
      confidence: resolved.confidence,
      origin: resolved.origin,
      clip: resolved.clip,
    };
  }
}
