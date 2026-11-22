import type { Team, Track } from '../types';
import { type Lab, labDist, labToRgb, median3, rgbToHex, rgbToLab } from './lab';

/** Robust kit colour per team, measured from member torso colours (sRGB hex). */
export interface TeamKitColours {
  A: string;
  B: string;
  confidence: number;
}

export interface TeamOpts {
  minTracks: number;        // players needed to fit
  minSamples: number;       // per-track samples needed
  calibrateS: number;       // seconds of eligible WIDE play before the first fit
  minSeparation: number;    // centre distance needed to accept a fit
  voteWindowS: number;
  switchEveryS: number;     // a track's team may change at most once per this
  outlierMin: number;
  outlierSpread: number;    // outlier if distance > spread * this
  emaS: number;             // time constant of the per-track colour mean
  /** Recently seen tracks (seconds) that may contribute to a calibration fit. */
  poolS: number;
}

export const DEFAULT_TEAM_OPTS: TeamOpts = {
  // Game cameras often show only 6-9 players at once. Eight was too strict for EA FC: calibration
  // could stay pending for minutes and every ring stayed neutral. Six still gives k-means two
  // clusters of at least two members and the separation check below rejects weak splits.
  minTracks: 6, minSamples: 3, calibrateS: 2.5, minSeparation: 18, voteWindowS: 4, switchEveryS: 3,
  outlierMin: 24, outlierSpread: 2.6, emaS: 1.5, poolS: 8,
};

interface PerTrack {
  mean: Lab | null;
  samples: number;
  lastT: number;
  lastSeenT: number;
  votes: { t: number; team: Team; w: number }[];
  team: Team;
  changedAt: number;
  margin: number;
  gk: boolean;
  cls: Track['cls'];
}

/** k-means (k = 2) in weighted Lab, deterministic init (farthest pair). Returns null if degenerate. */
export function kmeans2(points: Lab[], iters = 12): { centres: [Lab, Lab]; assign: number[] } | null {
  if (points.length < 2) return null;
  const mean = points.reduce<Lab>((a, p) => [a[0] + p[0] / points.length, a[1] + p[1] / points.length, a[2] + p[2] / points.length], [0, 0, 0]);
  let i0 = 0, best = -1;
  points.forEach((p, i) => { const d = labDist(p, mean); if (d > best) { best = d; i0 = i; } });
  let i1 = 0; best = -1;
  points.forEach((p, i) => { const d = labDist(p, points[i0]!); if (d > best) { best = d; i1 = i; } });
  let c: [Lab, Lab] = [[...points[i0]!] as Lab, [...points[i1]!] as Lab];
  let assign = new Array(points.length).fill(0);
  for (let it = 0; it < iters; it++) {
    assign = points.map((p) => (labDist(p, c[0]) <= labDist(p, c[1]) ? 0 : 1));
    const nc: [Lab, Lab] = [[0, 0, 0], [0, 0, 0]];
    const cnt = [0, 0];
    points.forEach((p, i) => { const k = assign[i] as 0 | 1; cnt[k]!++; nc[k][0] += p[0]; nc[k][1] += p[1]; nc[k][2] += p[2]; });
    if (!cnt[0] || !cnt[1]) return null;
    for (const k of [0, 1] as const) { const n = cnt[k]!; nc[k][0] /= n; nc[k][1] /= n; nc[k][2] /= n; }
    c = nc;
  }
  return { centres: c, assign };
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1]!;
}

/**
 * Team assignment. Feed per-track torso Lab samples with `observe`; call `assign` once per frame.
 * Calibration: k-means k=2 over per-track mean Lab once >= minTracks players have enough samples during WIDE play.
 * Centres are frozen afterwards (kept across replays and close-ups). Referees, goalkeepers and colour outliers -> OTHER.
 */
export class TeamAssigner {
  calibrated = false;
  centres: [Lab, Lab] | null = null;
  spread = 10;
  /** Real shirt colours measured from the current cluster members (null until calibrated). */
  kitColours: TeamKitColours | null = null;
  private pt = new Map<number, PerTrack>();
  private eligibleSince = -1;
  private lastFitTry = -Infinity;
  readonly o: TeamOpts;

  constructor(o: Partial<TeamOpts> = {}) {
    this.o = { ...DEFAULT_TEAM_OPTS, ...o };
  }

  private get(id: number, t: number): PerTrack {
    let p = this.pt.get(id);
    if (!p) {
      p = { mean: null, samples: 0, lastT: t, lastSeenT: t, votes: [], team: 'OTHER', changedAt: -Infinity, margin: 0, gk: false, cls: 'player' };
      this.pt.set(id, p);
    }
    return p;
  }

  /**
   * Add one torso colour sample for a track (null/undefined samples are simply not observed).
   * `wide` gates the sample at the source: close-ups, replays and crowd shots are not kit evidence.
   */
  observe(id: number, lab: Lab, t: number, wide = true): void {
    if (!wide) return;
    const p = this.get(id, t);
    if (!p.mean) p.mean = [...lab] as Lab;
    else {
      const a = 1 - Math.exp(-Math.max(0, t - p.lastT) / this.o.emaS);
      const k = Math.max(a, 1 / (p.samples + 1));       // early samples average, later ones EMA
      p.mean = [p.mean[0] + k * (lab[0] - p.mean[0]), p.mean[1] + k * (lab[1] - p.mean[1]), p.mean[2] + k * (lab[2] - p.mean[2])];
    }
    p.samples++;
    p.lastT = t;
  }

  swap(): void {
    if (!this.centres) return;
    this.centres = [this.centres[1], this.centres[0]];
    if (this.kitColours) this.kitColours = { ...this.kitColours, A: this.kitColours.B, B: this.kitColours.A };
    for (const p of this.pt.values()) {
      p.votes = [];
      if (p.team !== 'OTHER') p.team = p.team === 'A' ? 'B' : 'A';
    }
  }

  recalibrate(): void {
    this.calibrated = false; this.centres = null; this.kitColours = null; this.eligibleSince = -1;
    // Drop the per-track colour history too. Keeping the old means meant a user-triggered
    // recalibration (new clip / correction) refitted the previous match's pixels and could not recover.
    for (const p of this.pt.values()) { p.votes = []; p.team = 'OTHER'; p.mean = null; p.samples = 0; p.gk = false; }
  }

  private tryFit(t: number): void {
    // Pool everyone seen recently, not just the players in this frame. A game camera cuts away every
    // few seconds, so a strict current-frame requirement rarely reaches the player count even though
    // the match has clearly shown both teams. Observations are already WIDE-gated, so this cannot
    // pull in close-up pixel colours.
    const pts: Lab[] = [];
    for (const p of this.pt.values()) {
      if (p.cls !== 'player' || !p.mean || p.samples < this.o.minSamples) continue;
      if (t - p.lastSeenT <= this.o.poolS) pts.push(p.mean);
    }
    if (pts.length < this.o.minTracks) return;
    let use = pts;
    let fit = kmeans2(use);
    if (!fit) return;
    // drop outliers (goalkeepers, referees mis-tagged as players) and refit
    for (let pass = 0; pass < 2; pass++) {
      const d = use.map((p, i) => labDist(p, fit!.centres[fit!.assign[i]!]!));
      const thr = Math.max(this.o.outlierMin * 0.7, 2 * median(d));
      const keep = use.filter((_, i) => d[i]! <= thr);
      if (keep.length < this.o.minTracks - 2 || keep.length === use.length) break;
      const f2 = kmeans2(keep);
      if (!f2) break;
      use = keep; fit = f2;
    }
    const sep = labDist(fit.centres[0], fit.centres[1]);
    const sizes = [0, 0];
    fit.assign.forEach((a) => { sizes[a]!++; });
    if (sep < this.o.minSeparation || Math.min(...sizes) < 2) return;
    // Do not mistake one neutral kit split by sun/shadow for two teams. Pure-lightness splits of
    // two near-neutral clusters are accepted only for a real dark-vs-light pair; a genuine white vs
    // sky-blue (or any coloured) pair has chroma separation and passes.
    const c0 = fit.centres[0], c1 = fit.centres[1];
    const chromaSep = Math.hypot(c0[1] - c1[1], c0[2] - c1[2]);
    const lSep = Math.abs(c0[0] - c1[0]);
    const neutral0 = Math.hypot(c0[1], c0[2]) < 10, neutral1 = Math.hypot(c1[1], c1[2]) < 10;
    if (neutral0 && neutral1 && chromaSep < 6 && lSep < 45) return;
    // A = the lighter (higher L) cluster only as a stable arbitrary convention; Swap flips it
    const order = fit.centres[0][0] >= fit.centres[1][0] ? [0, 1] : [1, 0];
    this.centres = [fit.centres[order[0]!]!, fit.centres[order[1]!]!];
    const d = use.map((p, i) => labDist(p, fit!.centres[fit!.assign[i]!]!));
    this.spread = Math.max(6, median(d));
    this.calibrated = true;
  }

  /**
   * Re-measure each cluster's shirt colour from its current members. Each track contributes its
   * torso-mean colour; a per-channel median rejects a mis-assigned/goalkeeper sample. Rule-computed
   * colours stay stable because the cluster centres are frozen after calibration.
   */
  private updateKitColours(tracks: Track[]): void {
    if (!this.calibrated || !this.centres) return;
    const groups: Record<'A' | 'B', [number, number, number][]> = { A: [], B: [] };
    for (const tr of tracks) {
      if (tr.team === 'OTHER' || tr.cls === 'referee') continue;
      const p = this.pt.get(tr.id);
      if (!p?.mean || p.samples < 2) continue;
      groups[tr.team].push(labToRgb(p.mean[0], p.mean[1], p.mean[2]));
    }
    if (groups.A.length < 2 || groups.B.length < 2) return;   // keep the last good measurement
    const [ar, ag, ab] = median3(groups.A);
    const [br, bg, bb] = median3(groups.B);
    const sep = labDist(this.centres[0], this.centres[1]);
    const n = Math.min(groups.A.length, groups.B.length);
    // Two genuinely identical kits (a white derby, a black derby) can still be pulled apart on
    // screen by the display mapper, but the measurement itself must say it is not confident.
    const pairDist = labDist(rgbToLab(ar, ag, ab), rgbToLab(br, bg, bb));
    const ambiguity = pairDist < 12 ? 0.5 : 1;
    const confidence = Math.max(0, Math.min(1, Math.min(1, n / 7) * Math.max(0.35, Math.min(1, 0.45 + (sep - this.o.minSeparation) / 45)) * ambiguity));
    this.kitColours = { A: rgbToHex(ar, ag, ab), B: rgbToHex(br, bg, bb), confidence };
  }

  /**
   * Assign teams on this frame's tracks. `wide`: scene is WIDE (calibration only runs in WIDE play).
   * Returns copies of the tracks with team, teamMargin (and cls 'goalkeeper' for persistent colour outliers) set.
   */
  assign(tracks: Track[], t: number, wide: boolean): Track[] {
    if (!this.calibrated) {
      if (wide) {
        if (this.eligibleSince < 0) this.eligibleSince = t;
        if (t - this.eligibleSince >= this.o.calibrateS && t - this.lastFitTry >= 0.5) { this.lastFitTry = t; this.tryFit(t); }
      }
    }
    const seen = new Set<number>();
    const out = tracks.map((tr) => {
      seen.add(tr.id);
      const p = this.get(tr.id, t);
      p.lastSeenT = t;
      p.cls = tr.cls;
      if (tr.cls === 'referee') return { ...tr, team: 'OTHER' as Team, teamMargin: 0 };
      if (!this.calibrated || !this.centres || !p.mean) return { ...tr, team: 'OTHER' as Team, teamMargin: 0 };
      // Replays and close-ups are not evidence. Keep the identity the wide shots established and do
      // not let a white wall, a crowd or a giant close-up shirt vote for a team or rewrite the kit.
      if (!wide) {
        return {
          ...tr, cls: p.gk ? ('goalkeeper' as const) : tr.cls,
          team: p.team, teamMargin: p.team === 'OTHER' ? 0 : p.margin,
        };
      }
      const dA = labDist(p.mean, this.centres[0]), dB = labDist(p.mean, this.centres[1]);
      const dn = Math.min(dA, dB), d2 = Math.max(dA, dB);
      const outlier = dn > Math.max(this.o.outlierMin, this.o.outlierSpread * this.spread);
      const vote: Team = outlier ? 'OTHER' : dA <= dB ? 'A' : 'B';
      const margin = outlier ? 0 : Math.max(0, Math.min(1, 1 - dn / (d2 + 1e-9)));
      p.votes.push({ t, team: vote, w: 0.2 + margin });
      while (p.votes.length && t - p.votes[0]!.t > this.o.voteWindowS) p.votes.shift();
      const tally: Record<Team, number> = { A: 0, B: 0, OTHER: 0 };
      for (const v of p.votes) tally[v.team] += v.w;
      let win: Team = 'A';
      for (const k of ['B', 'OTHER'] as Team[]) if (tally[k] > tally[win]) win = k;
      if (p.changedAt === -Infinity) { p.team = win; p.changedAt = t; }
      else if (win !== p.team && t - p.changedAt >= this.o.switchEveryS) { p.team = win; p.changedAt = t; }
      p.margin = margin;
      p.gk = p.team === 'OTHER' && tr.cls === 'player' && p.votes.length >= 3;
      return { ...tr, cls: p.gk ? ('goalkeeper' as const) : tr.cls, team: p.team, teamMargin: p.team === 'OTHER' ? 0 : margin };
    });
    for (const [id, p] of this.pt) if (!seen.has(id) && t - p.lastSeenT > 10) this.pt.delete(id);
    if (wide) this.updateKitColours(out);
    return out;
  }

  /** Team split counts among confirmed tracks (for debug display). */
  static counts(tracks: Track[]): Record<Team, number> {
    const c: Record<Team, number> = { A: 0, B: 0, OTHER: 0 };
    for (const t of tracks) c[t.team]++;
    return c;
  }
}
