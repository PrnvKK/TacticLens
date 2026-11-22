// Auto source classification: guess `game` (EA Sports FC) vs `broadcast` from cheap frame signals,
// with hysteresis. Kept deliberately conservative: a wrong flip to `game` would hurt real broadcast
// footage, so the classifier defaults to `broadcast` and only commits on a sustained, strong signal.
//
// Signals (already computed by SceneAnalyzer):
//   - grassUniformity: EA FC renders near-flat synthetic turf; broadcast grass has mowing stripes/texture.
//   - saturation: EA FC is heavily saturated; broadcast is more muted.
// Only live WIDE frames with real green vote, so a scorebug / replay / close-up never moves the needle.

import type { ResolvedSourceKind } from '../tracking/profile';
import type { SceneResult } from './analyzer';

export interface SourceClassifyOpts {
  /** Time span over which the score is averaged before a decision may flip. */
  windowS: number;
  /** Mean score at/above this commits `game` (from broadcast). */
  highThr: number;
  /** Mean score at/below this (sustained) releases `game` back to `broadcast`. */
  lowThr: number;
  /** Minimum WIDE samples required before a decision is allowed. */
  minSamples: number;
  /** Frames with less grass than this do not vote. */
  minGreen: number;
}

export const DEFAULT_SOURCE_CLASSIFY: SourceClassifyOpts = {
  windowS: 2.0, highThr: 0.72, lowThr: 0.45, minSamples: 6, minGreen: 0.2,
};

/** 0..1 game likelihood from one WIDE frame. */
export function gameScore(s: SceneResult): number {
  const sat = Math.max(0, Math.min(1, s.saturation / 90));
  return Math.max(0, Math.min(1, 0.6 * s.grassUniformity + 0.4 * sat));
}

export class SourceClassifier {
  readonly o: SourceClassifyOpts;
  private kind: ResolvedSourceKind = 'broadcast';
  private samples: { t: number; score: number }[] = [];

  constructor(o: Partial<SourceClassifyOpts> = {}) {
    this.o = { ...DEFAULT_SOURCE_CLASSIFY, ...o };
  }

  get resolved(): ResolvedSourceKind { return this.kind; }

  reset(): void { this.kind = 'broadcast'; this.samples = []; }

  /** Feed one scene result at video time `t`; returns the (possibly updated) resolved kind. */
  update(t: number, s: SceneResult): ResolvedSourceKind {
    if (s.kind !== 'WIDE' || s.greenRatio < this.o.minGreen) return this.kind;
    this.samples.push({ t, score: gameScore(s) });
    while (this.samples.length && t - this.samples[0]!.t > this.o.windowS) this.samples.shift();
    if (this.samples.length < this.o.minSamples) return this.kind;
    const mean = this.samples.reduce((a, x) => a + x.score, 0) / this.samples.length;
    if (this.kind === 'broadcast' && mean >= this.o.highThr) this.kind = 'game';
    else if (this.kind === 'game' && mean <= this.o.lowThr) this.kind = 'broadcast';
    return this.kind;
  }
}
