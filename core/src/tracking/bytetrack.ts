import type { SceneKind, Track } from '../types';
import { iou } from '../perception/decode';
import { Kalman1D } from './kalman';
import { hungarian } from './hungarian';
import type { PersonCls, PersonDet } from './person';
import {
  DEFAULT_TRACKER_V2, PlayerTrackerV2,
  type TrackerContext, type TrackerDebugStats, type TrackerV2Opts,
} from './v2';
import type { CameraMotion } from './camera';

export type { PersonCls, PersonDet } from './person';

export interface TrackerV1Opts {
  highScore: number;
  lowScore: number;
  matchIou: number;
  lowMatchIou: number;
  minBirthS: number;
  minHits: number;
  maxAgeS: number;
  maxGapS: number;
}

export const DEFAULT_TRACKER_V1: TrackerV1Opts = {
  highScore: 0.35, lowScore: 0.15, matchIou: 0.25, lowMatchIou: 0.3,
  minBirthS: 0.25, minHits: 2, maxAgeS: 1.0, maxGapS: 2.0,
};

/** Public tracker options. `tracker` selects the old ByteTrack-lite (v1) or the OC-SORT v2 (default). */
export interface TrackerOpts extends TrackerV2Opts {
  tracker: 'v1' | 'v2';
  /** v1 only: consecutive-hit time before a track is confirmed. */
  minBirthS: number;
}

export const DEFAULT_TRACKER: TrackerOpts = {
  ...DEFAULT_TRACKER_V2,
  tracker: 'v2',
  minBirthS: DEFAULT_TRACKER_V1.minBirthS,
};

interface V1State {
  id: number;
  kx: Kalman1D; ky: Kalman1D; kw: Kalman1D; kh: Kalman1D;
  hits: number;
  firstT: number;
  lastT: number;
  lastPredT: number;
  confirmed: boolean;
  score: number;
  votes: Record<PersonCls, number>;
  cls: PersonCls;
}

const CLASSES: PersonCls[] = ['player', 'goalkeeper', 'referee'];

/** Players are tall and thin: widen boxes by 15% of their height per side so a camera pan does not break IoU. */
function pad(b: [number, number, number, number]): [number, number, number, number] {
  const p = 0.15 * (b[3] - b[1]);
  return [b[0] - p, b[1], b[2] + p, b[3]];
}

function toCxcywh(b: PersonDet['box']): [number, number, number, number] {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, b[2] - b[0], b[3] - b[1]];
}

/**
 * ByteTrack-lite v1 (fallback). Two-pass IoU association over Kalman-predicted boxes, time-based constants.
 * Camera cuts drop every track; this implementation is kept selectable with `tracker: 'v1'`.
 */
export class ByteTrackV1 {
  private tracks: V1State[] = [];
  private nextId = 1;
  private lastT = -Infinity;
  readonly opts: TrackerV1Opts;

  constructor(opts: Partial<TrackerV1Opts> = {}) {
    this.opts = { ...DEFAULT_TRACKER_V1, ...opts };
  }

  reset(): void { this.tracks = []; this.lastT = -Infinity; }

  private spawn(d: PersonDet, t: number): void {
    const [cx, cy, w, h] = toCxcywh(d.box);
    const mk = (p: number) => new Kalman1D(p, 2e-5, 0.15, 6e-4, 6e-4, 0.25);
    const s: V1State = {
      id: this.nextId++,
      kx: mk(cx), ky: mk(cy),
      kw: new Kalman1D(w, 1e-5, 0.01, 6e-4, 6e-4, 0.05),
      kh: new Kalman1D(h, 1e-5, 0.02, 6e-4, 6e-4, 0.05),
      hits: 1, firstT: t, lastT: t, lastPredT: t, confirmed: false, score: d.score,
      votes: { player: 0, goalkeeper: 0, referee: 0 }, cls: d.cls,
    };
    s.votes[d.cls] += d.score;
    this.tracks.push(s);
  }

  private predict(s: V1State, t: number): void {
    const dt = t - s.lastPredT;
    if (dt > 0) { s.kx.predict(dt); s.ky.predict(dt); s.kw.predict(dt); s.kh.predict(dt); s.lastPredT = t; }
    if (t - s.lastT > 0.3) { s.kx.scaleVelocity(0.9); s.ky.scaleVelocity(0.9); }
  }

  private boxOf(s: V1State): [number, number, number, number] {
    const w = Math.max(1e-3, s.kw.p), h = Math.max(1e-3, s.kh.p);
    return [s.kx.p - w / 2, s.ky.p - h / 2, s.kx.p + w / 2, s.ky.p + h / 2];
  }

  private apply(s: V1State, d: PersonDet, t: number, low: boolean): void {
    const [cx, cy, w, h] = toCxcywh(d.box);
    const r = low ? 2e-3 : 6e-4;
    s.kx.update(cx, r); s.ky.update(cy, r); s.kw.update(w, r * 2); s.kh.update(h, r * 2);
    s.lastT = t;
    s.hits++;
    s.score = d.score;
    s.votes[d.cls] += d.score;
    let best: PersonCls = s.cls;
    for (const c of CLASSES) if (s.votes[c] > s.votes[best] * 1.25) best = c;
    s.cls = best;
    if (!s.confirmed && s.hits >= this.opts.minHits && t - s.firstT >= this.opts.minBirthS) s.confirmed = true;
  }

  private match(trackIdx: number[], dets: PersonDet[], detIdx: number[], minIou: number): [number, number][] {
    if (!trackIdx.length || !detIdx.length) return [];
    const cost: number[][] = trackIdx.map((ti) => {
      const tb = pad(this.boxOf(this.tracks[ti]!));
      return detIdx.map((di) => 1 - iou(tb, pad(dets[di]!.box)));
    });
    return hungarian(cost, trackIdx.length, detIdx.length)
      .filter(([r, c]) => 1 - cost[r]![c]! >= minIou)
      .map(([r, c]) => [trackIdx[r], detIdx[c]] as [number, number]);
  }

  update(dets: PersonDet[], t: number, tMedia = t, cut = false): Track[] {
    const o = this.opts;
    if (cut || t - this.lastT > o.maxGapS || t < this.lastT - 0.05) this.tracks = [];
    this.lastT = t;
    for (const s of this.tracks) this.predict(s, t);

    const high: number[] = [], low: number[] = [];
    dets.forEach((d, i) => { if (d.score >= o.highScore) high.push(i); else if (d.score >= o.lowScore) low.push(i); });

    const all = this.tracks.map((_, i) => i);
    const matchedT = new Set<number>();
    const matchedD = new Set<number>();
    for (const [ti, di] of this.match(all, dets, high, o.matchIou)) {
      this.apply(this.tracks[ti]!, dets[di]!, t, false); matchedT.add(ti); matchedD.add(di);
    }
    const rest = all.filter((i) => !matchedT.has(i) && this.tracks[i]!.confirmed);
    for (const [ti, di] of this.match(rest, dets, low, o.lowMatchIou)) {
      this.apply(this.tracks[ti]!, dets[di]!, t, true); matchedT.add(ti); matchedD.add(di);
    }
    {
      const freeT = all.filter((i) => !matchedT.has(i) && this.tracks[i]!.confirmed);
      const freeD = high.filter((di) => !matchedD.has(di));
      if (freeT.length && freeD.length) {
        const dist = (ti: number, di: number): number => {
          const s = this.tracks[ti]!, b = dets[di]!.box;
          const h = Math.max(1e-3, s.kh.p);
          return Math.hypot((b[0] + b[2]) / 2 - s.kx.p, ((b[1] + b[3]) / 2 - s.ky.p) * 0.7) / h;
        };
        const cost = freeT.map((ti) => freeD.map((di) => dist(ti, di)));
        for (const [r, c] of hungarian(cost, freeT.length, freeD.length)) {
          if (cost[r]![c]! > 0.8) continue;
          const ti = freeT[r]!, di = freeD[c]!;
          this.apply(this.tracks[ti]!, dets[di]!, t, false); matchedT.add(ti); matchedD.add(di);
        }
      }
    }
    const born: V1State[] = [];
    for (const di of high) {
      if (matchedD.has(di)) continue;
      let dup = false;
      for (const s of this.tracks) if (iou(this.boxOf(s), dets[di]!.box) > 0.7) { dup = true; break; }
      if (dup) continue;
      this.spawn(dets[di]!, t);
      born.push(this.tracks[this.tracks.length - 1]!);
    }
    this.tracks = this.tracks.filter((s, i) => {
      if (!s.confirmed) return matchedT.has(i) || born.includes(s);
      return t - s.lastT <= o.maxAgeS;
    });
    return this.snapshot(t, tMedia);
  }

  snapshot(t: number, tMedia: number): Track[] {
    return this.tracks.filter((s) => s.confirmed).map((s) => {
      const box = this.boxOf(s);
      return {
        id: s.id,
        cls: s.cls,
        score: s.score,
        box,
        age: t - s.firstT,
        hits: s.hits,
        timeSinceUpdate: t - s.lastT,
        tMedia,
        foot: [(box[0] + box[2]) / 2, box[3]] as [number, number],
        vel: [s.kx.v, s.ky.v] as [number, number],
        team: 'OTHER' as const,
        teamMargin: 0,
      };
    });
  }
}

/**
 * Tracker facade. Defaults to v2; `new ByteTrackLite({ tracker: 'v1' })` keeps the old behaviour available.
 * The v2 implementation accepts optional team, appearance histogram and greyscale frame context.
 */
export class ByteTrackLite {
  readonly opts: TrackerOpts;
  private readonly v1: ByteTrackV1 | null;
  private readonly v2: PlayerTrackerV2 | null;

  constructor(opts: Partial<TrackerOpts> = {}) {
    const v1 = opts.tracker === 'v1';
    this.opts = { ...DEFAULT_TRACKER, ...(v1 ? DEFAULT_TRACKER_V1 : {}), ...opts };
    if (v1) {
      this.v1 = new ByteTrackV1(this.opts);
      this.v2 = null;
    } else {
      this.v1 = null;
      this.v2 = new PlayerTrackerV2(this.opts);
    }
  }

  get kind(): 'v1' | 'v2' { return this.v2 ? 'v2' : 'v1'; }
  get motion(): CameraMotion | null { return this.v2?.motion ?? null; }
  /** Video seconds spanned by `motion` (0 for v1, which has no flow). */
  get motionSpanS(): number { return this.v2?.motionSpanS ?? 0; }

  reset(): void { this.v1?.reset(); this.v2?.reset(); }

  noteTeams(tracks: readonly Pick<Track, 'id' | 'team'>[]): void { this.v2?.noteTeams(tracks); }
  setScene(kind: SceneKind | undefined, t: number): void { this.v2?.setScene(kind, t); }
  /** Merge new tracker options at runtime (auto-detect reconfiguration). v1 ignores it. */
  configure(o: Partial<TrackerV2Opts>): void { this.v2?.configure(o); }

  update(dets: PersonDet[], t: number, tMedia = t, cut = false, ctx: TrackerContext = {}): Track[] {
    if (this.v1) return this.v1.update(dets, t, tMedia, cut);
    return this.v2!.update(dets, t, tMedia, cut, ctx);
  }

  snapshot(t: number, tMedia: number): Track[] {
    return this.v1 ? this.v1.snapshot(t, tMedia) : this.v2!.snapshot(t, tMedia);
  }

  debugStats(): TrackerDebugStats {
    if (this.v2) return this.v2.debugStats();
    return {
      frames: 0, durationS: 0, newIds: 0, newIdsPerMinute: 0, newIdsTotalPerMinute: 0, newIdsLastMinute: 0,
      confirmed: 0, coasting: 0, tentative: 0, dormant: 0, gallerySize: 0,
      galleryMatches: 0, edgeReentries: 0, cameraConfidence: null,
    };
  }

  /** Global motion estimate: median velocity of confirmed, recently updated tracks. */
  static medianVelocity(tracks: Track[]): [number, number] {
    const live = tracks.filter((t) => t.timeSinceUpdate < 0.3 && t.hits >= 4);
    if (live.length < 3) return [0, 0];
    const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]!; };
    return [med(live.map((t) => t.vel[0])), med(live.map((t) => t.vel[1]))] as [number, number];
  }
}
