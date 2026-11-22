import type { QualityLevel } from '../types';

/**
 * Degrade ladder. Rolling p95 of cycle time (wall ms).
 * Step down fast (>= 3 s over threshold), step up slowly (>= 10 s under the headroom threshold).
 */
export interface LadderOpts {
  windowS?: number;
  downAfterS?: number;
  upAfterS?: number;
  /** p95 above downMs[q-1 .. ] steps from level 3->2, 2->1, 1->0. */
  downMs?: [number, number, number];
  /** p95 must stay below upMs to step from level 0->1, 1->2, 2->3. */
  upMs?: [number, number, number];
}

export class QualityLadder {
  level: QualityLevel = 3;
  private samples: { t: number; ms: number }[] = [];
  private overSince = -1;
  private underSince = -1;
  private o: Required<LadderOpts>;

  constructor(opts: LadderOpts = {}) {
    this.o = {
      windowS: 3,
      downAfterS: 3,
      upAfterS: 10,
      downMs: [180, 250, 400],
      upMs: [300, 200, 150],
      ...opts,
    };
  }

  p95(): number {
    if (!this.samples.length) return 0;
    const s = this.samples.map((x) => x.ms).sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))]!;
  }

  /** Feed one finished cycle. `tSec` is any monotonic wall clock in seconds. */
  push(tSec: number, cycleMs: number): QualityLevel {
    this.samples.push({ t: tSec, ms: cycleMs });
    while (this.samples.length > 1 && tSec - this.samples[0]!.t > this.o.windowS) this.samples.shift();
    const p = this.p95();
    const L = this.level;
    const downMs: number[] = this.o.downMs, upMs: number[] = this.o.upMs;
    const down = L > 0 && p > downMs[3 - L]!;
    const up = L < 3 && p < upMs[L]!;
    if (down) {
      if (this.overSince < 0) this.overSince = tSec;
      if (tSec - this.overSince >= this.o.downAfterS) { this.level = (L - 1) as QualityLevel; this.overSince = -1; this.underSince = -1; this.samples = []; }
    } else this.overSince = -1;
    if (up && !down) {
      if (this.underSince < 0) this.underSince = tSec;
      if (tSec - this.underSince >= this.o.upAfterS) { this.level = (L + 1) as QualityLevel; this.underSince = -1; this.overSince = -1; this.samples = []; }
    } else this.underSince = -1;
    return this.level;
  }

  reset(): void { this.level = 3; this.samples = []; this.overSince = this.underSince = -1; }
}
