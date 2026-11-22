import { describe, expect, it } from 'vitest';
import type { FrameState, Track } from '../../src/types';
import { ASPECT, Engine, perspectiveOf, withinMetres } from '../../src/engine';

/** Synthetic broadcast: a pinhole ground plane y = -0.1 + 5 * boxH, so a player at y is 0.02 + 0.2y tall. */
const tr = (id: number, team: 'A' | 'B' | 'OTHER', x: number, y: number, margin = 0.9, cls: Track['cls'] = 'player'): Track => {
  const h = 0.02 + 0.2 * y;
  return {
    id, cls, score: 0.92, box: [x - 0.012, y - h, x + 0.012, y], age: 8, hits: 30, timeSinceUpdate: 0, tMedia: 0,
    foot: [x, y], vel: [0, 0], team, teamMargin: margin,
  };
};

const frame = (t: number, tracks: Track[], ballXY: [number, number]): FrameState => ({
  t, tMedia: t, playbackRate: 1, globalMotion: [0, 0], quality: 3, frameIdx: Math.round(t * 10),
  scene: { kind: 'WIDE', confidence: 1 }, tracks,
  ball: { xy: ballXY, visibility: 1, coastingS: 0, state: 'visible' }, teamsCalibrated: true,
});

describe('perspective radius', () => {
  it('uses the local player height, so the same screen distance is near at the bottom and far at the top', () => {
    const p = perspectiveOf([tr(1, 'A', 0.5, 0.9), tr(2, 'A', 0.6, 0.88), tr(3, 'A', 0.5, 0.3), tr(4, 'A', 0.6, 0.32)], null);
    // Same normalised gap at both depths; 10 m is 10/1.8 body heights at that y.
    expect(withinMetres([0.3, 0.9], [0.6, 0.9], 10, p)).toBe(true);
    expect(withinMetres([0.3, 0.3], [0.6, 0.3], 10, p)).toBe(false);
    // And the aspect correction is real: 0.3 in x is 0.533 frame heights.
    expect(0.3 * ASPECT).toBeCloseTo(0.533, 3);
  });
});

describe('overload fact', () => {
  const build = (nearA: number, nearB: number, extras: Track[] = []): { tracks: Track[]; ball: [number, number] } => {
    const ball: [number, number] = [0.30, 0.60];
    const aSpots: [number, number][] = [[0.33, 0.62], [0.275, 0.575], [0.35, 0.57], [0.26, 0.63]];
    const bSpots: [number, number][] = [
      [0.316, 0.586], [0.36, 0.62], [0.27, 0.62], [0.34, 0.55], [0.25, 0.56],
      [0.38, 0.58], [0.29, 0.65], [0.32, 0.53], [0.24, 0.61], [0.40, 0.60],
    ];
    const A: Track[] = [tr(1, 'A', 0.30, 0.60)];
    for (let i = 1; i < nearA; i++) A.push(tr(1 + i, 'A', ...aSpots[(i - 1) % aSpots.length]!));
    A.push(tr(31, 'A', 0.06, 0.22), tr(32, 'A', 0.17, 0.22), tr(33, 'A', 0.82, 0.22), tr(34, 'A', 0.93, 0.22));
    const B: Track[] = [];
    for (let i = 0; i < nearB; i++) B.push(tr(11 + i, 'B', ...bSpots[i % bSpots.length]!));
    B.push(tr(41, 'B', 0.86, 0.22), tr(42, 'B', 0.75, 0.25), tr(43, 'B', 0.08, 0.28), tr(44, 'B', 0.65, 0.24));
    return { tracks: [...A, ...B, ...extras], ball };
  };

  const run = (tracks: Track[], ball: [number, number]): ReturnType<Engine['update']> => {
    const e = new Engine();
    let out = e.update(frame(0, tracks, ball));
    for (let t = 0.1; t <= 3.2; t += 0.1) out = e.update(frame(t, tracks, ball));
    return out;
  };

  it('is valid only when the team on the ball has more players near it, held for at least 1 s', () => {
    const out = run(build(4, 2).tracks, [0.30, 0.60]);
    const f = out.detail.facts.overload;
    expect(f.valid).toBe(true);
    expect(f.team).toBe('A');
    expect(f.attackers).toBeGreaterThan(f.defenders);
    expect(f.attackers).toBeGreaterThanOrEqual(2);
    expect(f.sinceS).toBeGreaterThanOrEqual(1);
  });

  it('never reports 1 v 8: one attacker near the ball is not an overload', () => {
    const out = run(build(1, 8).tracks, [0.30, 0.60]);
    const f = out.detail.facts.overload;
    expect(f.valid).toBe(false);
    expect(f.attackers).toBeLessThanOrEqual(f.defenders);
    expect(f.attackers).toBeLessThan(5);
    // The raw near-ball count can still show a lopsided picture; the menu fact does not.
    expect(out.detail.facts.nearBall.A).toBeLessThan(out.detail.facts.nearBall.B);
    expect(out.detail.facts.nearBall.B).toBeGreaterThan(2);
  });

  it('excludes goalkeepers and team-uncertain tracks from both counts', () => {
    const base = build(4, 2);
    const gk = tr(90, 'OTHER', 0.301, 0.601, 0.9, 'goalkeeper');
    const unsure = tr(91, 'B', 0.302, 0.598, 0.2);
    const withNoise = run([...base.tracks, gk, unsure], base.ball);
    const clean = run(base.tracks, base.ball);
    expect(withNoise.detail.facts.overload.attackers).toBe(clean.detail.facts.overload.attackers);
    expect(withNoise.detail.facts.overload.defenders).toBe(clean.detail.facts.overload.defenders);
  });

  it('ranks key players by involvement instead of firing a callout', () => {
    const e = new Engine();
    const tracks = build(4, 2).tracks;
    let out = e.update(frame(0, tracks, [0.30, 0.60]));
    for (let t = 0.1; t <= 1.8; t += 0.1) out = e.update(frame(t, tracks, [0.30, 0.60]));
    // Play a pass to player 2 and let the FSM confirm the new carrier.
    for (let t = 1.9; t <= 4.0; t += 0.1) out = e.update(frame(t, tracks, [0.33, 0.62]));
    const kp = out.detail.facts.keyPlayer;
    expect(kp.candidates.length).toBeGreaterThan(0);
    expect(kp.candidates[0]!.received).toBeGreaterThanOrEqual(1);
    expect(kp.candidates[0]!.id).toBe(2);
    expect(kp.valid).toBe(true);
    expect(kp.targets).toContain(2);
  });
});
