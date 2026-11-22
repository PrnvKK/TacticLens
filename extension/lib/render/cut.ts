// Display-rate camera-cut detector for the renderer side.
//
// Every presented video frame is drawn into a 32x18 canvas (willReadFrequently) by VideoCutMonitor and
// handed here as RGBA. We compare a luma histogram and a coarse hue histogram with the previous frame:
// a camera cut changes both abruptly, while a fast pan keeps the same colour distribution frame to frame.
//
// Two guards make fades and dissolves safe:
//  - the luma histogram is computed on mean-removed luma, so a global brightness ramp (a fade) is
//    almost invisible to it;
//  - a mean absolute luma difference gate rejects the residual spikes at the dark end of a fade.
//
// The threshold is adaptive: score > ratio * rolling median (ordinary motion) AND above an absolute
// floor, so a pan-heavy passage raises the bar instead of triggering on its own.

export const CUT_W = 32;
export const CUT_H = 18;

export const CUT_CONFIG = {
  lumaBins: 16,
  /** 12 hue bins of 30 degrees plus one achromatic bin. */
  hueBins: 12,
  neutralHueBin: 12,
  hueBinsTotal: 13,
  /** Ordinary-frame scores kept for the rolling median (~0.5 s at 60 fps). */
  history: 31,
  /** A hard cut must be this many times the median ordinary-frame score. */
  ratio: 3,
  /** ... and above this absolute score (mean-removed luma + hue L1/2, 0..1). */
  floor: 0.14,
  /** Mean |luma| difference (0..255). Below this a frame pair cannot be a cut (a fade moves smoothly). */
  pixelFloor: 6,
  /** Two detections closer than this are one event (a dissolve/wipe burst). */
  cooldownS: 0.15,
  /** A media-time jump this large, or backwards, is a seek. */
  seekGapS: 1.5,
  /** Chroma above this votes in the hue histogram; lower values are achromatic. */
  chromaMin: 18,
} as const;

export type CutReason = 'hard' | 'seek' | null;

export interface CutReading {
  cut: boolean;
  reason: CutReason;
  mediaTime: number;
  /** Combined 0..1 luma+hue histogram distance. */
  score: number;
  /** Luma (mean-removed) histogram L1/2, 0..1. */
  lumaDiff: number;
  /** Coarse hue histogram L1/2, 0..1. */
  hueDiff: number;
  /** Mean absolute luma difference, 0..255. */
  pixelDiff: number;
  /** Rolling median of ordinary-frame scores. */
  median: number;
  /** The threshold applied to this frame. */
  threshold: number;
}

const NO_CUT: Omit<CutReading, 'mediaTime'> = {
  cut: false, reason: null, score: 0, lumaDiff: 0, hueDiff: 0, pixelDiff: 0, median: 0, threshold: CUT_CONFIG.floor,
};

/** Total-variation distance between two normalised histograms, in 0..1. */
function tv(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i]! - b[i]!);
  return d / 2;
}

export class CutDetector {
  readonly o = CUT_CONFIG;
  /** Detections reported so far (hard cuts and seeks). */
  cuts = 0;

  private readonly n = CUT_W * CUT_H;
  private readonly histL = new Float32Array(CUT_CONFIG.lumaBins);
  private readonly histH = new Float32Array(CUT_CONFIG.hueBinsTotal);
  private readonly prevL = new Float32Array(CUT_CONFIG.lumaBins);
  private readonly prevH = new Float32Array(CUT_CONFIG.hueBinsTotal);
  private curPix = new Float32Array(this.n);
  private prevPix = new Float32Array(this.n);
  /** Scores of non-cut frames, oldest first. */
  private scores: number[] = [];
  private scratch: number[] = [];
  private havePrev = false;
  private lastT = Number.NaN;
  private lastCutT = -Infinity;

  /** Feed one presented frame (RGBA, any size mapped to CUT_W x CUT_H by the caller). */
  push(rgba: ArrayLike<number>, mediaTime: number): CutReading {
    if (!Number.isFinite(mediaTime)) return { ...NO_CUT, mediaTime };
    // First frame after construction or a seek: establish the baseline, never compare across it.
    if (!this.havePrev) {
      this.analyse(rgba);
      this.commit();
      this.lastT = mediaTime;
      return { ...NO_CUT, mediaTime };
    }
    // A paused video (fallback rAF) presents the same media frame repeatedly; never a cut.
    if (Math.abs(mediaTime - this.lastT) < 1e-6) return { ...NO_CUT, mediaTime };

    const dt = mediaTime - this.lastT;
    this.analyse(rgba);

    // Seek/rewind/loop: the timeline jumped; the picture may match but the world does not.
    if (dt < -0.05 || dt > this.o.seekGapS) {
      const cut = mediaTime - this.lastCutT >= this.o.cooldownS;
      if (cut) {
        this.cuts++;
        this.lastCutT = mediaTime;
      }
      this.commit();
      this.lastT = mediaTime;
      return { ...NO_CUT, cut, reason: cut ? 'seek' : null, mediaTime };
    }

    const lumaDiff = tv(this.prevL, this.histL);
    const hueDiff = tv(this.prevH, this.histH);
    let pixelDiff = 0;
    for (let i = 0; i < this.n; i++) pixelDiff += Math.abs(this.prevPix[i]! - this.curPix[i]!);
    pixelDiff /= this.n;
    const score = 0.55 * lumaDiff + 0.45 * hueDiff;

    const median = this.medianScore();
    const threshold = Math.max(this.o.floor, this.o.ratio * median);
    let cut = score >= threshold && score >= this.o.floor && pixelDiff >= this.o.pixelFloor;
    if (cut && mediaTime - this.lastCutT < this.o.cooldownS) cut = false;
    if (cut) {
      this.cuts++;
      this.lastCutT = mediaTime;
    } else {
      // Only ordinary frames vote for the median; a cut/dissolve must not raise its own bar.
      this.scores.push(score);
      while (this.scores.length > this.o.history) this.scores.shift();
    }

    this.commit();
    this.lastT = mediaTime;
    return { cut, reason: cut ? 'hard' : null, mediaTime, score, lumaDiff, hueDiff, pixelDiff, median, threshold };
  }

  /**
   * A `seeked` event (any size, including a paused scrub) is a hard timeline change even when the
   * media-time gap is small. Re-baseline on the next presented frame.
   */
  forceSeek(mediaTime: number): CutReading {
    const cut = Number.isFinite(mediaTime) && mediaTime - this.lastCutT >= this.o.cooldownS;
    if (cut) {
      this.cuts++;
      this.lastCutT = mediaTime;
    }
    this.havePrev = false;
    this.lastT = mediaTime;
    return { ...NO_CUT, cut, reason: cut ? 'seek' : null, mediaTime };
  }

  /** The live threshold for the current history (debug / tests). */
  get currentThreshold(): number {
    return Math.max(this.o.floor, this.o.ratio * this.medianScore());
  }

  reset(): void {
    this.havePrev = false;
    this.lastT = Number.NaN;
    this.lastCutT = -Infinity;
    this.scores = [];
    this.cuts = 0;
  }

  /** Per-pixel luma (kept) plus the two normalised histograms. */
  private analyse(rgba: ArrayLike<number>): void {
    const n = this.n, inv = 1 / n;
    this.histL.fill(0);
    this.histH.fill(0);
    let mean = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const l = 0.299 * rgba[o]! + 0.587 * rgba[o + 1]! + 0.114 * rgba[o + 2]!;
      this.curPix[i] = l;
      mean += l;
    }
    mean *= inv;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const r = rgba[o]!, g = rgba[o + 1]!, b = rgba[o + 2]!;
      // Mean-removed luma: a fade shifts the mean, not the shape.
      const c = this.curPix[i]! - mean;
      let lb = ((c + 128) / 16) | 0;
      lb = lb < 0 ? 0 : lb > 15 ? 15 : lb;
      this.histL[lb]! += inv;
      const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      const d = mx - mn;
      let hb: number = this.o.neutralHueBin;
      if (d > this.o.chromaMin) {
        let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
        if (h < 0) h += 6;
        hb = Math.min(this.o.hueBins - 1, (h * 2) | 0);
      }
      this.histH[hb]! += inv;
    }
  }

  private commit(): void {
    this.prevL.set(this.histL);
    this.prevH.set(this.histH);
    const t = this.prevPix;
    this.prevPix = this.curPix;
    this.curPix = t;
    this.havePrev = true;
  }

  private medianScore(): number {
    const s = this.scores;
    if (s.length < 3) return 0;
    const a = this.scratch;
    a.length = 0;
    for (let i = 0; i < s.length; i++) a.push(s[i]!);
    a.sort((x, y) => x - y);
    return a[a.length >> 1]!;
  }
}
