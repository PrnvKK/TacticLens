// Player tracker v2: ByteTrack-style high/low association + OC-SORT observation momentum, camera-motion
// compensation from sparse optical flow, a cut gallery, edge re-entry and a time-based max age.
//
// The visible ID is allocated only when a track is confirmed (2 hits in a 3-frame window). A confirmed track
// first tries the cut gallery, so returning to the same shot keeps its ID. During REPLAY/CLOSE and for 0.2 s
// after a hard cut no new IDs are allocated. After longBreakS without WIDE play the gallery is dropped and
// numbering restarts at 1.
import type { SceneKind, Team, Track } from '../types';
import { iou } from '../perception/decode';
import { Kalman1D } from './kalman';
import { hungarian } from './hungarian';
import { CameraFlow, warpBox, type Box4, type CameraMotion, type GreyFrame } from './camera';
import type { PersonCls, PersonDet } from './person';
import type { SourceProfile } from './profile';

const ASPECT = 16 / 9;

// core is DOM-free and has no "dom" lib; both Chrome and Node expose globalThis.performance.
const CLOCK = (globalThis as unknown as { performance?: { now(): number } }).performance;
const nowMs = (): number => (CLOCK ? CLOCK.now() : Date.now());

export interface TrackerV2Opts {
  highScore: number;          // first-pass detections
  lowScore: number;           // second-pass detections (never start a track)
  matchIou: number;           // first-pass IoU gate
  lowMatchIou: number;        // second-pass IoU gate
  centreGate: number;         // centre-distance gate, x box height
  maxAgeS: number;            // time-based coast horizon
  maxGapS: number;            // larger frame gap = seek/stall, drop the active set
  minHits: number;            // confirmation hits inside hitWindow
  hitWindow: number;          // frames considered for confirmation (2 of 3)
  noBirthAfterCutS: number;   // no visible ID may be allocated for this long after a hard cut
  momentumWeight: number;     // OC-SORT direction term in the association cost
  teamPenalty: number;        // soft team-mismatch penalty in the association cost
  reupdateGapS: number;       // re-update the Kalman after this much occlusion
  galleryTtlS: number;
  galleryMax: number;
  galleryPosGateH: number;    // plausible-position gate, x box height
  galleryHistMin: number;     // Bhattacharyya similarity needed to reuse a gallery ID
  edgeMargin: number;         // last centre within this fraction of the frame edge
  edgeDetMargin: number;      // re-entry detection within this fraction of any edge
  edgeWindowS: number;        // time a dormant edge track can be revived
  edgeHeightTol: number;      // +/- relative box-height tolerance
  edgeHistMin: number;        // torso+shorts colour similarity for edge re-entry
  longBreakS: number;         // no WIDE play for this long: clear gallery, restart numbering at 1
  posQVel: number;            // Kalman velocity process noise for cx/cy
  boxWQVel: number;           // Kalman velocity process noise for box width
  boxHQVel: number;           // Kalman velocity process noise for box height
  boxSmoothAlpha: number;     // EMA on box size, separate from position (0 = off)
  camLevels: number;          // camera-flow pyramid levels
  camMaxShiftFrac: number;    // camera-flow max per-cycle shift, x min(w, h)
}

export const DEFAULT_TRACKER_V2: TrackerV2Opts = {
  highScore: 0.5, lowScore: 0.1, matchIou: 0.25, lowMatchIou: 0.25, centreGate: 1.2,
  // The renderer now reports the cut on the displayed frame, so the reset lands on the exact next
  // detection. A long birth suppression would then only delay the new shot's markers (was 0.2 s).
  maxAgeS: 3.0, maxGapS: 4.0, minHits: 2, hitWindow: 4, noBirthAfterCutS: 0.05,
  momentumWeight: 0.18, teamPenalty: 0.4, reupdateGapS: 0.5,
  galleryTtlS: 120, galleryMax: 40, galleryPosGateH: 6, galleryHistMin: 0.6,
  edgeMargin: 0.04, edgeDetMargin: 0.06, edgeWindowS: 5, edgeHeightTol: 0.35, edgeHistMin: 0.55,
  longBreakS: 20,
  posQVel: 0.15, boxWQVel: 0.01, boxHQVel: 0.02, boxSmoothAlpha: 0,
  camLevels: 2, camMaxShiftFrac: 0.3,
};

/** Map a SourceProfile onto the tracker options, keeping all non-tuned knobs at their defaults. */
export function trackerOptsFromProfile(p: SourceProfile): TrackerV2Opts {
  return {
    ...DEFAULT_TRACKER_V2,
    highScore: p.highScore, lowScore: p.lowScore,
    matchIou: p.matchIou, lowMatchIou: p.lowMatchIou,
    centreGate: p.centreGate, maxAgeS: p.maxAgeS, momentumWeight: p.momentumWeight,
    teamPenalty: p.teamPenalty,
    posQVel: p.posQVel, boxWQVel: p.boxWQVel, boxHQVel: p.boxHQVel,
    boxSmoothAlpha: p.boxSmoothAlpha,
    camLevels: p.camLevels, camMaxShiftFrac: p.camMaxShiftFrac,
  };
}

export interface TrackerContext {
  scene?: SceneKind;
  /** Explicit birth permission; defaults to true except during REPLAY/CLOSE. */
  allowBirth?: boolean;
  /** Optional 320x180 (or similar) greyscale frame for camera-motion compensation. */
  frame?: GreyFrame;
  /** Set false to skip camera flow for this cycle even when a frame is supplied. */
  camera?: boolean;
}

export interface TrackerDebugStats {
  frames: number;
  durationS: number;
  newIds: number;
  /** Rolling new-ID rate over the last 60 s (or the whole run when shorter). Steady-state churn metric. */
  newIdsPerMinute: number;
  /** Total allocations per minute since the first frame (includes the initial squad). */
  newIdsTotalPerMinute: number;
  newIdsLastMinute: number;
  confirmed: number;
  coasting: number;
  tentative: number;
  dormant: number;
  gallerySize: number;
  galleryMatches: number;
  edgeReentries: number;
  cameraConfidence: number | null;
}

interface Obs { cx: number; cy: number; h: number; t: number }

interface VTrack {
  uid: number;
  id: number | null;          // visible ID; null while tentative
  kx: Kalman1D; ky: Kalman1D; kw: Kalman1D; kh: Kalman1D;
  sw: number;                 // EMA-smoothed box width (see boxSmoothAlpha)
  sh: number;                 // EMA-smoothed box height
  confirmed: boolean;
  hits: number;
  hitWindow: boolean[];
  firstT: number;
  lastT: number;              // last detection time
  lastPredT: number;
  lastBox: Box4;
  lastObsT: number;
  obs: Obs[];
  velObs: [number, number];   // observation-centric velocity, normalised / s
  score: number;
  cls: PersonCls;
  team: Team;
  hist: number[] | null;
}

interface Dormant {
  id: number;
  team: Team;
  hist: number[] | null;
  lastBox: Box4;
  lastT: number;
  hits: number;
  age: number;
  cls: PersonCls;
  score: number;
}

interface GalleryEntry {
  id: number;
  team: Team;
  hist: number[] | null;
  cx: number;
  cy: number;
  h: number;
  t: number;
  cls: PersonCls;
}

const CLASSES: PersonCls[] = ['player', 'goalkeeper', 'referee'];

/**
 * Observation-centric velocity: least-squares slope over the last <=windowS of detection centres. The Kalman
 * velocity is smooth but takes about a second to follow a direction change, which is exactly what makes the
 * renderer extrapolate behind a running player. Exposed as Track.vel; snapshot() shortens the lookback at
 * sprint speed so a new velocity is not averaged against the walk before it.
 */
function obsVelocity(s: VTrack, windowS = 0.55): [number, number] | null {
  const o = s.obs;
  if (o.length < 2) return null;
  const tEnd = o[o.length - 1]!.t;
  let i = o.length - 1;
  while (i > 0 && tEnd - o[i - 1]!.t <= windowS) i--;
  const n = o.length - i;
  if (n < 2) return null;
  let mt = 0, mx = 0, my = 0;
  for (let k = i; k < o.length; k++) { const p = o[k]!; mt += p.t; mx += p.cx; my += p.cy; }
  mt /= n; mx /= n; my /= n;
  let den = 0, numX = 0, numY = 0;
  for (let k = i; k < o.length; k++) {
    const p = o[k]!;
    const dt = p.t - mt;
    den += dt * dt; numX += dt * (p.cx - mx); numY += dt * (p.cy - my);
  }
  if (den < 1e-6) return null;
  return [numX / den, numY / den];
}

function cxcywh(b: Box4): [number, number, number, number] {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, b[2] - b[0], b[3] - b[1]];
}
function boxOfState(s: VTrack): Box4 {
  const w = Math.max(1e-3, s.kw.p), h = Math.max(1e-3, s.kh.p);
  return [s.kx.p - w / 2, s.ky.p - h / 2, s.kx.p + w / 2, s.ky.p + h / 2];
}
function centre(b: Box4): [number, number] { return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }
function edgeDist(cx: number, cy: number): number { return Math.min(cx, 1 - cx, cy, 1 - cy); }

/** Bhattacharyya coefficient of two normalised histograms; 0 when either is empty or bins differ. */
export function histSimilarity(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let sa = 0, sb = 0, dot = 0;
  for (let i = 0; i < a.length; i++) { sa += a[i]!; sb += b[i]!; }
  if (sa <= 0 || sb <= 0) return 0;
  for (let i = 0; i < a.length; i++) dot += Math.sqrt((a[i]! / sa) * (b[i]! / sb));
  return Math.max(0, Math.min(1, dot));
}

function pushHist(prev: number[] | null, next: number[], alpha: number): number[] {
  if (!prev || prev.length !== next.length) return [...next];
  const out = new Array<number>(next.length);
  for (let i = 0; i < next.length; i++) out[i] = (1 - alpha) * prev[i]! + alpha * next[i]!;
  return out;
}

/**
 * Player tracker v2. `update` is the only required call per cycle; pass `context.frame` to enable camera-motion
 * compensation and `context.scene` to suppress births during replays/close-ups and to drive the long-break reset.
 */
export class PlayerTrackerV2 {
  readonly o: TrackerV2Opts;
  private tracks: VTrack[] = [];
  private dormant = new Map<number, Dormant>();
  private gallery: GalleryEntry[] = [];
  private nextId = 1;
  private uid = 1;
  private allocated = 0;
  private newIdTimes: number[] = [];
  private firstT = Infinity;
  private lastT = -Infinity;
  private frames = 0;
  private suppressBirthUntil = -Infinity;
  private idAllowed = true;
  private lastWideT = -Infinity;
  private longBreakArmed = true;
  private prevGrey: GreyFrame | null = null;
  private lastMotion: CameraMotion | null = null;
  private lastMotionT = -Infinity;
  private flow: CameraFlow;
  /** EMA of the camera-flow cost; above ~6 ms the flow runs every other cycle and the last estimate is reused. */
  private flowMs = 0;
  /** Video time at the start of the last flow estimate (the previous grey frame) and its duration. */
  private flowT = -Infinity;
  private lastSpan = 0;
  private galleryMatches = 0;
  private edgeReentries = 0;

  constructor(o: Partial<TrackerV2Opts> = {}) {
    this.o = { ...DEFAULT_TRACKER_V2, ...o };
    this.flow = new CameraFlow({ levels: this.o.camLevels, maxShiftFrac: this.o.camMaxShiftFrac });
  }

  /** Merge new options at runtime (auto-detect reconfiguration); camera flow is rebuilt for its knobs. */
  configure(o: Partial<TrackerV2Opts>): void {
    Object.assign(this.o, o);
    this.flow = new CameraFlow({ levels: this.o.camLevels, maxShiftFrac: this.o.camMaxShiftFrac });
  }

  /** Camera estimate from the most recent cycle (null when no frame was supplied or RANSAC rejected it). */
  get motion(): CameraMotion | null { return this.lastMotion; }

  /** Video seconds spanned by `motion` (cycles may be skipped, or a cycle may lack a grey frame). */
  get motionSpanS(): number { return this.lastSpan; }

  reset(): void {
    this.tracks = [];
    this.dormant.clear();
    this.gallery = [];
    this.firstT = Infinity;
    this.lastT = -Infinity;
    this.frames = 0;
    this.suppressBirthUntil = -Infinity;
    this.lastWideT = -Infinity;
    this.longBreakArmed = true;
    this.prevGrey = null;
    this.lastMotion = null;
    this.lastMotionT = -Infinity;
    this.flow.reset();
    this.flowMs = 0;
    this.flowT = -Infinity;
    this.lastSpan = 0;
    this.nextId = 1;
    // The debug ledger belongs to the discarded timeline: keep it and a rewound clock can never trim
    // its stamps (t - stamp is negative), so newIdsPerMinute would count IDs from the previous video.
    this.allocated = 0;
    this.newIdTimes = [];
    this.galleryMatches = 0;
    this.edgeReentries = 0;
  }

  /** Feed the team assigner's current output so team can act as a hard association constraint. */
  noteTeams(tracks: readonly Pick<Track, 'id' | 'team'>[]): void {
    const byId = new Map<number, Team>();
    for (const t of tracks) byId.set(t.id, t.team);
    for (const s of this.tracks) {
      const team = s.id !== null ? byId.get(s.id) : undefined;
      if (team && team !== 'OTHER') s.team = team;
    }
  }

  /** Scene-only hook for integrations that update the tracker without a FrameState. */
  setScene(kind: SceneKind | undefined, t: number): void { this.noteScene(kind, t); }

  private noteScene(kind: SceneKind | undefined, t: number): void {
    if (!kind || kind === 'WIDE') {
      this.lastWideT = t;
      this.longBreakArmed = true;
      return;
    }
    if (this.lastWideT === -Infinity) this.lastWideT = t;
    if (this.longBreakArmed && t - this.lastWideT >= this.o.longBreakS) {
      // Product decision: a long non-WIDE stretch drops identity memory and restarts numbering.
      this.gallery = [];
      this.dormant.clear();
      this.tracks = [];
      this.nextId = 1;
      this.newIdTimes = [];
      this.longBreakArmed = false;
    }
  }

  private predict(s: VTrack, t: number): void {
    const dt = t - s.lastPredT;
    if (dt <= 0) return;
    // Sprint-adaptive process noise: a constant-velocity Kalman with the rest-state qVel takes ~4
    // detections to believe a new speed. A sprint start must be visible in Track.vel within ~2, so
    // scale qVel with the current speed (rest keeps the profile's calm value exactly).
    const speed = Math.hypot(s.kx.v * ASPECT, s.ky.v);
    const q = this.o.posQVel * (1 + 3 * Math.min(1, speed / 0.1));
    s.kx.setProcessNoise(q); s.ky.setProcessNoise(q);
    // Coast decay per 0.1 s of missed time (not one tap per update call), applied before the advance:
    // a single update spanning a multi-second stall must not fling the box across the frame at full
    // velocity, or the player's next detection could never re-associate.
    if (t - s.lastT > 0.3) {
      const f = Math.pow(0.9, dt / 0.1);
      s.kx.scaleVelocity(f); s.ky.scaleVelocity(f);
    }
    s.kx.predict(dt); s.ky.predict(dt); s.kw.predict(dt); s.kh.predict(dt);
    s.lastPredT = t;
  }

  private momentumCost(s: VTrack, d: PersonDet): number {
    const last = s.obs[s.obs.length - 1];
    if (!last) return 0;
    const [dcx, dcy] = centre(d.box);
    const dx = dcx - last.cx, dy = dcy - last.cy;
    const dn = Math.hypot(dx * ASPECT, dy);
    let vx = s.velObs[0], vy = s.velObs[1];
    if (Math.hypot(vx * ASPECT, vy) < 0.03) { vx = s.kx.v; vy = s.ky.v; }
    const vn = Math.hypot(vx * ASPECT, vy);
    if (dn < 1e-6 || vn < 0.03) return 0;
    const cos = (vx * ASPECT * dx * ASPECT + vy * dy) / (vn * dn);
    return (1 - Math.max(-1, Math.min(1, cos))) / 2;
  }

  private matchSet(trIdx: number[], dets: PersonDet[], detIdx: number[], minIou: number, t: number): [number, number][] {
    if (!trIdx.length || !detIdx.length) return [];
    const rows: number[][] = trIdx.map((ti) => {
      const s = this.tracks[ti]!;
      const useFlow = this.lastMotion !== null && t - s.lastT <= 0.6;
      const pred = useFlow ? warpBox(s.lastBox, this.lastMotion!) : boxOfState(s);
      const [pcx, pcy, , ph] = cxcywh(pred);
      const pad = 0.1 * ph;
      const tb: Box4 = [pred[0] - pad, pred[1], pred[2] + pad, pred[3]];
      return detIdx.map((di) => {
        const d = dets[di]!;
        const [dcx, dcy, , dh] = cxcywh(d.box);
        const hRef = Math.max(ph, dh, 1e-3);
        const dist = Math.hypot((dcx - pcx) * ASPECT, dcy - pcy);
        const ov = iou(tb, d.box);
        // Team is a soft constraint: a mislabelled torso colour must not orphan the player and burn a new
        // ID. It only tips a close call.
        const teamPenalty = s.team !== 'OTHER' && d.team && d.team !== 'OTHER' && d.team !== s.team ? this.o.teamPenalty : 0;
        if (!(ov >= minIou || dist <= this.o.centreGate * hRef)) return 1e6;
        const distCost = Math.min(1, dist / (2 * this.o.centreGate * hRef));
        return 0.6 * (1 - ov) + 0.25 * distCost + this.o.momentumWeight * this.momentumCost(s, d) + teamPenalty;
      });
    });
    const out: [number, number][] = [];
    for (const [r, c] of hungarian(rows, trIdx.length, detIdx.length)) {
      if (rows[r]![c]! >= 1e6) continue;
      out.push([trIdx[r]!, detIdx[c]!]);
    }
    return out;
  }

  private newKalman(cx: number, cy: number, w: number, h: number): Pick<VTrack, 'kx' | 'ky' | 'kw' | 'kh'> {
    const o = this.o;
    const mk = (p: number) => new Kalman1D(p, 2e-5, o.posQVel, 6e-4, 6e-4, 0.25);
    return {
      kx: mk(cx), ky: mk(cy),
      kw: new Kalman1D(w, 1e-5, o.boxWQVel, 6e-4, 6e-4, 0.05),
      kh: new Kalman1D(h, 1e-5, o.boxHQVel, 6e-4, 6e-4, 0.05),
    };
  }

  private spawn(d: PersonDet, t: number): VTrack {
    const [cx, cy, w, h] = cxcywh(d.box);
    const s: VTrack = {
      uid: this.uid++,
      id: null,
      ...this.newKalman(cx, cy, w, h),
      sw: w, sh: h,
      confirmed: false, hits: 1, hitWindow: [true], firstT: t, lastT: t, lastPredT: t,
      lastBox: d.box, lastObsT: t,
      obs: [{ cx, cy, h, t }],
      velObs: [0, 0], score: d.score, cls: d.cls,
      team: d.team ?? 'OTHER', hist: d.hist ? [...d.hist] : null,
    };
    this.tracks.push(s);
    return s;
  }

  private apply(s: VTrack, d: PersonDet, t: number): void {
    const [cx, cy, w0, h0] = cxcywh(d.box);
    const gap = t - s.lastT;
    // Box-size EMA, separate from position: game boxes jitter, so smooth the width/height before the
    // Kalman. boxSmoothAlpha = 0 (broadcast) leaves the raw box, preserving the original behaviour.
    let w = w0, h = h0;
    if (this.o.boxSmoothAlpha > 0) {
      const a = this.o.boxSmoothAlpha;
      s.sw = (1 - a) * s.sw + a * w0;
      s.sh = (1 - a) * s.sh + a * h0;
      w = s.sw; h = s.sh;
    }
    const r = d.score >= this.o.highScore ? 6e-4 : 2e-3;
    s.kx.update(cx, r); s.ky.update(cy, r); s.kw.update(w, r * 2); s.kh.update(h, r * 2);
    if (gap > this.o.reupdateGapS) {
      // Observation-centric re-update: after an occlusion, correct twice toward the new observation so the
      // coasted Kalman cannot leave the track anchored to a stale position.
      s.kx.update(cx, r * 3); s.ky.update(cy, r * 3); s.kw.update(w, r * 6); s.kh.update(h, r * 6);
    }
    const prev = s.obs[s.obs.length - 1];
    if (prev && gap > 1e-3) {
      const vx = (cx - prev.cx) / gap, vy = (cy - prev.cy) / gap;
      s.velObs = [0.5 * s.velObs[0] + 0.5 * vx, 0.5 * s.velObs[1] + 0.5 * vy];
    }
    s.obs.push({ cx, cy, h, t });
    while (s.obs.length > 12 || (s.obs.length > 2 && t - s.obs[0]!.t > 1.2)) s.obs.shift();
    s.lastT = t; s.lastObsT = t; s.lastBox = d.box;
    s.hits++;
    s.hitWindow.push(true);
    if (s.hitWindow.length > this.o.hitWindow) s.hitWindow.shift();
    s.score = d.score;
    let best: PersonCls = s.cls;
    // class votes are not stored separately in v2; keep the current class unless the detector is emphatic
    if (d.cls !== s.cls && d.score > 0.85) best = d.cls;
    s.cls = best;
    if (d.team && d.team !== 'OTHER') s.team = d.team;
    if (d.hist) s.hist = pushHist(s.hist, d.hist, 0.35);
    if (!s.confirmed) this.maybeConfirm(s, t);
  }

  private maybeConfirm(s: VTrack, t: number): void {
    if (s.confirmed || !this.idAllowed) return;
    const hits = s.hitWindow.filter(Boolean).length;
    if (hits < this.o.minHits) return;
    const g = this.matchGallery(s, t);
    if (g !== null) {
      s.id = g.id;
      s.confirmed = true;
      this.gallery.splice(this.gallery.indexOf(g), 1);
      this.galleryMatches++;
      return;
    }
    s.id = this.allocId(t);
    s.confirmed = true;
  }

  private allocId(t: number): number {
    const used = new Set<number>();
    for (const s of this.tracks) if (s.id !== null) used.add(s.id);
    for (const id of this.dormant.keys()) used.add(id);
    for (const g of this.gallery) used.add(g.id);
    while (used.has(this.nextId)) this.nextId++;
    const id = this.nextId++;
    this.allocated++;
    this.newIdTimes.push(t);
    while (this.newIdTimes.length && t - this.newIdTimes[0]! > 60) this.newIdTimes.shift();
    return id;
  }

  private parkGallery(t: number): void {
    for (const s of this.tracks) {
      if (!s.confirmed || s.id === null) continue;
      const [cx, cy, , h] = cxcywh(s.lastBox);
      const existing = this.gallery.findIndex((g) => g.id === s.id);
      const entry: GalleryEntry = { id: s.id, team: s.team, hist: s.hist ? [...s.hist] : null, cx, cy, h, t, cls: s.cls };
      if (existing >= 0) this.gallery[existing] = entry;
      else this.gallery.push(entry);
    }
    this.gallery = this.gallery.filter((g) => t - g.t <= this.o.galleryTtlS);
    if (this.gallery.length > this.o.galleryMax) this.gallery = this.gallery.slice(-this.o.galleryMax);
  }

  private matchGallery(s: VTrack, t: number): GalleryEntry | null {
    if (s.team === 'OTHER' || !s.hist) return null;
    const [cx, cy, , h] = cxcywh(s.lastBox);
    let best: GalleryEntry | null = null, bestScore = -Infinity;
    for (const g of this.gallery) {
      if (t - g.t > this.o.galleryTtlS) continue;
      if (!g.hist) continue;
      const hs = histSimilarity(s.hist, g.hist);
      if (hs < this.o.galleryHistMin) continue;
      const pos = Math.hypot((cx - g.cx) * ASPECT, cy - g.cy);
      const gate = this.o.galleryPosGateH * Math.max(h, g.h, 1e-3);
      if (pos > gate) continue;
      // A stale team label must not cost the player their identity; require a close colour match to
      // override it, otherwise the position/histogram score alone decides.
      const teamPenalty = g.team !== s.team ? 0.25 : 0;
      const score = hs - 0.15 * (pos / gate) - teamPenalty;
      if (score > bestScore) { bestScore = score; best = g; }
    }
    return best;
  }

  private edgeCandidates(matchedT: ReadonlySet<number>): { t: number; id: number; team: Team; hist: number[] | null; box: Box4; dormant: boolean; hits: number; age: number; cls: PersonCls; score: number }[] {
    const out: { t: number; id: number; team: Team; hist: number[] | null; box: Box4; dormant: boolean; hits: number; age: number; cls: PersonCls; score: number }[] = [];
    for (let i = 0; i < this.tracks.length; i++) {
      const s = this.tracks[i]!;
      if (!s.confirmed || s.id === null) continue;
      if (matchedT.has(i)) continue;   // matched this cycle: it may not steal a second detection
      const [cx, cy] = cxcywh(s.lastBox);
      if (edgeDist(cx, cy) > this.o.edgeMargin + 1e-9) continue;
      out.push({ t: s.lastT, id: s.id, team: s.team, hist: s.hist, box: s.lastBox, dormant: false, hits: s.hits, age: this.lastT - s.firstT, cls: s.cls, score: s.score });
    }
    for (const d of this.dormant.values()) {
      const [cx, cy] = cxcywh(d.lastBox);
      if (edgeDist(cx, cy) > this.o.edgeMargin + 1e-9) continue;
      out.push({ t: d.lastT, id: d.id, team: d.team, hist: d.hist, box: d.lastBox, dormant: true, hits: d.hits, age: d.age, cls: d.cls, score: d.score });
    }
    return out;
  }

  /** Edge re-entry pass: a lost track last seen at an edge gets its detection back within edgeWindowS. */
  private edgePass(dets: PersonDet[], matchedT: Set<number>, matchedD: Set<number>, t: number): void {
    const cands = this.edgeCandidates(matchedT);
    if (!cands.length) return;
    const free = dets.map((_, i) => i)
      .filter((di) => !matchedD.has(di) && edgeDist(...centre(dets[di]!.box)) <= this.o.edgeDetMargin + 1e-9);
    if (!free.length) return;
    const pairs: { ci: number; di: number; score: number }[] = [];
    for (let ci = 0; ci < cands.length; ci++) {
      const c = cands[ci]!;
      if (t - c.t > this.o.edgeWindowS || c.team === 'OTHER' || !c.hist) continue;
      const [, , , ch] = cxcywh(c.box);
      for (const di of free) {
        const d = dets[di]!;
        if (!d.hist) continue;
        const [, , , dh] = cxcywh(d.box);
        const ratio = dh / Math.max(ch, 1e-3);
        if (ratio < 1 - this.o.edgeHeightTol || ratio > 1 + this.o.edgeHeightTol) continue;
        const hs = histSimilarity(c.hist, d.hist);
        if (hs < this.o.edgeHistMin) continue;
        const hScore = 1 - Math.min(1, Math.abs(1 - ratio) / this.o.edgeHeightTol);
        // torso colour is the identity here; a flickering team label only discounts the match
        const teamPenalty = d.team && d.team !== 'OTHER' && d.team !== c.team ? 0.2 : 0;
        pairs.push({ ci, di, score: 0.7 * hs + 0.3 * hScore - teamPenalty });
      }
    }
    pairs.sort((a, b) => b.score - a.score);
    const usedC = new Set<number>(), usedD = new Set<number>();
    for (const p of pairs) {
      if (usedC.has(p.ci) || usedD.has(p.di)) continue;
      const c = cands[p.ci]!;
      if (c.dormant) {
        const d = this.dormant.get(c.id);
        if (!d) continue;
        this.revive(d, dets[p.di]!, t);
        this.dormant.delete(c.id);
      } else {
        const idx = this.tracks.findIndex((x) => x.id === c.id);
        if (idx < 0) continue;
        this.apply(this.tracks[idx]!, dets[p.di]!, t);
        matchedT.add(idx);
      }
      matchedD.add(p.di);
      usedC.add(p.ci); usedD.add(p.di);
      this.edgeReentries++;
    }
  }

  private revive(d: Dormant, det: PersonDet, t: number): void {
    const [cx, cy, w, h] = cxcywh(det.box);
    const [ocx, ocy] = cxcywh(d.lastBox);
    const gap = Math.max(1e-3, t - d.lastT);
    const s: VTrack = {
      uid: this.uid++,
      id: d.id,
      ...this.newKalman(cx, cy, w, h),
      sw: w, sh: h,
      confirmed: true, hits: d.hits + 1, hitWindow: [true], firstT: t - d.age, lastT: t, lastPredT: t,
      lastBox: det.box, lastObsT: t,
      obs: [{ cx: ocx, cy: ocy, h: cxcywh(d.lastBox)[3], t: d.lastT }, { cx, cy, h, t }],
      velObs: [(cx - ocx) / gap, (cy - ocy) / gap],
      score: det.score, cls: d.cls, team: d.team, hist: d.hist,
    };
    this.tracks.push(s);
  }

  /** Feed one frame of person detections at video time `t` (seconds). Returns confirmed tracks. */
  update(dets: PersonDet[], t: number, tMedia = t, cut = false, ctx: TrackerContext = {}): Track[] {
    const o = this.o;
    if (this.firstT === Infinity) this.firstT = t;

    const seek = !cut && (t - this.lastT > o.maxGapS || t < this.lastT - 0.05);
    if (cut) {
      this.parkGallery(t);
      this.tracks = [];
      this.dormant.clear();
      this.suppressBirthUntil = t + o.noBirthAfterCutS;
    } else if (seek) {
      this.tracks = [];
      this.dormant.clear();
      if (t < this.lastT - 0.05) {
        // Rewind: the parked gallery, the post-cut birth suppression and the WIDE clock come from the
        // discarded forward segment and must not leak into the rewound timeline. Same for the rolling
        // new-ID window: stamps after the rewound clock are in this timeline's future, so the 60 s trim
        // can never drop them; keep only the stamps at or before the clock.
        this.gallery = [];
        this.suppressBirthUntil = -Infinity;
        this.lastWideT = t;
        this.newIdTimes = this.newIdTimes.filter((x) => x <= t);
      }
    }

    this.noteScene(ctx.scene, t);
    const allowBirth = ctx.allowBirth ?? !(ctx.scene === 'REPLAY' || ctx.scene === 'CLOSE');
    this.idAllowed = allowBirth && t >= this.suppressBirthUntil;

    // Camera-motion compensation (CMC). Keep the previous grey frame even when a cycle has no detections.
    // The estimate is reused across one skipped cycle when the flow is expensive, and survives a cycle with
    // no frame briefly; matchSet only trusts it for tracks updated within 0.6 s.
    if (ctx.frame && ctx.camera !== false) {
      // The flow runs every cycle to keep corner continuity. If it is still expensive, alternate cycles use
      // a cheaper setting (fewer corners, 3 iterations) rather than skipping, so a pan is never left without
      // a fresh estimate and the displacement/span rate stays right.
      const cheap = !cut && !seek && this.flowMs > 6 && this.frames % 2 === 1;
      if (this.prevGrey && !cut && !seek) {
        const t0 = nowMs();
        this.lastMotion = this.flow.estimate(this.prevGrey, ctx.frame, dets.map((d) => d.box), cheap ? { maxCorners: 32, iterations: 3, levels: Math.min(2, this.o.camLevels) } : undefined);
        const ms = nowMs() - t0;
        this.flowMs = this.flowMs === 0 ? ms : this.flowMs * 0.8 + ms * 0.2;
        this.lastMotionT = this.lastMotion ? t : -Infinity;
        this.lastSpan = Number.isFinite(this.flowT) ? Math.max(0, t - this.flowT) : 0;
      }
      this.prevGrey = ctx.frame;
      this.flowT = t;
    } else if (cut || seek) {
      this.prevGrey = null;
      this.lastMotion = null;
    }
    if (cut || seek) { this.flow.reset(); this.lastMotion = null; this.lastMotionT = -Infinity; this.flowT = -Infinity; this.lastSpan = 0; }
    if (this.lastMotion && t - this.lastMotionT > 0.6) this.lastMotion = null;

    for (const s of this.tracks) this.predict(s, t);

    const high: number[] = [], low: number[] = [];
    dets.forEach((d, i) => {
      if (d.score >= o.highScore) high.push(i);
      else if (d.score >= o.lowScore) low.push(i);
    });
    const matchedT = new Set<number>(), matchedD = new Set<number>();
    const all = this.tracks.map((_, i) => i);

    for (const [ti, di] of this.matchSet(all, dets, high, o.matchIou, t)) {
      this.apply(this.tracks[ti]!, dets[di]!, t);
      matchedT.add(ti); matchedD.add(di);
    }
    const rest = all.filter((i) => !matchedT.has(i) && this.tracks[i]!.confirmed);
    for (const [ti, di] of this.matchSet(rest, dets, low, o.lowMatchIou, t)) {
      this.apply(this.tracks[ti]!, dets[di]!, t);
      matchedT.add(ti); matchedD.add(di);
    }

    // Unmatched detections of either score may revive an edge track (active first, then dormant).
    this.edgePass(dets, matchedT, matchedD, t);

    // Births only from unmatched high-score detections, never during a cut/close/replay or a long break.
    if (this.idAllowed) {
      for (const di of high) {
        if (matchedD.has(di)) continue;
        let dup = false;
        for (const s of this.tracks) if (iou(boxOfState(s), dets[di]!.box) > 0.55) { dup = true; break; }
        if (dup) continue;
        this.spawn(dets[di]!, t);
      }
    }

    // Miss bookkeeping and retirement.
    const keep: VTrack[] = [];
    for (let i = 0; i < this.tracks.length; i++) {
      const s = this.tracks[i]!;
      if (matchedT.has(i) || s.lastT === t) { keep.push(s); continue; }
      s.hitWindow.push(false);
      if (s.hitWindow.length > o.hitWindow) s.hitWindow.shift();
      if (!s.confirmed) {
        const hits = s.hitWindow.filter(Boolean).length;
        if (hits < o.minHits && s.hitWindow.length >= o.hitWindow) continue;
        if (t - s.firstT > 1.5) continue;
        keep.push(s);
        continue;
      }
      if (t - s.lastT > o.maxAgeS) {
        const [cx, cy, , h] = cxcywh(s.lastBox);
        if (s.id !== null && s.hist && s.team !== 'OTHER' && edgeDist(cx, cy) <= o.edgeMargin + 1e-9) {
          this.dormant.set(s.id, {
            id: s.id, team: s.team, hist: s.hist, lastBox: s.lastBox, lastT: s.lastT,
            hits: s.hits, age: t - s.firstT, cls: s.cls, score: s.score,
          });
        }
        continue;
      }
      keep.push(s);
    }
    this.tracks = keep;
    for (const [id, d] of this.dormant) if (t - d.lastT > o.edgeWindowS) this.dormant.delete(id);
    this.gallery = this.gallery.filter((g) => t - g.t <= o.galleryTtlS);
    while (this.newIdTimes.length && t - this.newIdTimes[0]! > 60) this.newIdTimes.shift();

    this.lastT = t;
    this.frames++;
    return this.snapshot(t, tMedia);
  }

  snapshot(t: number, tMedia: number): Track[] {
    return this.tracks.filter((s) => s.confirmed && s.id !== null).map((s) => {
      const box = boxOfState(s);
      // Fresh tracks get the responsive observation slope; a coasting track keeps its Kalman velocity.
      // At sprint speed the window shortens to ~2 detections so a new velocity is not averaged against
      // the walk before it (a 0.55 s window takes ~5 samples to catch a sprint start).
      const speed = Math.hypot(s.kx.v * ASPECT, s.ky.v);
      const win = speed > 0.08 ? 0.26 : speed > 0.035 ? 0.4 : 0.55;
      const ov = t - s.lastT <= 0.35 ? obsVelocity(s, win) : null;
      const vx = ov ? 0.7 * ov[0] + 0.3 * s.kx.v : s.kx.v;
      const vy = ov ? 0.7 * ov[1] + 0.3 * s.ky.v : s.ky.v;
      return {
        id: s.id!,
        cls: s.cls,
        score: s.score,
        box,
        age: t - s.firstT,
        hits: s.hits,
        timeSinceUpdate: t - s.lastT,
        tMedia,
        foot: [(box[0] + box[2]) / 2, box[3]] as [number, number],
        vel: [vx, vy] as [number, number],
        team: s.team,
        teamMargin: 0,
      };
    });
  }

  debugStats(): TrackerDebugStats {
    const durationS = this.lastT > this.firstT ? this.lastT - this.firstT : 0;
    const confirmed = this.tracks.filter((s) => s.confirmed).length;
    const span = Math.min(60, durationS);
    const recent = span > 0 ? this.newIdTimes.filter((x) => x >= this.lastT - span).length : 0;
    return {
      frames: this.frames,
      durationS,
      newIds: this.allocated,
      newIdsPerMinute: span > 0 ? (recent * 60) / span : 0,
      newIdsTotalPerMinute: durationS > 0 ? (this.allocated * 60) / durationS : 0,
      newIdsLastMinute: recent,
      confirmed,
      coasting: this.tracks.filter((s) => s.confirmed && this.lastT - s.lastT > 1e-6).length,
      tentative: this.tracks.filter((s) => !s.confirmed).length,
      dormant: this.dormant.size,
      gallerySize: this.gallery.length,
      galleryMatches: this.galleryMatches,
      edgeReentries: this.edgeReentries,
      cameraConfidence: this.lastMotion?.confidence ?? null,
    };
  }

  /** Global motion estimate (median observation velocity), normalised units per second. */
  static medianVelocity(tracks: Track[]): [number, number] {
    const live = tracks.filter((t) => t.timeSinceUpdate < 0.3 && t.hits >= 4);
    if (live.length < 3) return [0, 0];
    const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]!; };
    return [med(live.map((t) => t.vel[0])), med(live.map((t) => t.vel[1]))] as [number, number];
  }
}

// Kept here so callers can import the class name they expect without a second file.
export { PlayerTrackerV2 as ByteTrackV2 };
export { CLASSES as PERSON_CLASSES };
