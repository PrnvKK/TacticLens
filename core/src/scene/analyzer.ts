import type { SceneKind } from '../types';
import { isGrass } from '../teams/lab';

export const GRID_W = 64;
export const GRID_H = 36;

export interface SceneOpts {
  cutHist: number;       // histogram distance (0..1) that, with cutDiff, marks a cut
  cutDiff: number;       // mean abs luma difference (0..255)
  wipeWindowS: number;   // two cuts within this = a broadcast wipe (replay in/out)
  /** After a wipe, wait this long before latching REPLAY; live wide play during the interval cancels it. */
  replayConfirmS: number;
  replayMaxS: number;    // hard cap on the replay latch (seconds of video time)
  replayExitS: number;   // accumulated live evidence that releases the replay latch
  replayExitGreen: number;      // green ratio that counts as live wide play again
  replayExitPlayers: number;    // player count that counts as live wide play again
  replayExitMaxBboxH: number;   // median box height above this is a close-up, not wide
  commitS: number;       // a new non-cut classification must persist this long
  graphicStillS: number;
  seekGapS: number;      // gaps larger than this count as a cut
}

// A false REPLAY blocks ID allocation, the ball pass and teams, so the bar to enter is high: a lone cut
// pair only latches after replayConfirmS without live-wide-play evidence, and any wide shot releases it in
// replayExitS. Prefer missing a replay over poisoning a live minute.
export const DEFAULT_SCENE_OPTS: SceneOpts = {
  cutHist: 0.35, cutDiff: 22, wipeWindowS: 1.3, replayConfirmS: 0.6, replayMaxS: 15, replayExitS: 0.6,
  replayExitGreen: 0.14, replayExitPlayers: 4, replayExitMaxBboxH: 0.22,
  commitS: 0.3, graphicStillS: 1.0, seekGapS: 1.5,
};

export interface SceneSignals {
  greenRatio: number;
  playerCount: number;
  medianBboxH: number;   // normalised to frame height
  cut: boolean;
  wipe: boolean;
  histDiff: number;
  lumaDiff: number;
  staticFraction: number;
  /** Mean colourfulness (chroma range, 0..255) over the frame; EA FC is heavily saturated. */
  saturation: number;
  /** 0..1; higher = more uniform grass texture (synthetic turf), lower = mowing stripes / texture. */
  grassUniformity: number;
}

export interface SceneResult extends SceneSignals {
  kind: SceneKind;
  confidence: number;
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1]!;
}

/**
 * Scene classifier from cheap signals. Input is a 64x36 RGBA downsample of the frame plus the
 * person detections' normalised box heights. No DOM: the caller supplies the pixels.
 * Precedence: GRAPHIC, REPLAY, CROWD, CLOSE, WIDE. REPLAY is a heuristic: a broadcast wipe (two cuts within
 * ~1.3 s) toggles a replay flag that expires after replayMaxS or at the next wipe.
 */
export class SceneAnalyzer {
  readonly o: SceneOpts;
  private prevLuma: Float32Array | null = null;
  private prevHist: Float32Array | null = null;
  private lastT = -Infinity;
  private cutTimes: number[] = [];
  private replay = false;
  private replaySince = 0;
  private pendingReplayAt = -1;   // a wipe was seen; waiting out replayConfirmS
  private pendingLiveS = 0;       // live-wide evidence inside the confirmation interval
  private liveS = 0;              // accumulated live-play evidence while the replay latch is on
  private stillSince = -1;
  private kind: SceneKind = 'WIDE';
  private pending: SceneKind | null = null;
  private pendingSince = 0;
  // static-region mask state (running luma mean/variance per cell, ~5 s time constant)
  private mean = new Float32Array(GRID_W * GRID_H);
  private vari = new Float32Array(GRID_W * GRID_H);
  private grass = new Uint8Array(GRID_W * GRID_H);
  private warmS = 0;

  constructor(o: Partial<SceneOpts> = {}) {
    this.o = { ...DEFAULT_SCENE_OPTS, ...o };
  }

  reset(): void {
    this.prevLuma = null; this.prevHist = null; this.lastT = -Infinity; this.cutTimes = []; this.replay = false;
    this.pendingReplayAt = -1; this.pendingLiveS = 0; this.liveS = 0;
    this.stillSince = -1; this.kind = 'WIDE'; this.pending = null; this.warmS = 0; this.vari.fill(0);
  }

  /** True while the replay latch is on (exposed for tests / debug). */
  get isReplay(): boolean { return this.replay; }

  /**
   * Static-region mask (1 = broadcaster graphic candidate): cells with ~zero temporal variance over ~5 s that are
   * not grass, in the top 20% or bottom 25% bands. Empty until the mask has warmed up.
   */
  staticMask(): Uint8Array {
    const m = new Uint8Array(GRID_W * GRID_H);
    if (this.warmS < 4) return m;
    for (let y = 0; y < GRID_H; y++) {
      if (y >= GRID_H * 0.2 && y < GRID_H * 0.75) continue;
      for (let x = 0; x < GRID_W; x++) {
        const i = y * GRID_W + x;
        if (this.vari[i]! < 12 && !this.grass[i]) m[i] = 1;
      }
    }
    return m;
  }

  update(t: number, rgba: ArrayLike<number>, playerBoxHeights: number[]): SceneResult {
    const n = GRID_W * GRID_H;
    const luma = new Float32Array(n);
    const hist = new Float32Array(32 + 12);
    let green = 0;
    let satSum = 0;
    let gSum = 0, gSqSum = 0, grassN = 0;
    for (let i = 0; i < n; i++) {
      const r = rgba[i * 4]!, g = rgba[i * 4 + 1]!, b = rgba[i * 4 + 2]!;
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      luma[i] = l;
      hist[Math.min(31, l >> 3)]! += 1;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      satSum += d;
      let hb = 0;
      if (d > 20) {
        let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
        if (h < 0) h += 6;
        hb = 1 + Math.min(10, Math.floor(h * 10 / 6));
      }
      hist[32 + hb]! += 1;
      const gr = isGrass(r, g, b);
      this.grass[i] = gr ? 1 : 0;
      if (gr) { green++; gSum += g; gSqSum += g * g; grassN++; }
    }
    for (let i = 0; i < hist.length; i++) hist[i]! /= n;
    const saturation = satSum / n;
    // Synthetic turf is chromatically near-flat green; broadcast grass has mowing stripes and texture.
    const gMean = grassN ? gSum / grassN : 0;
    const gVar = grassN ? Math.max(0, gSqSum / grassN - gMean * gMean) : 0;
    const grassUniformity = grassN ? Math.max(0, Math.min(1, 1 - Math.sqrt(gVar) / 30)) : 0;

    const first = this.prevLuma === null;
    let histDiff = 0, lumaDiff = 0;
    const dt = t - this.lastT;
    let cut = false;
    if (this.prevLuma && this.prevHist && dt >= 0) {
      for (let i = 0; i < hist.length; i++) histDiff += Math.abs(hist[i]! - this.prevHist[i]!);
      histDiff /= 4;     // two histograms each summing to 1: L1 in [0,4] -> [0,1]
      for (let i = 0; i < n; i++) lumaDiff += Math.abs(luma[i]! - this.prevLuma[i]!);
      lumaDiff /= n;
      cut = (histDiff > this.o.cutHist && lumaDiff > this.o.cutDiff) || dt > this.o.seekGapS || dt < 0;
    } else if (this.prevLuma && dt < 0) cut = true;

    // static mask update
    if (cut) { for (let i = 0; i < n; i++) { this.mean[i] = luma[i]!; this.vari[i] = 0; } this.warmS = 0; }
    else if (this.prevLuma) {
      const a = 1 - Math.exp(-Math.max(0, dt) / 5);
      for (let i = 0; i < n; i++) {
        const dlt = luma[i]! - this.mean[i]!;
        this.mean[i]! += a * dlt;
        this.vari[i] = (1 - a) * (this.vari[i]! + a * dlt * dlt);
      }
      this.warmS += Math.max(0, dt);
    } else { for (let i = 0; i < n; i++) { this.mean[i] = luma[i]!; this.vari[i] = 0; } }
    let stat = 0;
    for (let i = 0; i < n; i++) if (this.vari[i]! < 12 && !this.grass[i]) stat++;
    const staticFraction = this.warmS >= 4 ? stat / n : 0;

    this.prevLuma = luma; this.prevHist = hist; this.lastT = t;

    const greenRatio = green / n;
    const playerCount = playerBoxHeights.length;
    const medianBboxH = median(playerBoxHeights);

    // Wipe / replay latch. A wipe only *proposes* a replay: a live broadcast also cuts wide -> close -> wide
    // in under wipeWindowS, and latching on that pair would mark LIVE as REPLAY for up to replayMaxS, which
    // blocks births, the ball and teams. So wait replayConfirmS; live-wide evidence cancels the proposal.
    // Once latched, accumulated wide-play evidence releases it (one bad frame no longer resets the clock),
    // and replayMaxS is a hard cap.
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(0.5, dt) : 0;
    const wideShot = playerCount >= this.o.replayExitPlayers && medianBboxH <= this.o.replayExitMaxBboxH;
    const greenWide = greenRatio >= this.o.replayExitGreen &&
      playerCount >= this.o.replayExitPlayers && medianBboxH <= this.o.replayExitMaxBboxH;
    let wipe = false;
    if (cut) {
      this.cutTimes = this.cutTimes.filter((c) => t - c <= this.o.wipeWindowS);
      if (this.cutTimes.length >= 1) {
        wipe = true;
        this.cutTimes = [];
        if (this.replay) {
          // A second wipe is the conventional replay-out: exiting early is always the safe direction.
          this.replay = false;
          this.liveS = 0;
        } else if (this.pendingReplayAt < 0) {
          this.pendingReplayAt = t;
          this.pendingLiveS = 0;
        }
      } else this.cutTimes.push(t);
    }
    let replayExited = false;
    let replayEntered = false;
    if (!this.replay && this.pendingReplayAt >= 0) {
      if (!cut && wideShot) this.pendingLiveS += step;
      if (t - this.pendingReplayAt >= this.o.replayConfirmS) {
        // Less than half the confirmation interval looked like a live wide shot -> it really is a replay.
        if (this.pendingLiveS < this.o.replayConfirmS * 0.5) {
          this.replay = true;
          this.replaySince = this.pendingReplayAt;
          this.liveS = 0;
          replayEntered = true;
        }
        this.pendingReplayAt = -1;
        this.pendingLiveS = 0;
      }
    }
    if (this.replay) {
      const liveWide = !cut && (wideShot || greenWide);
      if (liveWide) this.liveS += step;
      else this.liveS = Math.max(0, this.liveS - step);
      if (this.liveS >= this.o.replayExitS) { this.replay = false; replayExited = true; this.liveS = 0; }
      if (this.replay && t - this.replaySince > this.o.replayMaxS) { this.replay = false; replayExited = true; this.liveS = 0; }
    } else this.liveS = 0;

    if (lumaDiff < 2 && greenRatio < 0.2 && !cut) { if (this.stillSince < 0) this.stillSince = t; }
    else this.stillSince = -1;
    const still = this.stillSince >= 0 && t - this.stillSince >= this.o.graphicStillS;

    let raw: SceneKind;
    let conf = 0.7;
    if (still && playerCount <= 2) { raw = 'GRAPHIC'; conf = 0.8; }
    else if (this.replay) { raw = 'REPLAY'; conf = 0.5; }
    else if (greenRatio < 0.12 && playerCount <= 3) { raw = 'CROWD'; conf = Math.min(1, 0.5 + (0.12 - greenRatio) * 5); }
    else if (medianBboxH > 0.22 || (playerCount <= 3 && greenRatio >= 0.12)) { raw = 'CLOSE'; conf = Math.min(1, 0.5 + Math.abs(medianBboxH - 0.22)); }
    else if (playerCount >= 4 && medianBboxH <= 0.22 && greenRatio >= 0.05 && greenRatio < 0.3) { raw = 'WIDE'; conf = 0.55; }
    else if (greenRatio >= 0.3 && playerCount >= 4) { raw = 'WIDE'; conf = Math.min(1, 0.5 + (greenRatio - 0.3) + playerCount * 0.03); }
    else if (greenRatio >= 0.12 && playerCount >= 4) { raw = 'WIDE'; conf = 0.45; }
    else { raw = playerCount ? 'CLOSE' : 'CROWD'; conf = 0.4; }

    if (cut || first || replayExited || replayEntered) { this.kind = raw; this.pending = null; }
    else if (raw !== this.kind) {
      if (this.pending !== raw) { this.pending = raw; this.pendingSince = t; }
      if (t - this.pendingSince >= this.o.commitS) { this.kind = raw; this.pending = null; }
    } else this.pending = null;

    return {
      kind: this.kind, confidence: Math.max(0.1, Math.min(1, conf)),
      greenRatio, playerCount, medianBboxH, cut, wipe, histDiff, lumaDiff, staticFraction,
      saturation, grassUniformity,
    };
  }
}
