import { describe, expect, it } from 'vitest';
import type { Track } from '../../src/types';
import { ASPECT, cluster1D, type Pt } from '../../src/engine/geometry';
import { LineTracker, estimateHorizon, groupLines, pencilTheta, type LinePlayer } from '../../src/engine/lines';

// Pinhole side-line camera: a ground point (u along the pitch, w across) at distance d = d0 + w*dW projects to
// boxH = f/d, x = cx + f*(u-u0)/d, y = yH + slope*boxH. Formation rows (constant u, varying w) are rays through
// (cx, yH): a back four comes out as a diagonal in screen space and the rows' x-ranges overlap, so clustering on
// x cannot recover them while the pencil of rays through V can.
const CAM = { cx: 0.5, u0: 0, f: 0.25, d0: 1.1, dW: 2, yH: 0.08, slope: 1.5 };
const project = (u: number, w: number): { foot: Pt; boxH: number } => {
  const d = CAM.d0 + w * CAM.dW;
  return { foot: [CAM.cx + (CAM.f * (u - CAM.u0)) / d, CAM.yH + CAM.slope * (CAM.f / d)], boxH: CAM.f / d };
};
type Row = [u: number, ws: number[]];
const layout = (rows: Row[]): LinePlayer[] => {
  let id = 1;
  return rows.flatMap(([u, ws]) => ws.map((w) => { const p = project(u, w); return { id: id++, ...p }; }));
};
const F442: Row[] = [[0.18, [0, 0.35, 0.7, 1]], [0.38, [0, 0.35, 0.7, 1]], [0.55, [0.35, 0.75]]];   // back / mid / strikers
const F433: Row[] = [[0.18, [0, 0.35, 0.7, 1]], [0.38, [0.2, 0.5, 0.8]], [0.62, [0.15, 0.5, 0.85]]];
const MOVED: Row[] = [[0.18, [0.35, 0.7, 1]], [0.38, [0, 0.15, 0.35, 0.7, 1]], [0.55, [0.35, 0.75]]];   // a back pushed to the mid row: 3-5-2

const tr = (id: number, x: number, y: number, h: number, team: 'A' | 'B' = 'A'): Track => ({
  id, cls: 'player', score: 0.9, box: [x - 0.01, y - h, x + 0.01, y], age: 5, hits: 20, timeSinceUpdate: 0, tMedia: 0,
  foot: [x, y], vel: [0, 0], team, teamMargin: 0.9,
});
const tracks = (ps: LinePlayer[], team: 'A' | 'B' = 'A'): Track[] => ps.map((p) => tr(p.id, p.foot[0], p.foot[1], p.boxH, team));
const H_MED = 0.25 / 2.15;   // median box height of the projected layouts

describe('pencilTheta', () => {
  it('measures the ray angle from V in aspect-corrected space', () => {
    expect(pencilTheta([0.6, 0.5], [0.5, 0.1])).toBeCloseTo(Math.atan2(0.4, 0.1 * ASPECT), 6);
    expect(pencilTheta([0.5, 0.5], [0.5, 0.1])).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe('estimateHorizon', () => {
  it('recovers horizon and slope from synthetic y/h and drops gross outliers', () => {
    let s = 42;
    const noise = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return ((s / 0x3fffffff) - 1) * 0.004; };
    const ts: Track[] = [];
    for (let i = 0; i < 30; i++) {
      const h = 0.06 + 0.005 * i, x = 0.3 + 0.01 * i;
      ts.push(tr(i + 1, x, 0.07 + 0.09 * h + noise(), h));
    }
    for (let i = 0; i < 3; i++) {   // three players far off the ground plane
      const h = 0.06 + 0.005 * i;
      ts.push(tr(100 + i, 0.2 + 0.01 * i, 0.07 + 0.09 * h + 0.12, h));
    }
    const hz = estimateHorizon(ts);
    expect(hz).not.toBeNull();
    expect(hz!.y).toBeCloseTo(0.07, 2);
    expect(hz!.slope).toBeCloseTo(0.09, 2);
    expect(hz!.n).toBeGreaterThanOrEqual(27);
  });
  it('returns null when the boxes carry no depth spread', () => {
    expect(estimateHorizon([tr(1, 0.3, 0.5, 0.12), tr(2, 0.4, 0.5, 0.12), tr(3, 0.5, 0.5, 0.12), tr(4, 0.6, 0.5, 0.12)])).toBeNull();
  });
});

describe('groupLines', () => {
  it('splits a perspective-projected 4-4-2 into 4/4/2 back to front and labels it 4-4-2', () => {
    const ps = layout(F442);
    // sanity: in screen space the rows interleave in x, so the old constant-x split cannot see the lines
    const first4 = [...ps].sort((a, b) => a.foot[0] - b.foot[0]).slice(0, 4).map((p) => p.id);
    expect(Math.max(...first4)).toBeGreaterThan(4);   // the x-smallest four mix two rows
    expect(cluster1D(ps.map((p) => ({ id: p.id, v: p.foot[0] * ASPECT })), 0.6 * H_MED, 4).map((l) => l.length)).not.toEqual([4, 4, 2]);
    const hz = estimateHorizon(tracks(ps));
    expect(hz!.y).toBeCloseTo(CAM.yH, 2);
    expect(hz!.slope).toBeCloseTo(CAM.slope, 1);
    const g = groupLines(ps, { attackAxis: 1, H: H_MED, horizon: hz });
    expect(g.lines.map((l) => l.length)).toEqual([4, 4, 2]);
    expect(g.theta[0]).toBeGreaterThan(g.theta[1]!);   // back line leans furthest from the VP: attacks image right
    expect(g.k).toBe(3);
    expect(g.confidence).toBeGreaterThan(0.9);
    const tk = new LineTracker();
    for (let t = 0; t <= 4.001; t += 0.1) tk.update(ps, { t, dt: 0.1, H: H_MED, attackAxis: 1, horizon: hz });
    expect(tk.update(ps, { t: 4.1, dt: 0.1, H: H_MED, attackAxis: 1, horizon: hz }).label).toBe('4-4-2');
  });

  it('splits a perspective-projected 4-3-3 into 4/3/3 and labels it 4-3-3', () => {
    const ps = layout(F433);
    const hz = estimateHorizon(tracks(ps));
    const g = groupLines(ps, { attackAxis: 1, H: H_MED, horizon: hz });
    expect(g.lines.map((l) => l.length)).toEqual([4, 3, 3]);
    expect(g.k).toBe(3);
    const tk = new LineTracker();
    for (let t = 0; t <= 4.001; t += 0.1) tk.update(ps, { t, dt: 0.1, H: H_MED, attackAxis: 1, horizon: hz });
    expect(tk.update(ps, { t: 4.1, dt: 0.1, H: H_MED, attackAxis: 1, horizon: hz }).label).toBe('4-3-3');
  });

  it('keeps the flat top-down 4-4-2 columns through the degenerate (parked-V) regime', () => {
    // synth-style: no x convergence, boxH = 0.07 + 0.09*y
    const ps: LinePlayer[] = [];
    let id = 1;
    for (const [x, ys] of [[0.24, [0.38, 0.52, 0.66, 0.8]], [0.38, [0.38, 0.52, 0.66, 0.8]], [0.52, [0.5, 0.68]]] as [number, number[]][]) {
      for (const y of ys) ps.push({ id: id++, foot: [x, y], boxH: 0.07 + 0.09 * y });
    }
    const hz = estimateHorizon(tracks(ps));
    const g = groupLines(ps, { attackAxis: 1, H: 0.12, horizon: hz });
    expect(g.lines.map((l) => l.length)).toEqual([4, 4, 2]);
  });
});

describe('LineTracker stability', () => {
  const topDown = (): LinePlayer[] => {
    const ps: LinePlayer[] = [];
    let id = 1;
    for (const [x, ys] of [[0.24, [0.38, 0.52, 0.66, 0.8]], [0.38, [0.38, 0.52, 0.66, 0.8]], [0.52, [0.5, 0.68]]] as [number, number[]][]) {
      for (const y of ys) ps.push({ id: id++, foot: [x, y], boxH: 0.07 + 0.09 * y });
    }
    return ps;
  };

  it('keeps formation lines stable under +/-10 px jitter, sorts left to right and marks stable after ~2 s', () => {
    const ps = topDown();
    const hz = estimateHorizon(tracks(ps));
    const tk = new LineTracker();
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    let ref: string[] | null = null;
    let firstStable = -1;
    let last: ReturnType<LineTracker['update']> | null = null;
    for (let k = 0; k <= 50; k++) {
      const t = k * 0.1;
      const jittered = ps.map((p) => ({
        ...p,
        foot: [p.foot[0] + (rnd() * 20) / 1920, p.foot[1] + (rnd() * 20) / 1080] as Pt,
      }));
      last = tk.update(jittered, { t, dt: 0.1, H: 0.12, attackAxis: 1, horizon: hz });
      if (k === 10) ref = last.lines.map((l) => [...l].sort((a, b) => a - b).join(','));
      if (k > 10 && ref) {
        expect(last.lines.map((l) => [...l].sort((a, b) => a - b).join(','))).toEqual(ref);
      }
      if (firstStable < 0 && last.stable.length && last.stable.every(Boolean)) firstStable = t;
    }
    expect(ref).not.toBeNull();
    expect(firstStable).toBeGreaterThanOrEqual(2);
    expect(firstStable).toBeLessThanOrEqual(3);
    const out = last!;
    for (const line of out.lines) {
      const xs = line.map((id) => ps.find((p) => p.id === id)!.foot[0]);
      expect(xs).toEqual([...xs].sort((a, b) => a - b));
    }
    expect(out.lineConfidence).toHaveLength(out.lines.length);
    for (const c of out.lineConfidence) { expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThanOrEqual(1); }
    expect(out.label).toBe('4-4-2');
  });

  it('changes a player line only after ~1.5 s of sustained evidence', () => {
    const ps = topDown();
    const hz = estimateHorizon(tracks(ps));
    const tk = new LineTracker();
    const moved = ps.map((p) => (p.id === 1 ? { ...p, foot: [0.38, 0.38] as Pt } : p));
    const lineOf = (out: ReturnType<LineTracker['update']>, id: number) => out.lines.findIndex((l) => l.includes(id));
    let before = -1;
    for (let k = 0; k <= 40; k++) {
      const t = k * 0.1;
      const o = tk.update(ps, { t, dt: 0.1, H: 0.12, attackAxis: 1, horizon: hz });
      if (k === 40) before = lineOf(o, 1);
    }
    expect(before).toBeGreaterThanOrEqual(0);
    let at1s = -2;
    for (let k = 41; k <= 55; k++) {
      const t = k * 0.1;
      const o = tk.update(moved, { t, dt: 0.1, H: 0.12, attackAxis: 1, horizon: hz });
      if (k === 55) at1s = lineOf(o, 1);
    }
    expect(at1s).toBe(before);                       // 1.5 s dwell not yet reached
    const after = tk.update(moved, { t: 5.7, dt: 0.1, H: 0.12, attackAxis: 1, horizon: hz });
    expect(lineOf(after, 1)).not.toBe(before);
  });
});

describe('LineTracker', () => {
  const step = (tk: LineTracker, ps: LinePlayer[], t: number) =>
    tk.update(ps, { t, dt: 0.1, H: H_MED, attackAxis: 1, horizon: estimateHorizon(tracks(ps)) });

  it('needs 3 s of stability before the label shows', () => {
    const ps = layout(F442);
    const tk = new LineTracker();
    let last: string | null = null;
    for (let t = 0; t <= 2.901; t += 0.1) last = step(tk, ps, t).label;
    expect(last).toBeNull();
    expect(step(tk, ps, 3.0).label).toBe('4-4-2');
  });

  it('a one-frame outlier neither flips the label nor the line membership', () => {
    const ps = layout(F442), bad = layout(MOVED);
    const tk = new LineTracker();
    for (let t = 0; t <= 4.001; t += 0.1) step(tk, ps, t);
    const out = step(tk, bad, 4.1);
    expect(out.lines.map((l) => l.length)).toEqual([4, 4, 2]);   // membership held through the EWMA + hysteresis
    expect(out.label).toBe('4-4-2');
    expect(step(tk, ps, 4.2).label).toBe('4-4-2');
  });

  it('a sustained change does flip: 3 s stable after the 10 s minimum dwell', () => {
    const ps = layout(F442), bad = layout(MOVED);
    const tk = new LineTracker();
    for (let t = 0; t <= 4.001; t += 0.1) step(tk, ps, t);
    for (let t = 4.1; t <= 12.901; t += 0.1) {
      expect(step(tk, bad, t).label, `t=${t.toFixed(1)}`).toBe('4-4-2');   // inside the 10 s dwell
    }
    expect(step(tk, bad, 14.1).label).toBe('3-5-2');
  });
});
