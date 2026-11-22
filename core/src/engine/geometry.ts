// Screen-space geometry helpers and local-scale helpers. Pure, no DOM.
// Coordinates are normalised video coords. x is scaled by the aspect so distances are in "frame-height units",
// which matches Track.box heights. Metres are never claimed: one body height ~ 1.8 m at that player's depth, shown with "~".
import type { Track } from '../types';

export const ASPECT = 16 / 9;
export const BODY_M = 1.8;
export type Pt = [number, number];

export function dist(a: Pt, b: Pt): number { return Math.hypot((a[0] - b[0]) * ASPECT, a[1] - b[1]); }
export function bodyH(t: Track): number { return Math.max(1e-3, t.box[3] - t.box[1]); }

/**
 * Local perspective scale. The radius that matters is the real height of the players around the point, so
 * the primary estimate is the median box height of the outfielders nearest in screen y (a player right next
 * to the ball is its own scale). `estimateHorizon` is a fallback only: on shallow-depth footage its inverse
 * fit is ill-conditioned and can inflate a 10 m radius to half the frame. One body height ~ 1.8 m at that
 * depth, which is the only metric the engine ever claims.
 */
export interface HorizonLike { y: number; slope: number; n?: number }
export interface Perspective { medianH: number; horizon: HorizonLike | null; pts: { y: number; h: number }[] }

export function perspectiveOf(tracks: Track[], horizon: HorizonLike | null): Perspective {
  const pts = tracks
    .filter((t) => t.cls === 'player' && (t.team === 'A' || t.team === 'B') && t.timeSinceUpdate < 0.4)
    .map((t) => ({ y: t.foot[1], h: bodyH(t) }));
  const medianH = median(pts.map((p) => p.h)) || 0.1;
  return { medianH, horizon: horizon && horizon.slope > 1e-3 ? horizon : null, pts };
}

/** Box height (frame-height units) expected at screen y, from the nearest observed players first. */
export function heightAtY(y: number, p: Perspective): number {
  if (p.pts.length >= 2) {
    const near = [...p.pts].sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y)).slice(0, 3);
    return clamp(median(near.map((q) => q.h)), 0.35 * p.medianH, 2.5 * p.medianH);
  }
  const h = p.horizon ? (y - p.horizon.y) / p.horizon.slope : p.medianH;
  return clamp(h, 0.35 * p.medianH, 2.5 * p.medianH);
}

/** Approximate metres between two foot points, measured at a reference screen y (default: b's depth). */
export function distMetres(a: Pt, b: Pt, p: Perspective, atY = b[1]): number {
  return dist(a, b) * (BODY_M / heightAtY(atY, p));
}

/** True when a is within radiusM of b, with the local player height at the reference y (a perspective ellipse). */
export function withinMetres(a: Pt, b: Pt, radiusM: number, p: Perspective, atY = b[1]): boolean {
  return distMetres(a, b, p, atY) <= radiusM;
}
export function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1]!;
}
export function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
export function clamp(v: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, v)); }

/** Outfield-ish team players that are really in shot: confirmed tracker output, fresh, team A or B. Goalkeepers (team OTHER) excluded. */
export function teamPlayers(tracks: Track[]): Track[] {
  return tracks.filter((t) => (t.cls === 'player') && (t.team === 'A' || t.team === 'B') && t.timeSinceUpdate < 0.4);
}

export function nearest(p: Pt, tracks: Track[], skipId = -1): { track: Track; d: number } | null {
  let best: Track | null = null, bd = Infinity;
  for (const t of tracks) {
    if (t.id === skipId) continue;
    const d = dist(p, t.foot);
    if (d < bd) { bd = d; best = t; }
  }
  return best ? { track: best, d: bd } : null;
}

/** Distance from point p to segment a-b. */
export function segDist(p: Pt, a: Pt, b: Pt): number {
  const ax = a[0] * ASPECT, ay = a[1], bx = b[0] * ASPECT, by = b[1], px = p[0] * ASPECT, py = p[1];
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const u = L < 1e-12 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / L, 0, 1);
  return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
}

/** Convex hull (monotone chain) in aspect-corrected space. */
export function convexHull(pts: Pt[]): Pt[] {
  const p = pts.map((q) => [q[0] * ASPECT, q[1]] as Pt).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Pt[] = [], up: Pt[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]!; while (up.length >= 2 && cross(up[up.length - 2]!, up[up.length - 1]!, q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop();
  return lo.concat(up);
}
export function polygonArea(h: Pt[]): number {
  let s = 0;
  for (let i = 0; i < h.length; i++) { const a = h[i]!, b = h[(i + 1) % h.length]!; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s) / 2;
}

/** 1D clustering: split sorted values at the largest gaps that exceed minGap, at most maxK clusters. Returns clusters of ids, ordered by value. */
export function cluster1D(items: { id: number; v: number }[], minGap: number, maxK: number): number[][] {
  const s = [...items].sort((a, b) => a.v - b.v);
  if (!s.length) return [];
  const gaps = s.slice(1).map((it, i) => ({ i, g: it.v - s[i]!.v })).filter((x) => x.g >= minGap).sort((a, b) => b.g - a.g).slice(0, maxK - 1);
  const cuts = new Set(gaps.map((x) => x.i));
  const out: number[][] = [[]];
  s.forEach((it, i) => { out[out.length - 1]!.push(it.id); if (cuts.has(i)) out.push([]); });
  return out;
}

export class Ewma {
  v: number | null = null;
  constructor(public tauS: number) {}
  push(x: number, dt: number): number {
    if (this.v === null) { this.v = x; return x; }
    const a = 1 - Math.exp(-Math.max(0, dt) / this.tauS);
    this.v += a * (x - this.v);
    return this.v;
  }
}
