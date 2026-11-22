// Calm gate: one config and one state machine deciding when a heavy overlay (shape, lanes, links,
// press, overload) may appear. Key player / spotlight are deliberately light and skip this gate.
// The renderer runs at 60 fps, so timers here are wall-clock seconds; the *inputs* are measured from
// the latest snapshot.
//
// Rule of thumb: a heavy graphic starts after the picture has been quiet for a second, and the pitch
// is left alone for eight seconds after one finishes. Busy play still gets the small focus graphics;
// with the Kimi director active the fixed gap is dropped so decisions can keep coming.

export const CALM_CONFIG = {
  /** Global camera pan (1920x1080 reference) above this is a fast pan. */
  cameraPanMaxPxS: 260,
  /** Median camera-compensated player speed above this is end-to-end play. */
  medianPlayerMaxPxS: 260,
  /** A visible ball is required; a searching ball is tolerated this briefly. */
  ballSearchGraceS: 1.5,
  /** No camera cut for this long counts as stable picture. */
  cutQuietS: 2.0,
  /** Minimum live outfield tracks for a formation/links graphic to mean anything. */
  minTracks: 6,
  /** Fraction of live tracks older than `stableAgeS` needed to call tracking stable. */
  stableFraction: 0.7,
  stableAgeS: 0.8,
  /** Calm must hold this long before a heavy graphic may enter. */
  settleS: 1.0,
  /** Fade timings of a heavy group (seconds). */
  fadeInS: 0.3,
  holdMinS: 2.0,
  holdMaxS: 6.0,
  /** With the director active, a decision may ask for up to 10 s; the gate must not cut it short. */
  directorHoldMaxS: 10.0,
  fadeOutS: 0.4,
  /** When calm breaks, wait this long before starting the fade out. */
  calmBreakGraceS: 0.5,
  /** The pitch stays clean this long between heavy groups (measured after the fade ends). */
  gapS: 8.0,
  /** With the Kimi director active, pacing is Kimi's: the fixed gap is dropped, min hold and fades stay. */
  directorGapS: 0.0,
  /** Pending Kimi/director/rules requests are dropped after this long; only the newest is kept. */
  pendingMaxS: 3.0,
  /** Reference frame for converting normalised motion to px/s. */
  refWidth: 1920,
  refHeight: 1080,

  // --- calm player layer (same config so one place explains the whole restraint policy) ---
  /** A marker needs a track this old and a detection score this high. */
  playerAgeS: 1.0,
  playerConfidence: 0.5,
  /** Carrier + nearest opponent + highlighted players, never more than this. */
  playerMax: 4,
  /** Marker fades (seconds). Lost tracks coast before the fade starts. */
  markerFadeInS: 0.25,
  markerLostCoastS: 0.3,
  markerLostFadeS: 0.3,
  /**
   * A hard cut starts a short "new shot" window: the old markers have already snapped out, so
   * requiring a full second of track age would keep the new shot bare for too long. Two or three
   * detections plus confidence is enough here; the strict rule returns once the window closes.
   */
  fastSpawnAfterCutS: 2.0,
  fastSpawnAgeS: 0.2,
  fastSpawnFadeInS: 0.12,
  /** Fast pans hide the player layer; hysteresis avoids flicker at the threshold. */
  markerFastPanPxS: 420,
  markerFastPanExitPxS: 280,
  /** The cut already snapped the old markers; the layer itself may return on the next frame. */
  markerAfterCutS: 0.02,
  /** One Euro / velocity cap for the drawn screen position and size. */
  markerMinCutoffHz: 1.0,
  markerBeta: 0.015,
  markerDCutoffHz: 1.0,
  markerSizeMinCutoffHz: 0.8,
  markerSizeBeta: 0.0,
  markerMaxPxS: 720,
} as const;

export interface CalmMetrics {
  wide: boolean;
  ballOk: boolean;
  /** Wall seconds since the last camera cut (Infinity when none). */
  cutAgoS: number;
  cameraPxS: number;
  /** Median camera-compensated player speed, 1080p px/s. */
  playerPxS: number;
  /** Live outfield track count and the fraction older than the stability age. */
  tracks: number;
  stableFraction: number;
}

const EMPTY: CalmMetrics = { wide: false, ballOk: false, cutAgoS: 0, cameraPxS: 0, playerPxS: 0, tracks: 0, stableFraction: 0 };

export type CalmState = 'busy' | 'settling' | 'ready' | 'showing' | 'clean' | 'bypass';

export class CalmGate {
  readonly o = CALM_CONFIG;
  private metrics: CalmMetrics = EMPTY;
  private rawSince: number | null = null;
  private breakSince: number | null = null;
  private active: { group: string; t0: number } | null = null;
  private cleanUntil = -Infinity;
  private bypass = false;
  private directorActive = false;
  private now = 0;
  private reason = 'no snapshot';

  /** Replace the metric set for this render frame. */
  update(now: number, m: CalmMetrics): void {
    this.now = now;
    this.metrics = m;
    if (this.raw()) {
      this.rawSince ??= now;
      this.reason = now - this.rawSince < this.o.settleS ? 'settling' : '';
    } else {
      this.rawSince = null;
      this.reason = this.failReason(m);
    }
    if (this.active && this.raw()) this.breakSince = null;
    else if (this.active && this.breakSince === null) this.breakSince = now;
  }

  setBypass(v: boolean): void {
    if (v === this.bypass) return;
    this.bypass = v;
    // Keep the active group/cooldown across a freeze-frame: bypass only suspends the *checks*.
    // On resume, an over-age group ends its normal 400 ms fade instead of lingering forever.
    if (!v) this.reason = '';
  }

  get isBypassed(): boolean { return this.bypass; }
  get hasDirector(): boolean { return this.directorActive; }
  get activeGroup(): string | null { return this.active?.group ?? null; }
  get showing(): boolean { return this.active !== null; }

  /** Kimi owns pacing: keep min hold + fades, drop the fixed clean gap. */
  setDirectorActive(v: boolean): void { this.directorActive = v; }

  /** True when the inputs currently pass every calm test (ignoring the settle timer). */
  raw(): boolean {
    const m = this.metrics, o = this.o;
    return m.wide && m.ballOk && m.cameraPxS <= o.cameraPanMaxPxS && m.playerPxS <= o.medianPlayerMaxPxS
      && m.cutAgoS >= o.cutQuietS && m.tracks >= o.minTracks && m.stableFraction >= o.stableFraction;
  }

  get calm(): boolean {
    return this.raw() && this.rawSince !== null && this.now - this.rawSince >= this.o.settleS;
  }

  /** Admission check for one heavy group. The engine still owns anchor/pending checks. */
  canAdmit(now: number): boolean {
    if (this.bypass) return true;
    if (this.active) return false;
    const settled = this.raw() && this.rawSince !== null && now - this.rawSince >= this.o.settleS;
    if (!settled) return false;
    return now >= this.cleanUntil;
  }

  /** Called when the renderer actually pushes the first graphic of a group. */
  admitted(now: number, group: string): void {
    if (this.bypass) return;
    this.active = { group, t0: now };
    this.breakSince = this.raw() ? null : now;
  }

  /** True when the active group should begin its fade-out. */
  shouldEnd(now: number): boolean {
    if (this.bypass || !this.active) return false;
    const age = now - this.active.t0;
    if (age < this.o.holdMinS) return false;
    if (age >= (this.directorActive ? this.o.directorHoldMaxS : this.o.holdMaxS)) return true;
    if (this.raw()) return false;
    return this.breakSince !== null && now - this.breakSince >= this.o.calmBreakGraceS;
  }

  /** Called once the last graphic of the group has left the screen. */
  ended(now: number): void {
    if (!this.active) return;
    this.active = null;
    this.breakSince = null;
    this.cleanUntil = now + (this.directorActive ? this.o.directorGapS : this.o.gapS);
  }

  reset(): void {
    this.active = null; this.rawSince = null; this.breakSince = null; this.cleanUntil = -Infinity;
    this.reason = 'reset';
  }

  /** Short state for the ?perf=1 detail line: calm/busy + reason. */
  get status(): string {
    if (this.bypass) return 'bypass';
    if (this.active) return this.raw() ? 'calm showing' : 'busy holding';
    if (this.raw() && this.rawSince !== null && this.now - this.rawSince < this.o.settleS) return 'busy settling';
    if (this.calm) {
      return this.now < this.cleanUntil ? `calm clean ${Math.ceil(this.cleanUntil - this.now)}s` : 'calm ready';
    }
    return `busy (${this.reason || 'settling'})`;
  }

  get state(): CalmState {
    if (this.bypass) return 'bypass';
    if (this.active) return 'showing';
    if (this.raw() && this.rawSince !== null && this.now - this.rawSince < this.o.settleS) return 'settling';
    if (this.calm) return this.now < this.cleanUntil ? 'clean' : 'ready';
    return 'busy';
  }

  private failReason(m: CalmMetrics): string {
    if (!m.wide) return 'not wide';
    if (!m.ballOk) return 'ball off';
    if (m.tracks < this.o.minTracks) return `only ${m.tracks} tracks`;
    if (m.stableFraction < this.o.stableFraction) return 'tracks unstable';
    if (m.cameraPxS > this.o.cameraPanMaxPxS) return `pan ${Math.round(m.cameraPxS)}px/s`;
    if (m.playerPxS > this.o.medianPlayerMaxPxS) return `players ${Math.round(m.playerPxS)}px/s`;
    if (m.cutAgoS < this.o.cutQuietS) return `cut ${m.cutAgoS.toFixed(1)}s ago`;
    return 'quiet';
  }
}

/** Convert normalised per-second motion to 1080p pixels per second. */
export function motionPxS(vx: number, vy: number): number {
  return Math.hypot(vx * CALM_CONFIG.refWidth, vy * CALM_CONFIG.refHeight);
}
