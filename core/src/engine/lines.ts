// Perspective-aware formation lines: a formation row is a world line across the pitch, which a broadcast camera
// projects to a ray through the pitch-width vanishing point V - under perspective a back four is a diagonal in screen
// space, not a constant-x cluster. Pinhole ground plane: upright players satisfy y_foot = horizonY + slope*boxH, so
// estimateHorizon locates the horizon and V sits on it when the shot has real depth. When the shot is near top-down
// the pencil degenerates to parallel verticals; parking V far below the frame makes theta an affine rescale of x and
// the classic column split falls out of the same code. Pure TS, no DOM.
import type { Track } from '../types';
import { ASPECT, Ewma, bodyH, clamp, mean, median, type Pt } from './geometry';

/** Ground-plane fit y_foot = y + slope*boxH over the shot's upright people. */
export interface Horizon { y: number; slope: number; n: number }
export interface LinePlayer { id: number; foot: Pt; boxH: number }
export interface GroupOpts {
  attackAxis: 1 | -1;        // +1 attacks image right (own goal at image left)
  H: number;                 // median body height, frame-height units (consumed by the tracker's hysteresis; the depth clustering is height-invariant)
  horizon: Horizon | null;   // shot-level fit from estimateHorizon; null -> top-down fallback only
  V?: Pt | null;             // vanishing point override; skips the candidate search
  kMax?: number;             // max lines, default 4
}
export interface LineGroup {
  lines: number[][];      // ids back to front, each line sorted left to right
  theta: number[];        // ray angle per line, rad in [0, pi), same order
  depthMean: number[];    // 1D formation-depth coordinate per line, same order
  lineConfidence: number[];
  V: Pt;
  k: number;              // lines.length after dropping singletons
  confidence: number;     // mean silhouette of the chosen clustering, 0..1
}

const AFFINE_DROP = 8;     // top-down regime: park V this far below the lowest foot (frame heights)
const PEN3 = 0.06;         // silhouette penalty for k != 3 with >= 7 outfielders (most shapes have 3 lines)

/** Robust 2-pass LS fit y = horizonY + slope*boxH; residuals > 2.5 sigma (MAD) dropped, then refit. */
export function estimateHorizon(tracks: Track[]): Horizon | null {
  const pts = tracks
    .filter((t) => t.cls === 'player' && (t.team === 'A' || t.team === 'B') && t.timeSinceUpdate < 0.4)
    .map((t) => ({ h: bodyH(t), y: t.foot[1] }));
  if (pts.length < 8) return null;
  const hs = pts.map((p) => p.h);
  if (Math.max(...hs) < 1.5 * Math.min(...hs)) return null;   // no depth spread -> horizon unobservable
  const fit = (sel: { h: number; y: number }[]) => {
    const mh = mean(sel.map((p) => p.h)), my = mean(sel.map((p) => p.y));
    let shh = 0, shy = 0;
    for (const p of sel) { shh += (p.h - mh) * (p.h - mh); shy += (p.h - mh) * (p.y - my); }
    const slope = shh > 1e-12 ? shy / shh : 0;
    return { y: my - slope * mh, slope };
  };
  const s0 = fit(pts);
  const r = pts.map((p) => p.y - (s0.y + s0.slope * p.h));
  const med = median(r), sig = Math.max(1.4826 * median(r.map((v) => Math.abs(v - med))), 1e-4);
  const kept = pts.filter((_, i) => Math.abs(r[i] - med) <= 2.5 * sig);
  if (kept.length < 4) return null;
  const s = fit(kept);
  if (!(s.slope > 1e-3)) return null;   // feet must get lower (and boxes bigger) toward the camera
  return { y: s.y, slope: s.slope, n: kept.length };
}

/** Ray angle from the vanishing point V to p in aspect-corrected screen space. */
export function pencilTheta(p: Pt, V: Pt, aspect = ASPECT): number {
  return Math.atan2(p[1] - V[1], (p[0] - V[0]) * aspect);
}

/**
 * Formation-depth coordinate: signed offset of the ray V->p from the ray V->frame-centre. Lines of constant
 * pitch depth project to constant d (FORMATION_RESEARCH 2), so this is the 1D axis the line split runs on.
 */
export function pencilDepth(p: Pt, V: Pt, aspect = ASPECT): number {
  const rx = (p[0] - V[0]) * aspect, ry = p[1] - V[1];
  const cx = (0.5 - V[0]) * aspect, cy = 0.5 - V[1];
  return (rx * cy - ry * cx) / Math.max(1e-9, Math.hypot(rx, ry));
}

/**
 * Deterministic Jenks natural breaks on 1D values: exact DP optimum of the within-line SSE, min 2 players per
 * line. Returns a cluster index per input item. n is at most a squad, so O(k n^2) is negligible.
 */
function jenks1d(items: { v: number }[], k: number): number[] {
  const n = items.length;
  if (n === 0) return [];
  const kk = Math.max(1, Math.min(k, n >> 1));
  if (kk <= 1) return new Array<number>(n).fill(0);
  const order = items.map((_, i) => i).sort((a, b) => items[a]!.v - items[b]!.v || a - b);
  const v = order.map((i) => items[i]!.v);
  const p1 = new Array<number>(n + 1).fill(0), p2 = new Array<number>(n + 1).fill(0);
  for (let i = 0; i < n; i++) { p1[i + 1] = p1[i]! + v[i]!; p2[i + 1] = p2[i]! + v[i]! * v[i]!; }
  const sse = (a: number, b: number): number => {
    const m = b - a;
    if (m <= 0) return 0;
    const s = p1[b]! - p1[a]!, s2 = p2[b]! - p2[a]!;
    return Math.max(0, s2 - (s * s) / m);
  };
  const MIN = 2;
  const dp = Array.from({ length: kk + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  const from = Array.from({ length: kk + 1 }, () => new Array<number>(n + 1).fill(-1));
  dp[0]![0] = 0;
  for (let c = 1; c <= kk; c++) {
    for (let i = c * MIN; i <= n; i++) {
      for (let j = (c - 1) * MIN; j <= i - MIN; j++) {
        const base = dp[c - 1]![j]!;
        if (!Number.isFinite(base)) continue;
        const val = base + sse(j, i);
        if (val < dp[c]![i]! - 1e-12) { dp[c]![i] = val; from[c]![i] = j; }
      }
    }
  }
  const assign = new Array<number>(n).fill(0);
  let i = n;
  for (let c = kk; c >= 1; c--) {
    const j = from[c]![i]!;
    if (j < 0) return new Array<number>(n).fill(0);
    for (let q = j; q < i; q++) assign[q] = c - 1;
    i = j;
  }
  const out = new Array<number>(n).fill(0);
  for (let q = 0; q < n; q++) out[order[q]!] = assign[q]!;
  return out;
}

/** Mean silhouette width over the 1D clustering; singleton clusters score 0. */
function silhouette(v: number[], assign: number[], k: number): number {
  const n = v.length;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const sums = new Array<number>(k).fill(0), counts = new Array<number>(k).fill(0);
    const ai = assign[i]!;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const aj = assign[j]!;
      sums[aj] = sums[aj]! + Math.abs(v[i]! - v[j]!); counts[aj] = counts[aj]! + 1;
    }
    if (counts[ai] === 0) continue;
    const a = sums[ai]! / counts[ai]!;
    let b = Infinity;
    for (let j = 0; j < k; j++) if (j !== ai && counts[j]! > 0) b = Math.min(b, sums[j]! / counts[j]!);
    if (Number.isFinite(b)) total += (b - a) / Math.max(a, b);
  }
  return total / n;
}

/** Least-squares ray direction through V (aspect-corrected, uncentered so it stays pinned to V), canonical dy >= 0. */
function rayThroughV(V: Pt, ps: LinePlayer[]): { d: Pt; theta: number } {
  let a = 0, b = 0, c = 0;
  for (const p of ps) {
    const rx = (p.foot[0] - V[0]) * ASPECT, ry = p.foot[1] - V[1];
    a += rx * rx; b += ry * ry; c += rx * ry;
  }
  let d: Pt;
  if (Math.abs(c) < 1e-12) d = a >= b ? [1, 0] : [0, 1];
  else {
    const lmax = (a + b) / 2 + Math.sqrt(((a - b) / 2) ** 2 + c * c);   // min perp error = max eigenvector of scatter
    d = [c, lmax - a];
  }
  const L = Math.hypot(d[0], d[1]) || 1;
  d = [d[0] / L, d[1] / L];
  if (d[1] < 0 || (d[1] === 0 && d[0] < 0)) { d[0] = -d[0]; d[1] = -d[1]; }
  return { d, theta: Math.atan2(d[1], d[0]) };
}

function single(players: LinePlayer[], V: Pt): LineGroup {
  const { theta } = rayThroughV(V, players);
  const line = [...players].sort((a, b) => a.foot[0] - b.foot[0]).map((p) => p.id);
  const depthMean = mean(players.map((p) => pencilDepth(p.foot, V)));
  return { lines: [line], theta: [theta], depthMean: [depthMean], lineConfidence: [0], V, k: 1, confidence: 0 };
}

/** Vanishing point candidates: on the fitted horizon (real perspective), then far below the frame (top-down fallback). */
function candidateVs(minY: number, meanX: number, horizon: Horizon | null): Pt[] {
  const out: Pt[] = [];
  if (horizon) {
    const vy = Math.min(horizon.y, minY - 0.02);   // keep every foot below V so atan2 never crosses its branch cut
    out.push([meanX, vy]);                          // the width VP sits near the camera's look-at x
    for (let vx = -2; vx <= 3.0001; vx += 0.5) out.push([vx, vy]);
  }
  out.push([meanX, minY - AFFINE_DROP]);
  return out;
}

/**
 * Group outfielders into formation rows as a pencil of rays through a vanishing point: Jenks natural breaks on the
 * 1D formation-depth coordinate (k = 2..4, silhouette choice with a nudge toward 3 lines when >= 7 outfielders, min 2
 * per line), then each line refined as an LS ray through V, everyone reassigned to the nearest ray, singleton rays
 * dropped (kept at k = 4: a four-line block can legitimately end with a lone striker), lines ordered back to front
 * for the attack axis (theta falls monotonically with image x, so -axis*theta ascends back-to-front).
 */
export function groupLines(players: LinePlayer[], o: GroupOpts): LineGroup {
  const n = players.length;
  if (n === 0) return { lines: [], theta: [], depthMean: [], lineConfidence: [], V: [0, 0], k: 0, confidence: 0 };
  const meanX = mean(players.map((p) => p.foot[0])), minY = Math.min(...players.map((p) => p.foot[1]));
  const affine: Pt = [meanX, minY - AFFINE_DROP];
  if (n < 4) return single(players, affine);   // too few for a pencil split
  const kMax = Math.min(o.kMax ?? 4, n >> 1);
  const Vs: Pt[] = o.V ? [o.V] : candidateVs(minY, meanX, o.horizon);
  let best: { V: Pt; assign: number[]; k: number; sil: number; score: number } | null = null;
  for (const V of Vs) {
    // Screen-space formation depth: lines of constant pitch depth are a pencil through V (FORMATION_RESEARCH 2).
    // Clustering this 1D coordinate, never screen x, is what makes a perspective back four one line.
    const dep = players.map((p) => pencilDepth(p.foot, V));
    for (let k = 2; k <= kMax; k++) {
      const assign = jenks1d(dep.map((v) => ({ v })), k);
      const sil = silhouette(dep, assign, k);
      const score = sil - (n >= 7 && k !== 3 ? PEN3 : 0);
      if (!best || score > best.score + 1e-9) best = { V, assign: [...assign], k, sil, score };
    }
  }
  const b = best as { V: Pt; assign: number[]; k: number; sil: number };
  const byC: number[][] = Array.from({ length: b.k }, () => []);
  b.assign.forEach((c, i) => byC[c].push(i));
  const rays = byC.map((g) => rayThroughV(b.V, g.map((i) => players[i])));
  const perp = (i: number, d: Pt) => {
    const rx = (players[i].foot[0] - b.V[0]) * ASPECT, ry = players[i].foot[1] - b.V[1];
    return Math.abs(rx * d[1] - ry * d[0]);
  };
  const next: number[][] = Array.from({ length: b.k }, () => []);   // reassign to the nearest ray
  for (let i = 0; i < n; i++) {
    let bi = 0, bd = Infinity;
    for (let j = 0; j < b.k; j++) { const d = perp(i, rays[j].d); if (d < bd) { bd = d; bi = j; } }
    next[bi].push(i);
  }
  const lines: number[][] = [], theta: number[] = [];
  const singles: number[] = [];
  for (const { j } of rays.map((r, j) => ({ j, key: -o.attackAxis * r.theta })).sort((x, y) => x.key - y.key)) {
    // a singleton is noise at k=3, but a 4-line block can legitimately end with a lone striker
    if (next[j].length < 2 && b.k < 4) { singles.push(...next[j]); continue; }
    lines.push(next[j].map((i) => players[i].id));
    theta.push(rays[j].theta);
  }
  if (lines.length === 0) return single(players, b.V);
  for (const i of singles) {
    let bi = 0, bd = Infinity;
    for (let j = 0; j < theta.length; j++) {
      const d = perp(i, [Math.cos(theta[j]), Math.sin(theta[j])]);
      if (d < bd) { bd = d; bi = j; }
    }
    lines[bi].push(players[i].id);
  }
  const byId = new Map(players.map((p) => [p.id, p]));
  for (const line of lines) line.sort((a, c) => (byId.get(a)?.foot[0] ?? 0) - (byId.get(c)?.foot[0] ?? 0));   // left to right
  const depthMean = lines.map((line) => mean(line.map((id) => {
    const p = byId.get(id);
    return p ? pencilDepth(p.foot, b.V) : 0;
  })));
  const spread = lines.map((line, j) => {
    const vals = line.map((id) => { const p = byId.get(id); return p ? pencilDepth(p.foot, b.V) : 0; });
    return Math.sqrt(mean(vals.map((v) => (v - depthMean[j]!) * (v - depthMean[j]!))));
  });
  const lineConfidence = depthMean.map((m, j) => {
    let gap = Infinity;
    for (let q = 0; q < depthMean.length; q++) if (q !== j) gap = Math.min(gap, Math.abs(depthMean[q]! - m));
    if (!Number.isFinite(gap)) return 0;
    const w = spread[j]!;
    return clamp((gap - w) / (gap + w + 1e-9), 0, 1);
  });
  return { lines, theta, depthMean, lineConfidence, V: b.V, k: lines.length, confidence: clamp(b.sil, 0, 1) };
}

const DEPTH_TAU = 0.7;      // s, EWMA on the per-track formation-depth coordinate
const SWITCH_MARGIN = 0.35; // x H: residual improvement a line switch must clear
const SWITCH_DWELL = 1.5;   // s, the better line must persist before the switch happens
const LINE_STABLE = 2;      // s, unchanged membership before a line is marked stable
const LABEL_STABLE = 3;     // s, a candidate label must hold this long to promote
const LABEL_DWELL = 10;     // s, minimum dwell before the next promotion
const STICKY_SLACK = 0.02;  // silhouette slack for keeping last frame's V
const V_JUMP = 0.5;         // a V move beyond this (either axis) resets the depth EWMAs: regime change

export interface LineTrackerOpts { t: number; dt: number; H: number; attackAxis: 1 | -1; horizon: Horizon | null; canLabel?: boolean }
export interface TrackedShape {
  lines: number[][];
  label: string | null;
  k: number;
  confidence: number;
  /** Per-line confidence, renderer fades a line below its own gate. */
  lineConfidence: number[];
  /** Per-line membership has held for ~2 s. */
  stable: boolean[];
  changed: boolean;
}

interface TrackState { d: Ewma; line: number; cand: number; candT: number }

/** Per-team formation tracker on top of groupLines: per-track depth EWMA (diagnostics), raw-depth line membership with a 1.5 s switch dwell, ~2 s line stability and label hysteresis. */
export class LineTracker {
  private st = new Map<number, TrackState>();
  private lastV: Pt | null = null;
  private lastK = 0;
  private label: string | null = null;
  private labelT = 0;
  private cand: string | null = null;
  private candT = 0;
  private lineSigs: string[] = [];
  private lineSince: number[] = [];

  update(players: LinePlayer[], o: LineTrackerOpts): TrackedShape {
    const base = { attackAxis: o.attackAxis, H: o.H, horizon: o.horizon };
    const free = groupLines(players, base);
    const sticky = this.lastV ? groupLines(players, { ...base, V: this.lastV }) : null;
    const g = sticky && sticky.confidence >= free.confidence - STICKY_SLACK ? sticky : free;
    if (this.lastV && (Math.abs(g.V[0] - this.lastV[0]) > V_JUMP || Math.abs(g.V[1] - this.lastV[1]) > V_JUMP)) {
      for (const s of this.st.values()) { s.d.v = null; s.line = -1; }   // regime change: depth and indices reset
    }
    this.lastV = g.V;
    if (g.k !== this.lastK) { for (const s of this.st.values()) { s.line = -1; s.cand = -1; } this.lastK = g.k; }   // indices changed
    const live = new Set(players.map((p) => p.id));
    for (const id of [...this.st.keys()]) if (!live.has(id)) this.st.delete(id);

    // Desired line per track from the smoothed formation depth; residual is |d - line mean d|.
    const ds = players.map((p) => pencilDepth(p.foot, g.V));
    const des = players.map((p, i) => {
      const s = this.st.get(p.id) ?? { d: new Ewma(DEPTH_TAU), line: -1, cand: -1, candT: o.t };
      this.st.set(p.id, s);
      s.d.push(ds[i]!, o.dt);   // smoothed per-track depth (diagnostics / future use)
      // Membership decisions use the raw depth so the 1.5 s dwell is the actual latency budget; the EWMA
      // stays available for line means and jitter diagnostics.
      const d = ds[i]!;
      let want = -1, dWant = Infinity;
      for (let j = 0; j < g.depthMean.length; j++) {
        const dd = Math.abs(d - g.depthMean[j]!);
        if (dd < dWant) { dWant = dd; want = j; }
      }
      const dCur = s.line >= 0 && s.line < g.depthMean.length ? Math.abs(d - g.depthMean[s.line]!) : Infinity;
      return { s, want, dWant, dCur };
    });
    for (const { s, want, dWant, dCur } of des) {
      if (want < 0) continue;
      if (s.line < 0 || s.line >= g.theta.length || !Number.isFinite(dCur)) { s.line = want; s.cand = -1; continue; }
      if (want === s.line) { s.cand = -1; continue; }
      if (dCur - dWant > SWITCH_MARGIN * o.H) {
        if (s.cand !== want) { s.cand = want; s.candT = o.t; }
        else if (o.t - s.candT >= SWITCH_DWELL) { s.line = want; s.cand = -1; }
      } else s.cand = -1;
    }
    // Rebuild lines in back-to-front order from the hysteretic membership, dropping singletons and sorting
    // every line left to right for the renderer.
    const lines: number[][] = g.theta.map(() => []);
    for (let i = 0; i < players.length; i++) { const s = des[i].s; if (s.line >= 0 && s.line < lines.length) lines[s.line].push(players[i].id); }
    const keptIdx = lines.map((l, j) => (l.length >= 2 ? j : -1)).filter((j) => j >= 0);
    for (const s of this.st.values()) {
      if (s.line >= 0) { const pos = keptIdx.indexOf(s.line); if (pos < 0) { s.line = -1; s.cand = -1; } }
    }
    const byId = new Map(players.map((p) => [p.id, p]));
    const kept = keptIdx.map((j) => [...lines[j]!].sort((a, b) => (byId.get(a)?.foot[0] ?? 0) - (byId.get(b)?.foot[0] ?? 0)));
    const depthOf = new Map(players.map((p) => [p.id, pencilDepth(p.foot, g.V)]));
    const means = kept.map((line) => mean(line.map((id) => depthOf.get(id) ?? 0)));
    const spreads = kept.map((line, j) => {
      const vals = line.map((id) => depthOf.get(id) ?? 0);
      return Math.sqrt(mean(vals.map((v) => (v - means[j]!) * (v - means[j]!))));
    });
    const lineConfidence = means.map((m, j) => {
      let gap = Infinity;
      for (let q = 0; q < means.length; q++) if (q !== j) gap = Math.min(gap, Math.abs(means[q]! - m));
      if (!Number.isFinite(gap)) return 0;
      const w = spreads[j]!;
      return clamp((gap - w) / (gap + w + 1e-9), 0, 1);
    });
    const sigs = kept.map((line) => [...line].sort((a, b) => a - b).join(','));
    if (sigs.length !== this.lineSigs.length) { this.lineSigs = sigs; this.lineSince = sigs.map(() => o.t); }
    else {
      for (let j = 0; j < sigs.length; j++) if (sigs[j] !== this.lineSigs[j]) this.lineSince[j] = o.t;
      this.lineSigs = sigs;
    }
    const stable = kept.map((_, j) => o.t - (this.lineSince[j] ?? o.t) >= LINE_STABLE);

    // label hysteresis: 3 s stable promotes, 10 s minimum dwell
    const candLabel = (o.canLabel ?? true) && kept.length >= 3 ? kept.map((l) => l.length).join('-') : null;
    let changed = false;
    if (candLabel !== this.cand) { this.cand = candLabel; this.candT = o.t; }
    if (candLabel === null) {
      if (this.label !== null && o.t - this.candT >= LABEL_STABLE) this.label = null;   // long drought decays it
    } else if (candLabel !== this.label && o.t - this.candT >= LABEL_STABLE && (this.label === null || o.t - this.labelT >= LABEL_DWELL)) {
      changed = this.label !== null;
      this.label = candLabel;
      this.labelT = o.t;
    }
    return {
      lines: kept, label: this.label, k: kept.length, confidence: g.confidence,
      lineConfidence, stable, changed,
    };
  }
}
