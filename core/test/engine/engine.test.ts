import { describe, expect, it } from 'vitest';
import type { Track } from '../../src/types';
import { HysteresisGate, PossessionFSM, cluster1D, convexHull, polygonArea, segDist } from '../../src/engine';

const tr = (id: number, team: 'A' | 'B', x: number, y: number): Track => ({
  id, cls: 'player', score: 0.9, box: [x - 0.01, y - 0.12, x + 0.01, y], age: 5, hits: 20, timeSinceUpdate: 0, tMedia: 0,
  foot: [x, y], vel: [0, 0], team, teamMargin: 0.9,
});

describe('HysteresisGate', () => {
  it('needs 0.6 s at >= 0.75 to show, holds between 0.6 and 0.75, hides below 0.6 and re-enters through 0.6 s again', () => {
    const g = new HysteresisGate();
    expect(g.update(0.8, 0)).toBe('hidden');
    expect(g.update(0.8, 0.5)).toBe('hidden');
    expect(g.update(0.8, 0.61)).toBe('shown');
    expect(g.update(0.7, 1)).toBe('held');
    expect(g.update(0.5, 1.1)).toBe('hidden');
    expect(g.update(0.9, 1.2)).toBe('hidden');
    expect(g.update(0.9, 1.9)).toBe('shown');
  });
});

describe('PossessionFSM', () => {
  const H = 0.12;
  const players = [tr(1, 'A', 0.3, 0.6), tr(2, 'B', 0.7, 0.6)];
  it('needs 0.5 s of nearest-in-radius before crediting, then credits only the holder', () => {
    const f = new PossessionFSM();
    let t = 0;
    for (; t < 0.4; t += 0.1) f.update(0.1, [0.3, 0.6], players, H);
    expect(f.state).toBe('DEAD');
    for (; t < 1.5; t += 0.1) f.update(0.1, [0.3, 0.6], players, H);
    expect(f.state).toBe('A');
    expect(f.credited.B).toBe(0);
    expect(f.credited.A).toBeGreaterThan(0.8);
  });
  it('a ball gap credits no one and a regain after the gap is not a turnover', () => {
    const f = new PossessionFSM();
    for (let i = 0; i < 15; i++) f.update(0.1, [0.3, 0.6], players, H);
    const before = { ...f.credited };
    for (let i = 0; i < 30; i++) f.update(0.1, null, players, H);
    expect(f.credited).toEqual(before);
    expect(f.state).toBe('DEAD');
    let turnover = false;
    for (let i = 0; i < 15; i++) if (f.update(0.1, [0.7, 0.6], players, H).turnover) turnover = true;
    expect(turnover).toBe(false);
    expect(f.state).toBe('B');
  });
  it('flicker shorter than the hysteresis does not flip possession; a sustained change is a turnover', () => {
    const f = new PossessionFSM();
    for (let i = 0; i < 15; i++) f.update(0.1, [0.3, 0.6], players, H);
    for (let i = 0; i < 3; i++) f.update(0.1, [0.7, 0.6], players, H);
    expect(f.state).toBe('A');
    f.update(0.1, [0.3, 0.6], players, H);
    let got: string | undefined;
    for (let i = 0; i < 8; i++) { const s = f.update(0.1, [0.7, 0.6], players, H); if (s.turnover) got = s.turnover.to; }
    expect(got).toBe('B');
  });
});

describe('geometry', () => {
  it('clusters lines, hull area and segment distance', () => {
    const c = cluster1D([{ id: 1, v: 0.1 }, { id: 2, v: 0.11 }, { id: 3, v: 0.4 }, { id: 4, v: 0.7 }, { id: 5, v: 0.71 }], 0.1, 4);
    expect(c.map((x) => x.length)).toEqual([2, 1, 2]);
    const hull = convexHull([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]]);
    expect(hull.length).toBe(4);
    expect(polygonArea(hull)).toBeGreaterThan(0);
    expect(segDist([0.5, 0.5], [0.2, 0.5], [0.8, 0.5])).toBeCloseTo(0, 6);
  });
});

describe('Engine stats are structured numbers', () => {
  it('per-team stats are {A,B} numbers, never strings', async () => {
    const { Engine, TEAM_STATS } = await import('../../src/engine');
    const e = new Engine();
    const tracks: Track[] = [];
    for (let i = 0; i < 5; i++) { tracks.push(tr(i + 1, 'A', 0.3 + i * 0.05, 0.5 + i * 0.02)); tracks.push(tr(i + 20, 'B', 0.5 + i * 0.05, 0.5 + i * 0.02)); }
    let out = e.update({ t: 0, tMedia: 0, playbackRate: 1, globalMotion: [0, 0], quality: 3, frameIdx: 0, scene: { kind: 'WIDE', confidence: 1 }, tracks, ball: { xy: [0.3, 0.5], visibility: 1, coastingS: 0, state: 'visible' }, teamsCalibrated: true });
    for (let k = 1; k < 40; k++) out = e.update({ t: k * 0.1, tMedia: k * 0.1, playbackRate: 1, globalMotion: [0, 0], quality: 3, frameIdx: k, scene: { kind: 'WIDE', confidence: 1 }, tracks, ball: { xy: [0.3, 0.5], visibility: 1, coastingS: 0, state: 'visible' }, teamsCalibrated: true });
    for (const k of TEAM_STATS) {
      if (k === 'possession') continue;
      const v = out.match.stats[k].value as { A: number; B: number };
      expect(typeof v.A, k).toBe('number');
      expect(typeof v.B, k).toBe('number');
    }
    expect(out.match.stats.passes.value).toEqual({ A: expect.any(Number), B: expect.any(Number) });
  });
});
