// 60 fps overlay engine. Owns prediction, pan compensation, springs, concurrency
// caps and entry/exit choreography. Input: ~8 Hz OverlaySnapshot + event-driven intents.
// Output: Canvas2D pixels, DPR-sharp, aimed at <4 ms per frame at 1920x1080.
import type { GraphicIntent, OverlaySnapshot, Prediction, QualityLevel, Team } from '@tacticlens/core';
import {
  Extrapolator, EXTRAP_MAX_S, OneEuroFilter, clamp, fitRect, convexHull, distToSegment, hexToRgb, lerp, mixRgb, springStep,
  type Rect, type RGB, type Spring,
} from './math';
import { COLOUR, D, GROUP, MARKER, PRIORITY, RULES, ease } from './tokens';
import { CALM_CONFIG, CalmGate, motionPxS, type CalmMetrics } from './calm';
import { MarkerCutPolicy, type CutSource } from './marker-lifecycle';
import {
  ACCENT_RGB, INK_RGB, NEUTRAL_RGB, distanceLabel, drawBall, drawDim, drawFormation, drawFreeze, drawGroundMarker, drawHull,
  drawLagGhost, drawLane, drawLink, drawOverload, drawPocket, drawPrediction, drawPressure, drawReplayWipe,
  drawRun, drawScan, drawSpotRing, drawSwitch, drawTag,
  type FormationLine, type Pt,
} from './draw';
import type { Tier, ViewState } from './ui-types';

const BASE_TYPES = new Set(['ring', 'ball_marker', 'carrier']);
/** Neat focus graphics that may enter without the heavy calm gate; they still obey TTL and carrier expiry. */
const LIGHT_TYPES = new Set(['tag', 'spotlight']);

/** The ball marker is debug-only (?ball=show); viewers follow the ball themselves. */
const SHOW_BALL_MARKER = (() => {
  try { return new URLSearchParams(globalThis.location?.search ?? '').get('ball') === 'show'; } catch { return false; }
})();
const ENTER_DUR: Record<string, number> = {
  spotlight: 0.3, tag: 0.3, lanes: 0.28, switch: 0.32, hull: 0.45, line: 0.45, overload: 0.28, links: 0.28,
  pressure: 0.28, run: 0.28, pocket: 0.45, prediction: 0.32, lag_ghost: 0.28,
};
const EXIT_DUR: Record<string, number> = {
  hull: D.fade, line: D.fade, prediction: 0.24, tag: D.fade, links: D.fade, spotlight: D.fade,
};

interface Anchor {
  id: number;
  cls: string;
  team: Team;
  margin: number;
  /** Position predictor: extrapolates the last detection to the current video time (latency compensation). */
  mo: Extrapolator;
  rw: Spring;
  tw: number; th: number;
  tr: OverlaySnapshot['tracks'][number] | null;
  missS: number;
  state: 'pending' | 'on';
  t0: number;
  colKey: string;
  colFrom: RGB;
  colT0: number;
  lastChange: number;
  pulseAt: number;
  // per-frame derived (px)
  sx: number; sy: number; sr: number; sh: number; squash: number; alpha: number;
  /** Calm marker: One Euro filters (screen px), velocity-capped draw point, size, alpha. */
  fx: OneEuroFilter | null;
  fy: OneEuroFilter | null;
  fsize: OneEuroFilter | null;
  drawX: number | null;
  drawY: number | null;
  drawR: number;
  markerAlpha: number;
  /** 0..1 cross-fade into the carrier/highlighted marker style. */
  markerBoost: number;
  lostAt: number | null;
}

interface Gfx {
  intent: GraphicIntent;
  t0: number;
  exitReq: number | null;
  exitAt: number | null;
  force: boolean;
  fast: boolean;
  fromAsk: boolean;
  resolvedAt: number | null;
  /** Non-base graphic: subject to the calm gate, one group at a time. */
  heavy: boolean;
  /** Admitted through the calm gate: 300 ms in / 400 ms out, minimum hold. */
  calm: boolean;
  group: string;
  /** Carrier at admission (snapshot passOptions); used to expire focus graphics when possession moves. */
  carrierAtAdmit: number;
}

interface Dying { a: Anchor; t0: number; dur: number; sx: number; sy: number; sr: number; squash: number; rgb: RGB; edge: RGB }

/**
 * After a renderer-side cut the brain needs one detection cycle to acknowledge it (reset the tracker
 * and report the new shot). Until that FrameState arrives, snapshots still describe the old shot;
 * hold the marker layer for this long rather than rebuilding stale anchors. A brain cut does not need
 * the hold (its snapshot is already cut-aware).
 */
const CUT_BLOCK_S = 0.22;

export interface FrameStats { lastMs: number; avgMs: number; maxMs: number }

export interface EngineClock { readonly currentTime: number; readonly paused: boolean }

export class OverlayEngine {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private clock: EngineClock;
  private cssW = 0; private cssH = 0; private dpr = 1;
  private rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private u = 1;
  private tier: Tier = 'full';
  private showcase = false;
  private snap: OverlaySnapshot | null = null;
  private anchors = new Map<number, Anchor>();
  private dying: Dying[] = [];
  private gfx: Gfx[] = [];
  private pending: { intent: GraphicIntent; since: number; fromAsk: boolean }[] = [];
  private lastExit = new Map<string, number>();
  private predictions = new Map<string, Prediction>();
  private lag = new Map<string, { ballXY: [number, number]; lateS: number }>();
  private kit: { A: RGB; B: RGB } = { A: hexToRgb(COLOUR.teamA), B: hexToRgb(COLOUR.teamB) };
  private kitEdge: { A: RGB; B: RGB } = { A: hexToRgb(COLOUR.teamA), B: hexToRgb(COLOUR.teamB) };
  private state: ViewState = 'OFF';
  private ballOut = false;
  private lastNow = 0;
  private lastT = 0;
  /** Cut timing + spawn windows (shared with the renderer-side detector through cut()). */
  private cuts = new MarkerCutPolicy();
  /** A detector cut is waiting for the brain's cut-aware FrameState. */
  private cutBlocked = false;
  private cutBlockUntil = 0;
  private holdUntil = 0;
  private sweep: { t0: number; done: boolean } | null = null;
  private lock: { t0: number; done: boolean } | null = null;
  private replayWipe: { t0: number; entering: boolean } | null = null;
  private calibrated = false;
  private sawCalibration = false;
  private calibStart = 0;
  private ringA = 0;
  private pauseDim = 0;
  /** ?players=all debug layer: every tracked player gets a marker. */
  private playersAll = false;
  /** Player-marker pan/cut fade and pan hysteresis. */
  private markerFade = 1;
  private markerPan = false;
  /** Calm gate for every non-base graphic. */
  private calm = new CalmGate();
  private ball = {
    mo: new Extrapolator({ maxVel: 7, maxGap: 0.4 }),
    has: false, alpha: 0, popT0: -10,
    vx: 0, vy: 0, lastXY: null as [number, number] | null, lastT: 0, hist: [] as { x: number; y: number; t: number }[],
    shown: false, drawn: null as Pt | null,
  };
  private fs: FrameStats = { lastMs: 0, avgMs: 0, maxMs: 0 };
  private quality: QualityLevel = 3;
  private seedMarch = 0;
  /** Latency-compensation tuning, sourced from the active SourceProfile (broadcast default). */
  private extrap = { maxGap: EXTRAP_MAX_S, tau: 0.08 };

  constructor(canvas: HTMLCanvasElement, clock: EngineClock) {
    this.canvas = canvas;
    const c = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!c) throw new Error('Canvas2D unavailable');
    this.ctx = c;
    this.clock = clock;
    this.lastT = clock.currentTime;
  }

  get stats(): FrameStats { return this.fs; }
  get videoRect(): Rect { return this.rect; }
  get liveCount(): number { return this.gfx.length; }
  /**
   * Calm state plus the cut ledger for the ?perf=1 detail line (`calm ready / cuts 3 (det 3) /
   * last cut 1.2s ago`). The controller concatenates this after the detector detail.
   */
  get calmDetail(): string {
    const c = this.cuts.info;
    const last = Number.isFinite(c.lastAt) ? `${Math.max(0, this.lastNow - c.lastAt).toFixed(1)}s ago` : '—';
    return `${this.calm.status} / cuts ${c.count}${c.detector ? ` (det ${c.detector})` : ''} / last cut ${last}`;
  }
  get calmState(): string { return this.calm.status; }
  /** Admission check for the director: heavy graphics still obey calm, but Kimi owns pacing. */
  get calmReady(): boolean { return this.calm.canAdmit(this.lastNow); }
  get calmReason(): string { return this.calm.status; }
  setDirectorActive(v: boolean): void { this.calm.setDirectorActive(v); }
  /** Rings currently born (used by the gallery to wait until the scene is populated). */
  get ringCount(): number { let n = 0; for (const a of this.anchors.values()) if (a.state === 'on') n++; return n; }
  /** Debug: ?players=all shows a ground marker for every tracked player. */
  setPlayersAll(v: boolean): void { this.playersAll = v; }

  // ---------- layout ----------
  setLayout(cssW: number, cssH: number, videoW: number, videoH: number, dpr: number, tier: Tier, showcase: boolean, fit: 'contain' | 'cover' = 'contain'): void {
    this.cssW = cssW; this.cssH = cssH;
    this.rect = fitRect(cssW, cssH, videoW, videoH, fit);
    this.tier = tier;
    this.showcase = showcase;
    const cap = this.quality >= 3 ? 2 : this.quality >= 2 ? 1.5 : 1;
    this.dpr = Math.min(Math.max(dpr, 1), cap);
    const w = Math.max(1, Math.round(cssW * this.dpr)), h = Math.max(1, Math.round(cssH * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.u = clamp(this.rect.w / 1280, 0.7, 1.7) * (showcase ? 1.25 : 1);
  }

  // ---------- inputs ----------
  setKit(a: string, b: string, edgeA = a, edgeB = b): void {
    this.kit = { A: hexToRgb(a), B: hexToRgb(b) };
    this.kitEdge = { A: hexToRgb(edgeA), B: hexToRgb(edgeB) };
  }

  setSnapshot(s: OverlaySnapshot, now = performance.now() / 1000): void {
    this.snap = s;
    // The brain's cut frame is cut-aware: the tracker has already parked the old IDs in the gallery.
    // Record its media time and release the detector's hold. (The controller calls engine.cut just
    // before this; dedupe there means no second snap.)
    if (s.cut) {
      if (now - this.cuts.cutAt > 0.05) this.cut(now, s.tMedia, 'brain');
      else this.cuts.noteMedia(s.tMedia);
      this.cutBlocked = false;
    }
    // A renderer-side cut is a display frame or two ahead of the brain. Snapshots still produced
    // from the old shot are dropped until the cut-aware FrameState arrives (or the short hold ends).
    if (this.cutBlocked) {
      if (now < this.cutBlockUntil) {
        for (const a of this.anchors.values()) a.tr = null;
        return;
      }
      this.cutBlocked = false;
    }
    if (s.liveness === 'CALIBRATING' || this.state === 'CALIBRATING') this.sawCalibration = true;
    const cal = s.teamsCalibrated;
    if (cal && !this.calibrated) {
      this.calibrated = true;
      this.calibStart = now;
      if (this.sawCalibration) this.lock = { t0: now + 0.02, done: false };
    }
    if (!cal && this.calibrated) this.calibrated = false;
    // Diagnostics arrive later than the picture: apply each detection at the CURRENT video time so the
    // drawn position does not jump when the snapshot lands (the correction springs out over ~80 ms).
    const tNow = this.clock.currentTime;
    const gm = s.globalMotion;
    const seen = new Set<number>();
    for (const tr of s.tracks) {
      if (tr.cls === 'ball') continue;
      // A snapshot produced before the last cut describes the previous shot: never rebuild its anchors.
      if (tr.tMedia < this.cuts.cutMedia - 1e-6) continue;
      seen.add(tr.id);
      let a = this.anchors.get(tr.id);
      if (!a) {
        a = this.makeAnchor(tr, now, gm);
        this.anchors.set(tr.id, a);
      }
      a.tr = tr;
      a.cls = tr.cls;
      a.margin = tr.teamMargin;
      a.team = tr.team;
      a.mo.observe(tr.foot[0], tr.foot[1], tr.tMedia, tr.vel[0], tr.vel[1], gm[0], gm[1], tNow);
      a.tw = tr.box[2] - tr.box[0];
      a.th = tr.box[3] - tr.box[1];
    }
    for (const a of this.anchors.values()) if (!seen.has(a.id)) a.tr = null;
    const b = s.ball;
    if (b.xy && s.tMedia >= this.cuts.cutMedia - 1e-6) {
      const lp = this.ball.lastXY;
      const dt = s.tMedia - this.ball.lastT;
      if (lp && dt > 0.02 && dt < 0.6) {
        // A light low-pass: one ball detection jump (deflection) must not become a wild extrapolation.
        this.ball.vx = 0.5 * this.ball.vx + 0.5 * ((b.xy[0] - lp[0]) / dt);
        this.ball.vy = 0.5 * this.ball.vy + 0.5 * ((b.xy[1] - lp[1]) / dt);
      } else if (!lp || dt >= 0.6) { this.ball.vx = 0; this.ball.vy = 0; }
      if (!this.ball.has) this.ball.mo.reset(b.xy[0], b.xy[1], s.tMedia, this.ball.vx, this.ball.vy, gm[0], gm[1]);
      else this.ball.mo.observe(b.xy[0], b.xy[1], s.tMedia, this.ball.vx, this.ball.vy, gm[0], gm[1], tNow);
      this.ball.has = true;
      this.ball.lastXY = [b.xy[0], b.xy[1]];
      this.ball.lastT = s.tMedia;
    }
  }

  setQuality(q: QualityLevel): void { this.quality = q; }
  setBallOut(v: boolean): void { this.ballOut = v; }

  /** Apply a source profile's latency-compensation tuning (game: shorter clamp, faster spring). */
  setExtrap(maxGap: number, tau: number): void {
    this.extrap = { maxGap, tau };
    for (const a of this.anchors.values()) a.mo.configure({ maxGap, tau });
  }

  setState(s: ViewState, now = performance.now() / 1000): void {
    const prev = this.state;
    if (s === prev) return;
    this.state = s;
    if (s === 'CALIBRATING') this.sweep = { t0: now, done: false };
    if (prev === 'CALIBRATING' && s !== 'CALIBRATING') this.sweep = null;
    if (s === 'REPLAY' && prev !== 'REPLAY') {
      this.snapAll(now);
      this.cutBall();
      this.holdUntil = now + 0.35;
      this.replayWipe = { t0: now, entering: true };
    }
    if (prev === 'REPLAY' && s !== 'REPLAY') {
      this.replayWipe = { t0: now, entering: false };
      this.cutBall();
    }
    if (s === 'CLOSE_UP' || s === 'COMMENTARY' || s === 'UNSUPPORTED' || s === 'OFF') this.exitAll(now, true);
    const was = prev === 'PAUSED' || prev === 'ASK';
    const is = s === 'PAUSED' || s === 'ASK';
    if (was && !is) for (const g of this.gfx) if (g.fromAsk) this.requestExit(g, now, true);
    if (was && !is) this.pending = this.pending.filter((p) => !p.fromAsk);
  }

  /**
   * Camera cut or seek: every world anchor snaps out in 80 ms; nothing tweens across a cut.
   * `mediaTime` is the video time of the cut frame (the renderer-side detector knows it exactly).
   * `source` separates the detector's cuts from the brain's FrameState.cut in the ?perf=1 line.
   */
  cut(now = performance.now() / 1000, mediaTime?: number, source: CutSource = 'brain'): void {
    // The monitor and the engine's own seek check can see the same discontinuity in the same frame.
    if (now - this.cuts.cutAt < 0.1) {
      if (mediaTime !== undefined) this.cuts.noteMedia(mediaTime);
      return;
    }
    this.snapAll(now);
    this.cuts.noteCut(now, mediaTime, source);
    if (mediaTime !== undefined && Number.isFinite(mediaTime)) {
      // A snapshot from before the cut must not rebuild anchors; wait for the brain's cut ack,
      // but never longer than the block (mock sources have no brain to acknowledge).
      if (source === 'detector' || source === 'seek') {
        this.cutBlocked = true;
        this.cutBlockUntil = now + CUT_BLOCK_S;
      }
    }
    this.holdUntil = now + CALM_CONFIG.markerAfterCutS;
    this.ball.hist.length = 0;
    this.ball.lastXY = null;
    this.ball.has = false;
    this.replayWipe = null;
  }

  /** Debug/test: cut count, detector share and the last cut media time. */
  get cutDebug(): { count: number; detector: number; lastAt: number; lastMedia: number; blocked: boolean } {
    const i = this.cuts.info;
    return { count: i.count, detector: i.detector, lastAt: i.lastAt, lastMedia: i.lastMedia, blocked: this.cutBlocked };
  }

  /** Debug/test: current marker state for one track id (null when it has no anchor). */
  markerDebug(id: number): { state: string; markerAlpha: number; alpha: number; lostAt: number | null } | null {
    const a = this.anchors.get(id);
    return a ? { state: a.state, markerAlpha: a.markerAlpha, alpha: a.alpha, lostAt: a.lostAt } : null;
  }

  /** Debug/test: number of live anchors (all states). */
  get anchorCount(): number { return this.anchors.size; }

  /** Replay is other footage: like a cut, the ball must not tween or trail across the transition. */
  private cutBall(): void {
    this.ball.hist.length = 0;
    this.ball.lastXY = null;
    this.ball.has = false;
  }

  pulse(ids: number[], now = performance.now() / 1000): void {
    for (const id of ids) { const a = this.anchors.get(id); if (a) a.pulseAt = now; }
  }

  setPrediction(p: Prediction, now = performance.now() / 1000): void {
    const old = this.predictions.get(p.id);
    this.predictions.set(p.id, p);
    const g = this.gfx.find((x) => x.intent.id === p.id);
    if (g && p.status !== 'open' && (!old || old.status === 'open')) g.resolvedAt = now;
  }

  setLag(id: string, ballXY: [number, number], lateS: number): void { this.lag.set(id, { ballXY, lateS }); }

  intent(i: GraphicIntent, now = performance.now() / 1000): void {
    if (BASE_TYPES.has(i.type)) return; // renderer-owned layers
    if (this.state === 'OFF' || this.state === 'COMMENTARY' || this.state === 'UNSUPPORTED' || this.state === 'CLOSE_UP' || this.state === 'CALIBRATING') return;
    if (this.quality === 0) return;
    if (this.quality === 1 && !['spotlight', 'tag'].includes(i.type)) return;
    if (this.tier === 'narrow' && (i.type === 'hull' || i.type === 'links' || i.type === 'line')) return;
    const ex = this.gfx.find((g) => g.intent.id === i.id);
    if (ex) { ex.intent = i; ex.exitReq = null; if (!ex.exitAt) return; }
    const fromAsk = this.state === 'ASK' || this.state === 'PAUSED';
    if (this.calm.isBypassed) {
      // Freeze-frame/telestrator/showcase keeps the original multi-graphic behaviour.
      this.pending = this.pending.filter((p) => p.intent.id !== i.id);
      this.pending.push({ intent: i, since: now, fromAsk });
    } else {
      // Calm policy: Kimi/director/rules all share one pending slot, so a burst of requests can never
      // queue up a wall of graphics. Only the newest survives; it is dropped after pendingMaxS.
      this.pending = [{ intent: i, since: now, fromAsk }];
    }
  }

  /** Explicit clear. No id = camera cut: everything snaps. With id: respects minimum on-time. */
  clear(id: string | undefined, now = performance.now() / 1000): void {
    if (id === undefined) { this.cut(now); return; }
    this.pending = this.pending.filter((p) => p.intent.id !== id);
    const g = this.gfx.find((x) => x.intent.id === id);
    if (g) this.requestExit(g, now, false);
  }

  // ---------- helpers ----------
  private makeAnchor(tr: OverlaySnapshot['tracks'][number], now: number, gm: [number, number] = [0, 0]): Anchor {
    const born = this.calibrated;
    const key = born && tr.cls !== 'referee' ? tr.team : 'N';
    const rgb = key === 'A' ? this.kit.A : key === 'B' ? this.kit.B : NEUTRAL_RGB;
    const mo = new Extrapolator({
      maxGap: this.extrap.maxGap, tau: this.extrap.tau,
      maxAccel: MARKER.motion.maxAccel, accelShare: MARKER.motion.accelShare, accelLeadMaxS: MARKER.motion.accelLeadMaxS,
    });
    mo.reset(tr.foot[0], tr.foot[1], tr.tMedia, tr.vel[0], tr.vel[1], gm[0], gm[1]);
    return {
      id: tr.id, cls: tr.cls, team: tr.team, margin: tr.teamMargin,
      mo, rw: { x: tr.box[2] - tr.box[0], v: 0 },
      tw: tr.box[2] - tr.box[0], th: tr.box[3] - tr.box[1],
      tr, missS: 0, state: 'pending', t0: now,
      colKey: key, colFrom: rgb, colT0: -10, lastChange: -10, pulseAt: -10,
      sx: 0, sy: 0, sr: 0, sh: 0, squash: 0.4, alpha: 0,
      fx: null, fy: null, fsize: null, drawX: null, drawY: null, drawR: 0, markerAlpha: 0, markerBoost: 0, lostAt: null,
    };
  }

  private teamRgb(key: string): RGB {
    if (key === 'A') return this.kit.A;
    if (key === 'B') return this.kit.B;
    return NEUTRAL_RGB;
  }

  private edgeRgb(key: string): RGB {
    if (key === 'A') return this.kitEdge.A;
    if (key === 'B') return this.kitEdge.B;
    return NEUTRAL_RGB;
  }

  private ringRgb(a: Anchor, now: number): RGB {
    const to = this.teamRgb(a.colKey);
    return mixRgb(a.colFrom, to, ease('micro', (now - a.colT0) / RULES.teamColourFade));
  }

  private snapAll(now: number): void {
    for (const a of this.anchors.values()) {
      if (a.state === 'on' && a.alpha > 0.02 && a.markerAlpha > 0.5) {
        this.dying.push({
          a, t0: now, dur: D.snap, sx: a.sx, sy: a.sy, sr: a.sr, squash: a.squash,
          rgb: this.ringRgb(a, now), edge: this.edgeRgb(a.colKey),
        });
      }
    }
    this.anchors.clear();
    for (const g of this.gfx) { g.exitReq = now; g.force = true; g.fast = true; if (g.exitAt === null) g.exitAt = now; }
    this.pending.length = 0;
    this.ball.shown = false;
  }

  private exitAll(now: number, force: boolean): void {
    for (const g of this.gfx) this.requestExit(g, now, force);
    this.pending.length = 0;
  }

  private requestExit(g: Gfx, now: number, force: boolean): void {
    if (g.exitReq === null) g.exitReq = now;
    if (force) g.force = true;
  }

  private anchorOk(id: number): Anchor | null {
    const a = this.anchors.get(id);
    return a && a.state === 'on' && a.missS < RULES.coast && a.alpha > 0.25 ? a : null;
  }

  private worldAllowed(): boolean {
    const s = this.state;
    return s === 'CALIBRATING' || s === 'LIVE' || s === 'REPLAY' || s === 'PAUSED' || s === 'ASK';
  }

  /** Inputs for the calm gate, measured from the latest 9 Hz snapshot. */
  private calmMetrics(s: OverlaySnapshot): CalmMetrics {
    const live = s.tracks.filter((tr) => tr.cls !== 'referee' && tr.timeSinceUpdate <= 0.4);
    const speeds: number[] = [];
    for (const tr of live) {
      // Player motion on the pitch, not the camera's share of it.
      speeds.push(motionPxS(tr.vel[0] - s.globalMotion[0], tr.vel[1] - s.globalMotion[1]));
    }
    speeds.sort((a, b) => a - b);
    const playerPxS = speeds.length ? speeds[speeds.length >> 1]! : 0;
    const stable = live.filter((tr) => tr.age >= CALM_CONFIG.stableAgeS).length;
    const ballOk = (s.ball.state === 'visible' && s.ball.xy !== null)
      || (s.ball.state === 'searching' && s.ball.coastingS <= CALM_CONFIG.ballSearchGraceS);
    return {
      wide: s.scene === 'WIDE' && s.liveness === 'LIVE',
      ballOk,
      cutAgoS: this.lastNow - this.cuts.cutAt,
      cameraPxS: motionPxS(s.globalMotion[0], s.globalMotion[1]),
      playerPxS,
      tracks: live.length,
      stableFraction: live.length ? stable / live.length : 0,
    };
  }

  /**
   * Which players get the calm ground marker: the ball carrier, their nearest opponent, and anyone
   * an active graphic or a Kimi mention points at — at most `playerMax` (debug ?players=all opts out).
   * `strong` is the subset drawn with the carrier/highlighted style (carrier and mentions, not the
   * merely-nearest opponent).
   */
  private markerSelection(s: OverlaySnapshot, now: number): { ids: Set<number>; strong: Set<number> } {
    const ids = new Set<number>();
    const strong = new Set<number>();
    if (this.playersAll) {
      for (const tr of s.tracks) if (tr.cls !== 'referee') ids.add(tr.id);
      return { ids, strong };
    }
    const live = s.tracks.filter((tr) => tr.cls !== 'referee' && tr.timeSinceUpdate <= 0.4);
    if (s.ball.xy && s.ball.state !== 'absent') {
      const bx = s.ball.xy[0], by = s.ball.xy[1];
      let carrier: OverlaySnapshot['tracks'][number] | null = null;
      let best = Infinity;
      for (const tr of live) {
        const d = Math.hypot((tr.foot[0] - bx) * 1.78, tr.foot[1] - by);
        if (d < best) { best = d; carrier = tr; }
      }
      const c = carrier;
      if (c) {
        ids.add(c.id);
        strong.add(c.id);
        if (c.team === 'A' || c.team === 'B') {
          let opp: OverlaySnapshot['tracks'][number] | null = null;
          let od = Infinity;
          for (const tr of live) {
            if (tr.team === c.team || tr.team === 'OTHER') continue;
            const d = Math.hypot((tr.foot[0] - c.foot[0]) * 1.78, tr.foot[1] - c.foot[1]);
            if (d < od) { od = d; opp = tr; }
          }
          if (opp) ids.add(opp.id);
        }
      }
    }
    const highlighted: number[] = [];
    for (const g of this.gfx) {
      if (g.exitAt !== null) continue;
      for (const id of g.intent.ids) highlighted.push(id);
    }
    for (const [id, a] of this.anchors) if (now - a.pulseAt < 4) highlighted.push(id);
    for (const id of highlighted) {
      if (ids.has(id)) { strong.add(id); continue; }
      if (ids.size >= CALM_CONFIG.playerMax) break;
      ids.add(id);
      strong.add(id);
    }
    return { ids, strong };
  }

  // ---------- admission (anti-flicker) ----------
  private tryAdmit(p: { intent: GraphicIntent; since: number; fromAsk: boolean }, now: number): 'ok' | 'wait' | 'drop' {
    const i = p.intent;
    const heavy = !BASE_TYPES.has(i.type) && !LIGHT_TYPES.has(i.type);
    const group = GROUP[i.type] ?? i.type;
    // Heavy graphics go through the calm gate: they wait for calm, never overlap a group, and respect
    // the clean gap. In freeze-frame/telestrator/showcase the gate is bypassed.
    if (heavy && !this.calm.isBypassed) {
      if (this.gfx.some((g) => g.heavy)) return now - p.since > CALM_CONFIG.pendingMaxS ? 'drop' : 'wait';
      if (!this.calm.canAdmit(now)) return now - p.since > CALM_CONFIG.pendingMaxS ? 'drop' : 'wait';
    }
    const act = this.gfx.filter((g) => g.exitAt === null);
    const prio = PRIORITY[i.type] ?? 1;
    let victim: Gfx | null = null;
    const sameType = act.find((g) => g.intent.type === i.type && (i.type === 'spotlight' || i.type === 'prediction'));
    if (sameType) victim = sameType;
    const groups = new Set(act.map((g) => GROUP[g.intent.type] ?? g.intent.type));
    if (!victim && !groups.has(group) && groups.size >= RULES.maxGroups) {
      let low: Gfx | null = null;
      for (const g of act) if (!low || (PRIORITY[g.intent.type] ?? 1) < (PRIORITY[low.intent.type] ?? 1)) low = g;
      if (low && (PRIORITY[low.intent.type] ?? 1) < prio) victim = low;
      else return 'drop';
    }
    if (!victim) {
      const le = this.lastExit.get(i.type);
      if (le !== undefined && now - le < RULES.minGapSameType) return 'wait';
    } else {
      if (now - victim.t0 < RULES.minOnWorld) return 'wait'; // higher priority waits out the minimum
      victim.exitReq = now; victim.exitAt = now; victim.force = true;
    }
    const need = this.requiredIds(i);
    if (need.some((id) => !this.anchorOk(id))) {
      return now - p.since > (heavy ? CALM_CONFIG.pendingMaxS : RULES.pendingMax) ? 'drop' : 'wait';
    }
    const calm = heavy && !this.calm.isBypassed;
    this.gfx.push({
      intent: i, t0: now, exitReq: null, exitAt: null, force: false, fast: false, fromAsk: p.fromAsk,
      resolvedAt: null, heavy, calm, group,
      carrierAtAdmit: this.snap?.match.passOptions.value.carrierId ?? -1,
    });
    if (calm) this.calm.admitted(now, group);
    return 'ok';
  }

  private requiredIds(i: GraphicIntent): number[] {
    switch (i.type) {
      case 'spotlight': case 'tag': case 'run': case 'pressure': return i.ids.slice(0, 1);
      case 'lanes': case 'switch': case 'prediction': return i.ids.slice(0, 1);
      case 'overload': return i.ids.slice(0, 2);
      default: return [];
    }
  }

  // ---------- frame ----------
  frame(now: number): void {
    const t0 = performance.now();
    const dt = this.lastNow ? clamp(now - this.lastNow, 0, 0.1) : 0.016;
    this.lastNow = now;
    const tNow = this.clock.currentTime;
    let dtM = tNow - this.lastT;
    if (dtM < -0.05 || dtM > 1.5) { this.cut(now, tNow, 'seek'); dtM = 0; }
    this.lastT = tNow;
    dtM = clamp(dtM, 0, 0.5);

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    const s = this.snap;
    if (!s || this.rect.w <= 0) { this.fs.lastMs = 0; return; }

    const R = this.rect, u = this.u;
    const P = (nx: number, ny: number): Pt => [R.x + nx * R.w, R.y + ny * R.h];
    const gm = s.globalMotion;
    // The canvas frame drawn now is presented about one display frame later; extrapolate that far
    // (in video time, so a 2x playback gets two video seconds per wall second). Paused: no lead.
    const displayLead = this.clock.paused ? 0 : MARKER.motion.displayLeadS * (s.playbackRate > 0 ? s.playbackRate : 1);
    const tDisplay = tNow + displayLead;

    // Calm gate: measured once per render frame from the latest snapshot (9 Hz data, 60 Hz timers).
    const bypass = this.showcase || this.state === 'PAUSED' || this.state === 'ASK';
    this.calm.setBypass(bypass);
    this.calm.update(now, this.calmMetrics(s));

    // Fast pans and cuts hide the player layer; hysteresis stops it strobing at the threshold.
    const panPx = motionPxS(gm[0], gm[1]);
    if (panPx > CALM_CONFIG.markerFastPanPxS) this.markerPan = true;
    else if (panPx < CALM_CONFIG.markerFastPanExitPxS) this.markerPan = false;
    const markerTarget = this.cuts.layerTarget(now, this.markerPan);
    this.markerFade += clamp(markerTarget - this.markerFade, -dt / 0.18, dt / 0.25);
    this.markerFade = clamp(this.markerFade, 0, 1);

    const worldOn = this.worldAllowed() && this.quality > 0;
    const ringsOn = worldOn && this.state !== 'CLOSE_UP';
    // Exits are a snap: a CLOSE/REPLAY scene change takes the player layer down in <= 80 ms instead
    // of coasting the lost tracks for 300 ms. Entrances keep the slower broadcast ramp.
    this.ringA = clamp(this.ringA + (ringsOn ? dt / D.enter : -dt / D.snap), 0, 1);

    const dimTarget = this.state === 'PAUSED' || this.state === 'ASK' ? 0.18 : 0;
    const rate = dimTarget > this.pauseDim ? 0.18 / D.scene : 0.18 / D.exit;
    this.pauseDim = dimTarget > this.pauseDim ? Math.min(dimTarget, this.pauseDim + rate * dt) : Math.max(dimTarget, this.pauseDim - rate * dt);

    // calibration sweep
    let sweepP = 2;
    if (this.sweep && !this.sweep.done) {
      const k = (now - this.sweep.t0) / D.scene;
      sweepP = ease('scene', k);
      if (k >= 1) this.sweep.done = true;
    }
    // lock-on sweep as team colours resolve
    let lockP = 2;
    if (this.lock && !this.lock.done) {
      const k = (now - this.lock.t0) / 0.62;
      lockP = ease('scene', k);
      if (k >= 1) this.lock.done = true;
    }
    const scanX = this.lock && !this.lock.done ? R.x + lockP * R.w : -1;

    // ----- anchors -----
    const selected = this.markerSelection(s, now);
    // After a cut the old shot has already snapped out; the new shot gets 2 s of looser rules so a
    // player can be marked after two or three detections instead of a full second.
    const spawnBirth = this.cuts.birthAgeS(now);
    const spawnAge = this.cuts.minAgeS(now);
    const spawnFadeIn = this.cuts.fadeInS(now);
    const list: Anchor[] = [];
    for (const [id, a] of this.anchors) {
      const tr = a.tr;
      if (tr) a.missS = tr.timeSinceUpdate;
      else a.missS += dtM;
      // Extrapolate the detection to the presented frame; the correction spring absorbs the error with
      // each new detection, so the ring sits on the player instead of following a moving spring target.
      const pred = a.mo.read(tDisplay, dt, gm[0], gm[1]);
      springStep(a.rw, a.tw, D.followSize, dt);

      if (a.state === 'pending') {
        const ok = tr && tr.age >= spawnBirth && now >= this.holdUntil && worldOn && !(pred.x > sweepP && this.sweep && !this.sweep.done);
        if (ok) { a.state = 'on'; a.t0 = now; }
      }
      // colour key with hysteresis
      if (a.state === 'on' || a.state === 'pending') {
        const want = this.calibrated && a.cls !== 'referee' && a.team !== 'OTHER' ? a.team : 'N';
        if (want !== a.colKey) {
          const initial = a.colKey === 'N';
          if (initial || (now - a.lastChange >= RULES.teamColourMinGap && a.margin >= 0.2)) {
            a.colFrom = this.ringRgb(a, now);
            a.colKey = want;
            a.colT0 = initial ? Math.max(now, this.calibStart + (want === 'B' ? 0.15 : 0)) : now;
            a.lastChange = now;
          }
        }
      }
      if (a.state === 'pending') {
        if (a.missS > RULES.coast + RULES.coastFade) this.anchors.delete(id);
        continue;
      }
      let alpha = clamp((now - a.t0) / 0.2, 0, 1);
      if (a.missS > RULES.coast) {
        alpha *= 1 - (a.missS - RULES.coast) / RULES.coastFade;
        if (alpha <= 0) { this.anchors.delete(id); continue; }
      }
      a.alpha = alpha * this.ringA;

      // Screen-space One Euro after the Extrapolator: strong smoothing at rest, low lag in a sprint.
      // The tracker's velocity is the speed signal, so the cutoff opens at the start of an acceleration
      // instead of waiting for the filter's own derivative to catch up. A high cap then only guards
      // against a detector glitch or a resize; it never limits a real sprint (was 720 px/s).
      const p = P(pred.x, pred.y);
      if (!a.fx || !a.fy || !a.fsize) {
        a.fx = new OneEuroFilter({ minCutoff: MARKER.filter.minCutoffHz, beta: MARKER.filter.beta, dCutoff: MARKER.filter.dCutoffHz });
        a.fy = new OneEuroFilter({ minCutoff: MARKER.filter.minCutoffHz, beta: MARKER.filter.beta, dCutoff: MARKER.filter.dCutoffHz });
        a.fsize = new OneEuroFilter({ minCutoff: MARKER.filter.sizeMinCutoffHz, beta: MARKER.filter.sizeBeta });
        a.fx.reset(p[0]); a.fy.reset(p[1]);
        const r0 = Math.max(a.rw.x * R.w * 0.62, 7 * u);
        a.fsize.reset(r0); a.drawR = r0;
      }
      const speedPxS = tr && tr.timeSinceUpdate <= 0.35 ? Math.hypot(tr.vel[0] * R.w, tr.vel[1] * R.h) : 0;
      const targetX = a.fx.filter(p[0], dt, speedPxS);
      const targetY = a.fy.filter(p[1], dt, speedPxS);
      if (a.drawX === null || a.drawY === null) { a.drawX = targetX; a.drawY = targetY; }
      else {
        let dx = targetX - a.drawX, dy = targetY - a.drawY;
        const d = Math.hypot(dx, dy), maxStep = MARKER.motion.maxPxS * dt;
        if (d > maxStep && d > 0) { dx = (dx / d) * maxStep; dy = (dy / d) * maxStep; }
        a.drawX += dx; a.drawY += dy;
      }
      a.sx = a.drawX; a.sy = a.drawY;
      a.sr = Math.max(a.rw.x * R.w * 0.62, 7 * u);
      const targetR = a.fsize.filter(a.sr, dt);
      a.drawR += clamp(targetR - a.drawR, -180 * dt, 180 * dt);
      a.sh = Math.max(a.th * R.h, 20 * u);
      // perspective: nearer the bottom and taller the box -> rounder ellipse
      const yf = clamp((a.sy - R.y) / R.h, 0, 1);
      const hf = clamp(a.sh / (R.h * 0.22), 0, 1.5);
      const near = clamp(0.18 + 0.58 * yf + 0.24 * (hf - 0.5), 0, 1);
      a.squash = lerp(0.24, 0.56, near);

      // Calm marker lifecycle: born only after a confident second; coast 300 ms on loss, then fade.
      // In the post-cut window the age/fade rule is the faster one from MarkerCutPolicy.
      const confident = !!tr && tr.age >= spawnAge && tr.score >= CALM_CONFIG.playerConfidence && tr.timeSinceUpdate <= 0.35;
      if (selected.ids.has(id) && confident) {
        a.lostAt = null;
        a.markerAlpha = Math.min(1, a.markerAlpha + dt / spawnFadeIn);
      } else {
        const lost = !tr || tr.timeSinceUpdate > 0.35;
        if (lost) {
          a.lostAt ??= now;
          if (now - a.lostAt >= CALM_CONFIG.markerLostCoastS) {
            a.markerAlpha = Math.max(0, a.markerAlpha - dt / CALM_CONFIG.markerLostFadeS);
          }
        } else {
          a.markerAlpha = Math.max(0, a.markerAlpha - dt / spawnFadeIn);
        }
      }
      // Carrier/highlighted style cross-fades; it must not pop when possession changes.
      const wantBoost = selected.strong.has(id) ? 1 : 0;
      a.markerBoost += (wantBoost - a.markerBoost) * (1 - Math.exp(-dt / MARKER.strongTauS));
      list.push(a);
    }

    // ----- dim layer (spotlight + freeze) -----
    this.updateGfx(now, tNow);
    const holes: { x: number; y: number; r: number }[] = [];
    let spotDim = 0;
    for (const g of this.gfx) {
      if (g.intent.type !== 'spotlight') continue;
      const pin = ease('enter', (now - g.t0) / (g.calm ? CALM_CONFIG.fadeInS : D.enter));
      const q = g.exitAt === null ? 0 : ease('exit', (now - g.exitAt) / (g.fast ? D.snap : g.calm ? CALM_CONFIG.fadeOutS : D.fade));
      const k = pin * (1 - q);
      spotDim = Math.max(spotDim, 0.35 * k);
      for (const id of g.intent.ids) {
        const a = this.anchors.get(id);
        if (a && a.state === 'on') holes.push({ x: a.sx, y: a.sy, r: Math.max(a.sr * 1.55, a.sh * 0.45) });
      }
    }
    drawDim(ctx, R.x, R.y, R.w, R.h, Math.max(spotDim, this.pauseDim), spotDim > 0.003 ? holes : []);
    if (this.pauseDim > 0.01) drawFreeze(ctx, R, this.pauseDim / 0.18, u);

    // ----- shape layers (below rings) -----
    for (const g of this.gfx) {
      const t = g.intent.type;
      if (t === 'hull' || t === 'line' || t === 'pocket' || t === 'links') this.drawGfx(g, now, list, P, u);
    }

    // dying anchors (cuts): a short low-opacity ground ghost, never a full ring
    for (const d of this.dying) {
      const k = (now - d.t0) / d.dur;
      if (k < 1) drawGroundMarker(ctx, d.sx, d.sy, d.sr, d.squash, d.rgb, d.edge, (1 - k) * 0.55, u);
    }
    this.dying = this.dying.filter((d) => now - d.t0 < d.dur);

    // ----- calm player layer: only the selected few, no labels -----
    // No worldOn gate here: ringA already fades the layer out on CLOSE/OFF, so the scene change is a
    // 80 ms fade rather than a hard disappearance (and the anchors stay ready for the next shot).
    for (const a of list) {
      const alpha = a.markerAlpha * this.markerFade * this.ringA;
      if (alpha <= 0.01) continue;
      if (this.lock && !this.lock.done) {
        const passed = clamp((scanX - a.sx) / (R.w * 0.055), 0, 1);
        if (passed <= 0.01) continue;
        drawGroundMarker(ctx, a.sx, a.sy, a.drawR, a.squash, this.ringRgb(a, now), this.edgeRgb(a.colKey), alpha * passed, u, a.markerBoost);
        continue;
      }
      drawGroundMarker(ctx, a.sx, a.sy, a.drawR, a.squash, this.ringRgb(a, now), this.edgeRgb(a.colKey), alpha, u, a.markerBoost);
    }

    // ----- ball -----
    // Hidden for viewers (the ball is easy to follow); tracking still feeds the engine and Kimi. Debug: ?ball=show
    if (SHOW_BALL_MARKER) this.drawBall(now, tDisplay, dt, s, u, P);

    // ----- foreground gfx -----
    for (const g of this.gfx) {
      const t = g.intent.type;
      if (!(t === 'hull' || t === 'line' || t === 'pocket' || t === 'links')) this.drawGfx(g, now, list, P, u);
    }

    // calibration / lock-on scan lines
    if (this.lock && !this.lock.done) {
      drawScan(ctx, scanX, R.y, R.y + R.h, 1, u);
    } else if (this.sweep && !this.sweep.done && this.state === 'CALIBRATING') {
      drawScan(ctx, R.x + sweepP * R.w, R.y, R.y + R.h, 1, u);
    } else if (this.state === 'CALIBRATING' && !this.calibrated) {
      const k = ((now - (this.sweep?.t0 ?? now)) % 2.2) / 2.2;
      drawScan(ctx, R.x + ease('scene', k) * R.w, R.y, R.y + R.h, 0.34, u);
    }

    // branded replay wipe, on top of everything in-world
    if (this.replayWipe) {
      const p = (now - this.replayWipe.t0) / D.wipe;
      if (p >= 1) this.replayWipe = null;
      else drawReplayWipe(ctx, R, p, this.replayWipe.entering, this.kit.A, this.kit.B, u);
    }

    const ms = performance.now() - t0;
    this.fs.lastMs = ms;
    this.fs.avgMs = this.fs.avgMs * 0.95 + ms * 0.05;
    this.fs.maxMs = Math.max(this.fs.maxMs * 0.995, ms);
    void this.seedMarch;
  }

  private drawBall(now: number, tDisplay: number, dt: number, s: OverlaySnapshot, u: number, P: (x: number, y: number) => Pt): void {
    const b = this.ball, ctx = this.ctx;
    const bs = s.ball;
    const visible = !this.ballOut && this.worldAllowed() && this.state !== 'CLOSE_UP' && bs.state !== 'absent' && bs.xy !== null;
    // Same latency compensation as the rings: the ball is drawn at the presented frame, not at the stale
    // detection time, so a cross or a shot does not trail by a fifth of a second.
    const bp = b.mo.read(tDisplay, dt, s.globalMotion[0], s.globalMotion[1]);
    const target = visible ? (bs.state === 'searching' ? 0.42 : 1) : 0;
    if (visible && !b.shown) { b.shown = true; b.popT0 = now; }
    if (!visible && b.alpha <= 0.01) b.shown = false;
    b.alpha = target > b.alpha ? Math.min(target, b.alpha + dt / 0.12) : Math.max(target, b.alpha - dt / D.fade);
    if (b.alpha <= 0.01 || !b.has) return;
    const pt = P(bp.x, bp.y);
    b.drawn = pt;
    if (this.quality >= 3 && visible) {
      b.hist.push({ x: pt[0], y: pt[1], t: now });
      while (b.hist.length && now - b.hist[0]!.t > 0.6) b.hist.shift();
    } else b.hist.length = 0;
    const trail = b.hist.map((h) => ({ x: h.x, y: h.y, age: now - h.t }));
    const scale = lerp(0.45, 1, ease('emphasis', (now - b.popT0) / D.emphasis));
    drawBall(ctx, pt[0], pt[1], 4.1 * u, b.alpha, scale, trail, u);
  }

  /**
   * A carrier-bound graphic is only useful while that player still has the ball. When possession
   * moves, exit immediately instead of waiting for the TTL: a key-pass lane on the old carrier is
   * noise once the ball is gone.
   */
  private carrierChanged(g: Gfx): boolean {
    const s = this.snap;
    const i = g.intent;
    if (!s || s.liveness !== 'LIVE') return false;
    // Showcase / freeze-frame / telestrator keep their scripted or frozen graphic even if the
    // underlying mock carrier is mid-pass.
    if (this.calm.isBypassed) return false;
    if (s.ball.state === 'absent') return true;
    const carrier = s.match.passOptions.value.carrierId;
    if (!Number.isInteger(carrier) || carrier < 0) return true;
    if (!i.ids.length) return false;
    switch (i.type) {
      // Focus graphics only expire when they were actually about the carrier at admission. A
      // scripted "free man" tag is allowed to stay on its player.
      case 'tag':
        return g.carrierAtAdmit >= 0 && i.ids[0] === g.carrierAtAdmit && carrier !== g.carrierAtAdmit;
      case 'spotlight':
        return g.carrierAtAdmit >= 0 && i.ids.includes(g.carrierAtAdmit) && !i.ids.includes(carrier);
      case 'lanes': case 'pressure': case 'switch': return i.ids[0] !== carrier;
      default: return false;
    }
  }

  // ---------- gfx lifecycle ----------
  private updateGfx(now: number, tNow: number): void {
    if (this.pending.length) {
      this.pending.sort((a, b) => (PRIORITY[b.intent.type] ?? 1) - (PRIORITY[a.intent.type] ?? 1));
      const keep: typeof this.pending = [];
      for (const p of this.pending) {
        const maxS = BASE_TYPES.has(p.intent.type) ? RULES.pendingMax : CALM_CONFIG.pendingMaxS;
        if (now - p.since > maxS || !this.worldAllowed()) continue;
        const r = this.tryAdmit(p, now);
        if (r === 'wait') keep.push(p);
      }
      this.pending = keep;
    }
    // The calm gate owns the heavy group's show window: calm break (after grace), or max hold.
    if (this.calm.shouldEnd(now)) {
      for (const g of this.gfx) if (g.calm && g.exitAt === null) this.requestExit(g, now, false);
    }
    for (const g of this.gfx) {
      const i = g.intent;
      if (g.exitReq === null && this.carrierChanged(g)) { g.exitReq = now; g.force = true; }
      if (g.exitReq === null) {
        const holdLocked = g.calm && now - g.t0 < CALM_CONFIG.holdMinS;
        if (!holdLocked && tNow >= i.enteredAt + i.ttlS && i.ttlS > 0) g.exitReq = now;
        else if (this.requiredIds(i).some((id) => !this.anchorOk(id))) { g.exitReq = now; g.force = true; }
        else if (i.type === 'prediction') {
          const p = this.predictions.get(i.id);
          if (g.resolvedAt === null && p && p.status !== 'open') g.resolvedAt = now;
          if (g.resolvedAt !== null && now - g.resolvedAt > 1.0) g.exitReq = now;
        }
      }
      if (g.exitReq !== null && g.exitAt === null) {
        if (g.force || now - g.t0 >= RULES.minOnWorld) g.exitAt = Math.max(now, g.exitReq);
      }
    }
    this.gfx = this.gfx.filter((g) => {
      if (g.exitAt === null) return true;
      const dur = g.fast ? D.snap : g.calm ? CALM_CONFIG.fadeOutS : (EXIT_DUR[g.intent.type] ?? D.fade);
      if (now - g.exitAt >= dur) { this.lastExit.set(g.intent.type, now); return false; }
      return true;
    });
    // Only once the picture is clean does the 8 s gap start.
    if (this.calm.activeGroup && !this.gfx.some((g) => g.heavy)) this.calm.ended(now);
  }

  private team(g: Gfx): 'A' | 'B' {
    const t = g.intent.team;
    if (t) return t;
    const a = g.intent.ids.length ? this.anchors.get(g.intent.ids[0]!) : undefined;
    return a && a.team === 'B' ? 'B' : 'A';
  }

  /** Smooth formation curves from shape line groups, else from screen columns of players. */
  private formationLines(t: 'A' | 'B', list: Anchor[]): FormationLine[] {
    const shape = this.snap?.match.shape[t];
    const conf = clamp((shape?.confidence ?? 0.9) * (shape?.gate === 'held' ? 0.55 : shape?.gate === 'hidden' ? 0.3 : 1), 0.1, 1);
    const groups = (shape?.value.lines ?? [])
      .map((ids) => ids.map((id) => this.anchors.get(id)).filter((a): a is Anchor => !!a && a.state === 'on'))
      .filter((g) => g.length >= 2);
    let lines: FormationLine[];
    if (groups.length) {
      lines = groups.map((as, i) => ({
        pts: as.slice().sort((a, b) => a.sx - b.sx).map((a): Pt => [a.sx, a.sy]),
        confidence: conf,
        emphasis: i === 0,
      }));
    } else {
      const mine = list.filter((a) => a.team === t && a.cls === 'player').sort((a, b) => a.sx - b.sx);
      const cols: Anchor[][] = [];
      for (const a of mine) {
        const last = cols[cols.length - 1];
        if (!last || Math.abs(a.sx - last[last.length - 1]!.sx) > this.rect.w * 0.075) cols.push([a]);
        else last.push(a);
      }
      const wide = cols.filter((c) => c.length >= 3);
      const dir = this.snap?.match.attackDir;
      const aRight = dir && dir.confidence > 0.3 && dir.A !== 'unknown' ? dir.A === 'right' : true;
      const backFirst = t === 'A' ? aRight : !aRight;
      lines = (wide.length ? wide : cols).map((as, i) => ({
        pts: as.map((a): Pt => [a.sx, a.sy]),
        confidence: conf,
        emphasis: backFirst ? i === 0 : i === (wide.length ? wide : cols).length - 1,
      }));
      if (!lines.length) return [];
    }
    return lines;
  }

  private drawGfx(g: Gfx, now: number, list: Anchor[], P: (x: number, y: number) => Pt, u: number): void {
    const ctx = this.ctx, i = g.intent;
    const dur = g.calm ? CALM_CONFIG.fadeInS : (ENTER_DUR[i.type] ?? D.enter);
    const pin = ease(i.type === 'hull' || i.type === 'line' || i.type === 'pocket' ? 'scene' : 'enter', (now - g.t0) / dur);
    const eDur = g.fast ? D.snap : g.calm ? CALM_CONFIG.fadeOutS : (EXIT_DUR[i.type] ?? D.fade);
    const q = g.exitAt === null ? 0 : ease('exit', (now - g.exitAt) / eDur);
    const alpha = 1 - q;
    const team = this.team(g);
    const colour: RGB = i.source === 'kimi' ? ACCENT_RGB : this.kit[team];
    const fontPx = (this.tier === 'full' ? 12 : 11) * (this.showcase ? 1.25 : 1) * clamp(this.rect.w / 1280, 0.9, 1.5);
    const first = i.ids.length ? this.anchors.get(i.ids[0]!) : undefined;
    const on = (a: Anchor | undefined): a is Anchor => !!a && a.state === 'on' && a.alpha > 0.1;
    const opp = (t: 'A' | 'B'): Anchor[] => list.filter((a) => a.cls !== 'referee' && a.team !== 'OTHER' && a.team !== t);

    switch (i.type) {
      case 'spotlight': {
        const pulse = (Math.sin(now * 2.1) + 1) / 2;
        for (const id of i.ids) {
          const a = this.anchors.get(id);
          if (!on(a)) continue;
          drawSpotRing(ctx, a.sx, a.sy, a.sr, a.squash, ease('enter', (now - g.t0) / 0.3), alpha, u, i.source === 'kimi' ? ACCENT_RGB : this.ringRgb(a, now), pulse);
        }
        break;
      }
      case 'tag': {
        if (!on(first)) break;
        const max = this.tier === 'full' ? 18 : 12;
        const label = (i.label ?? '').slice(0, max);
        const plate = i.source === 'kimi' ? ACCENT_RGB : this.ringRgb(first, now);
        // top 24% is the scorebar / status band: put the tag below the player there
        const below = first.sy - first.sh - 6 * u < this.rect.y + this.rect.h * 0.24;
        const ty = below ? first.sy + 4 * u : first.sy - first.sh - 6 * u;
        drawTag(ctx, first.sx, ty, label, clamp((now - g.t0) / 0.3, 0, 1), alpha, u, fontPx, first.sx > this.rect.x + this.rect.w * 0.8, plate, INK_RGB, below);
        break;
      }
      case 'lanes': {
        if (!on(first)) break;
        const opts = this.snap?.match.passOptions.value.targets ?? [];
        const t = this.team(g);
        const foes = opp(t);
        i.ids.slice(1, 4).forEach((id, idx) => {
          const b = this.anchors.get(id);
          if (!on(b)) return;
          const p = ease('enter', (now - g.t0 - idx * D.stagger) / dur);
          const score = opts.find((o) => o.id === id)?.score ?? [0.85, 0.55, 0.35][idx] ?? 0.3;
          const w = (1.7 + 3.6 * clamp(score, 0, 1)) * u;
          let blocked = false;
          for (const f of foes) {
            if (distToSegment(f.sx, f.sy, first.sx, first.sy, b.sx, b.sy) < Math.max(11 * u, f.sr * 0.5)) { blocked = true; break; }
          }
          drawLane(ctx, [first.sx, first.sy - 3 * u], [b.sx, b.sy - 3 * u], p, q, alpha, w, colour, blocked, u, idx * 0.33, now);
        });
        break;
      }
      case 'switch': {
        const b = i.ids[1] !== undefined ? this.anchors.get(i.ids[1]) : undefined;
        if (!on(first) || !on(b)) break;
        drawSwitch(ctx, [first.sx, first.sy - 4 * u], [b.sx, b.sy - 4 * u], pin, q, alpha, colour, u, now);
        break;
      }
      case 'prediction': {
        const b = i.ids[1] !== undefined ? this.anchors.get(i.ids[1]) : undefined;
        if (!on(first) || !on(b)) break;
        const pr = this.predictions.get(i.id);
        const status = pr?.status ?? 'open';
        const rp = g.resolvedAt === null ? 0 : clamp((now - g.resolvedAt) / 0.3, 0, 1);
        drawPrediction(ctx, [first.sx, first.sy - 4 * u], [b.sx, b.sy - 4 * u], pin, alpha, status, now * 2.2, rp, u);
        break;
      }
      case 'hull': {
        const t = this.team(g);
        const pts = list.filter((a) => a.team === t && a.cls === 'player' && a.state === 'on').map((a): Pt => [a.sx, a.sy]);
        const hull = convexHull(pts);
        if (hull.length >= 3) drawHull(ctx, hull, pin, alpha, this.kit[t], u);
        break;
      }
      case 'line': {
        const t = this.team(g);
        const lines = this.formationLines(t, list);
        if (lines.length) drawFormation(ctx, lines, pin, alpha, this.kit[t], u);
        break;
      }
      case 'pocket': {
        const as = i.ids.map((id) => this.anchors.get(id)).filter(on);
        if (as.length < 2) break;
        const cx = as.reduce((s, a) => s + a.sx, 0) / as.length, cy = as.reduce((s, a) => s + a.sy, 0) / as.length;
        const r = Math.max(...as.map((a) => Math.hypot(a.sx - cx, a.sy - cy))) * 0.9;
        drawPocket(ctx, cx, cy, r, pin, alpha, colour);
        break;
      }
      case 'overload': {
        const as = i.ids.map((id) => this.anchors.get(id)).filter(on);
        if (as.length < 2) break;
        const x0 = Math.min(...as.map((a) => a.sx - a.sr)) - 10 * u, x1 = Math.max(...as.map((a) => a.sx + a.sr)) + 10 * u;
        const y0 = Math.min(...as.map((a) => a.sy - a.sh)) - 8 * u, y1 = Math.max(...as.map((a) => a.sy)) + 10 * u;
        const t = this.team(g);
        let n = 0, m = 0;
        for (const a of list) {
          if (a.cls === 'referee' || a.sx < x0 || a.sx > x1 || a.sy < y0 || a.sy > y1) continue;
          if (a.team === t) n++; else if (a.team !== 'OTHER') m++;
        }
        const text = `${Math.round(n * pin)} v ${Math.round(m * pin)}`;
        drawOverload(ctx, x0, y0, x1, y1, pin, alpha, text, colour, u, fontPx);
        break;
      }
      case 'links': {
        const t = this.team(g);
        const foes = opp(t);
        const mine = list.filter((a) => a.team === t && a.cls === 'player');
        const pulse = (now % 1.2) / 1.2;
        const labelFor = (a: Anchor, b: Anchor): string => {
          const px = Math.hypot(a.sx - b.sx, a.sy - b.sy);
          if (px < 52 * u) return '';
          const m = px / Math.max(8, ((a.sh + b.sh) / 2) / 1.8);
          return distanceLabel(m);
        };
        if (i.ids.length >= 2) {
          for (let k = 0; k + 1 < i.ids.length; k += 2) {
            const a = this.anchors.get(i.ids[k]!), d = this.anchors.get(i.ids[k + 1]!);
            if (!on(a) || !on(d)) continue;
            drawLink(ctx, [a.sx, a.sy], [d.sx, d.sy], alpha * pin, colour, u, 0, labelFor(a, d));
          }
          break;
        }
        const pairs: { a: Anchor; b: Anchor; d: number }[] = [];
        for (const a of mine) {
          let best: Anchor | null = null, bd = Infinity;
          for (const f of foes) { const d = Math.hypot(f.sx - a.sx, f.sy - a.sy); if (d < bd) { bd = d; best = f; } }
          if (best) pairs.push({ a, b: best, d: bd });
        }
        // labels only on the tightest marking pairs; the rest stay thin lines
        pairs.sort((x, y) => x.d - y.d);
        pairs.forEach((p, idx) => drawLink(
          ctx, [p.a.sx, p.a.sy], [p.b.sx, p.b.sy], alpha * pin, colour, u,
          p.d > p.a.sh * 2.3 ? pulse : 0, idx < 3 ? labelFor(p.a, p.b) : '',
        ));
        break;
      }
      case 'run': {
        if (!on(first) || !first.tr) break;
        const gm = this.snap?.globalMotion ?? [0, 0];
        const dir: Pt = [first.tr.vel[0] - gm[0], first.tr.vel[1] - gm[1]];
        drawRun(ctx, [first.sx, first.sy], dir, 58 * u, pin, alpha, colour, u);
        break;
      }
      case 'pressure': {
        if (!on(first)) break;
        const foes = opp(first.team === 'B' ? 'B' : 'A');
        const n = Math.min(8, foes.filter((f) => Math.hypot(f.sx - first.sx, f.sy - first.sy) < first.sh * 2.8).length);
        drawPressure(ctx, first.sx, first.sy, first.sr, first.squash, n, pin, alpha, NEUTRAL_RGB, u);
        break;
      }
      case 'lag_ghost': {
        const lg = this.lag.get(i.id);
        if (!lg) break;
        const b = this.ball;
        const now2: Pt | null = b.has && b.alpha > 0.1 ? b.drawn : null;
        drawLagGhost(ctx, P(lg.ballXY[0], lg.ballXY[1]), now2, pin, alpha, `ball was here ${lg.lateS.toFixed(1)} s ago`, u, fontPx);
        break;
      }
      default:
        break;
    }
  }
}
