// Synthetic football world in normalised video coordinates. Deterministic in scenario time `st`,
// so the demo timeline and the gallery can ask "what does the world look like at t?".
import type {
  BallState, Gate, Liveness, MatchState, OverlaySnapshot, SceneKind, Stat, StatKey, StatValue, Team, Track,
} from '@tacticlens/core';

export const LOOP = 70;
export const PASS = 1.6;
const FLY = 0.5;
export const SEQ = [8, 6, 9, 7, 10, 5, 9, 11, 8, 7]; // team A carriers, in order

interface Player { id: number; team: Team; cls: Track['cls']; hx: number; hy: number; w1: number; w2: number; ph: number }
const PLAYERS: Player[] = [];
(function init() {
  const A: [number, number][] = [[0.07, 0.5], [0.22, 0.2], [0.22, 0.4], [0.22, 0.6], [0.22, 0.8], [0.4, 0.3], [0.4, 0.5], [0.4, 0.7], [0.58, 0.28], [0.58, 0.5], [0.58, 0.72]];
  const B: [number, number][] = [[0.93, 0.5], [0.78, 0.2], [0.78, 0.4], [0.78, 0.6], [0.78, 0.8], [0.64, 0.3], [0.64, 0.5], [0.64, 0.7], [0.47, 0.28], [0.47, 0.5], [0.47, 0.72]];
  A.forEach(([x, y], i) => PLAYERS.push({ id: i + 1, team: 'A', cls: i === 0 ? 'goalkeeper' : 'player', hx: x, hy: y, w1: 0.6 + (i % 4) * 0.15, w2: 0.5 + (i % 3) * 0.2, ph: i * 1.3 }));
  B.forEach(([x, y], i) => PLAYERS.push({ id: i + 12, team: 'B', cls: i === 0 ? 'goalkeeper' : 'player', hx: x, hy: y, w1: 0.55 + (i % 4) * 0.13, w2: 0.45 + (i % 3) * 0.2, ph: i * 1.7 + 0.5 }));
  PLAYERS.push({ id: 23, team: 'OTHER', cls: 'referee', hx: 0.52, hy: 0.42, w1: 0.5, w2: 0.4, ph: 2 });
})();

/** Camera pan shared by everything. */
const shift = (t: number): number => 0.035 * Math.sin(0.18 * t) + 0.012 * Math.sin(0.7 * t);
const shiftV = (t: number): number => (shift(t + 0.02) - shift(t - 0.02)) / 0.04;

export function playerPos(p: Player, t: number): [number, number] {
  const run = p.id === 11 ? 0.06 * Math.sin(0.5 * t) : 0; // a striker who keeps running
  const x = p.hx + 0.02 * Math.sin(p.w1 * t + p.ph) + shift(t) + run + (p.team === 'A' ? 0.02 : -0.01) * Math.sin(0.12 * t);
  const y = p.hy + 0.014 * Math.cos(p.w2 * t + p.ph * 0.7);
  return [x, y];
}
const byId = (id: number): Player => PLAYERS.find((p) => p.id === id)!;

export function carrierAt(st: number): { id: number; flying: boolean } {
  const k = Math.floor(st / PASS), s = (st - k * PASS) / PASS;
  const hold = 1 - FLY / PASS;
  const c = SEQ[k % SEQ.length]!, n = SEQ[(k + 1) % SEQ.length]!;
  return s < hold ? { id: c, flying: false } : { id: n, flying: true };
}
export const receiverAfter = (st: number, n: number): { id: number; at: number } => {
  const k = Math.floor(st / PASS) + n;
  return { id: SEQ[k % SEQ.length]!, at: k * PASS };
};

export function ballAt(st: number): [number, number] {
  const k = Math.floor(st / PASS), s = (st - k * PASS) / PASS;
  const hold = 1 - FLY / PASS;
  const c = byId(SEQ[k % SEQ.length]!), n = byId(SEQ[(k + 1) % SEQ.length]!);
  const pc = playerPos(c, st), pn = playerPos(n, st);
  if (s < hold) return [pc[0] + 0.007, pc[1] - 0.004];
  const f = (s - hold) / (1 - hold);
  const e = f * f * (3 - 2 * f);
  return [pc[0] + (pn[0] - pc[0]) * e + 0.007, pc[1] + (pn[1] - pc[1]) * e - 0.004 - 0.03 * Math.sin(f * Math.PI)];
}

export interface Phase { name: string; liveness: Liveness; calibrated: boolean; ball: BallState; coasting: number; scene: SceneKind; empty?: boolean; close?: boolean; replay?: boolean }

export function phaseAt(st: number): Phase {
  if (st < 3) return { name: 'cal', liveness: 'CALIBRATING', calibrated: false, ball: 'visible', coasting: 0, scene: 'WIDE' };
  if (st >= 26 && st < 27) return { name: 'search', liveness: 'LIVE', calibrated: true, ball: 'searching', coasting: st - 26, scene: 'WIDE' };
  if (st >= 27 && st < 29.6) return { name: 'out', liveness: 'LIVE', calibrated: true, ball: 'absent', coasting: Math.min(2, st - 26), scene: 'WIDE' };
  if (st >= 40 && st < 47) return { name: 'replay', liveness: 'REPLAY', calibrated: true, ball: 'visible', coasting: 0, scene: 'REPLAY', replay: true };
  if (st >= 50 && st < 54) return { name: 'close', liveness: 'CLOSE_UP', calibrated: true, ball: 'absent', coasting: 2, scene: 'CLOSE', close: true };
  if (st >= 55 && st < 59) return { name: 'commentary', liveness: 'COMMENTARY', calibrated: true, ball: 'absent', coasting: 2, scene: 'WIDE', empty: true };
  if (st >= 59 && st < 62) return { name: 'unsupported', liveness: 'UNSUPPORTED', calibrated: false, ball: 'absent', coasting: 2, scene: 'GRAPHIC', empty: true };
  return { name: 'live', liveness: 'LIVE', calibrated: true, ball: 'visible', coasting: 0, scene: 'WIDE' };
}

function stat<T>(value: T, o: { gate?: Gate; paused?: boolean; conf?: number } = {}): Stat<T> {
  return { value, confidence: o.conf ?? 0.9, updatedAt: 0, gate: o.gate ?? 'shown', paused: o.paused };
}

const KEYS: StatKey[] = ['possession', 'spell', 'passes', 'tempo', 'turnovers', 'pressure', 'timeToPressure', 'numbersNearBall', 'openOptions', 'freePlayers', 'teamExtent', 'compactness', 'blockGap', 'lineHeight', 'fieldTilt', 'switches', 'sprints', 'ballSpeed', 'momentum', 'kimiCalls', 'kimiSpeed', 'detectorHealth'];

export const MOCK_SCOUT = {
  names: { A: 'Harbor FC', B: 'Redstone' },
  kitColours: { A: '#3d8bff', B: '#ff4d4f' },
  score: [1, 0] as [number, number],
  clock: '23:14',
  source: 'kimi' as const,
};

export function matchAt(st: number, ph: Phase, withScout: boolean): MatchState {
  const ballPaused = ph.ball === 'absent' && ph.coasting >= 1;
  const c = carrierAt(st);
  const k = Math.floor(st / PASS);
  const aShare = Math.max(41, Math.min(62, 53 + Math.round(6 * Math.sin(st * 0.11))));
  const targets = [
    { id: SEQ[(k + 1) % SEQ.length]!, score: 0.86 }, { id: SEQ[(k + 2) % SEQ.length]!, score: 0.58 }, { id: 4, score: 0.34 },
  ].filter((t) => t.id !== c.id);
  const num = (v: number, dec = 0): number => Number(v.toFixed(dec));
  const pair = (a: number, b: number): { A: number; B: number } => ({ A: a, B: b });
  const val: Record<StatKey, StatValue> = {
    possession: aShare, spell: num(st % 18, 0), passes: pair(Math.floor(st / PASS), Math.floor(st / PASS / 2)), tempo: pair(14 + Math.round(3 * Math.sin(st * 0.2)), 11), turnovers: pair(Math.floor(st / 18), Math.floor(st / 14)),
    pressure: 1 + (Math.floor(st / 2) % 4), timeToPressure: 2.1, numbersNearBall: pair(4 + (Math.floor(st / 4) % 2), 3), openOptions: 2 + (Math.floor(st / 3) % 3),
    freePlayers: pair(1 + (Math.floor(st / 5) % 3), 1), teamExtent: pair(38, 31), compactness: pair(0.62 + 0.06 * Math.sin(st * 0.15), 0.55), blockGap: 14, lineHeight: pair(0.58 + 0.04 * Math.sin(st * 0.1), 0.42),
    fieldTilt: pair(61, 39), switches: Math.floor(st / 12), sprints: 3, ballSpeed: 'fast', momentum: 0.3, kimiCalls: '0/0', kimiSpeed: 240, detectorHealth: 7.8,
  };
  const ballDep = new Set<StatKey>(['possession', 'spell', 'passes', 'tempo', 'turnovers', 'pressure', 'timeToPressure', 'numbersNearBall', 'openOptions', 'switches', 'ballSpeed', 'momentum', 'fieldTilt']);
  const stats = {} as Record<StatKey, Stat<StatValue>>;
  for (const key of KEYS) stats[key] = stat(val[key], { paused: ballDep.has(key) && ballPaused });
  return {
    liveness: ph.liveness,
    possession: stat({ A: aShare, B: 100 - aShare, current: (c.id < 12 ? 'A' : 'B') as Team }, { paused: ballPaused, gate: ph.calibrated ? 'shown' : 'hidden' }),
    shape: {
      A: stat({ label: '4-3-3', lines: [[2, 3, 4, 5], [6, 7, 8], [9, 10, 11]] }, { conf: 0.88 }),
      B: stat({ label: '5-3-2', lines: [[13, 14, 15, 16, 17], [18, 19, 20], [21, 22]] }, { conf: 0.77 }),
    },
    lineHeight: { A: stat(0.58), B: stat(0.42) },
    passOptions: stat({ carrierId: c.id, targets }, { paused: ballPaused, gate: ballPaused ? 'hidden' : 'shown' }),
    momentum: stat(0.3, { paused: ballPaused }),
    stats,
    attackDir: { A: 'right', confidence: 0.9 },
    scout: withScout ? { ...MOCK_SCOUT } : null,
    teamNames: { A: 'Blue', B: 'Red' },
  };
}

function boxOf(foot: [number, number]): [number, number, number, number] {
  const h = 0.085 + 0.05 * foot[1];
  const w = h * 0.225;
  return [foot[0] - w / 2, foot[1] - h, foot[0] + w / 2, foot[1]];
}

const BIRTH = (id: number): number => 0.05 + 0.05 * id; // lock-on staggers over ~1.2 s

export function snapshotAt(st: number, tMedia: number, withScout: boolean, opts: { forcePhase?: Partial<Phase> } = {}): OverlaySnapshot {
  const ph = { ...phaseAt(st), ...opts.forcePhase };
  const tracks: Track[] = [];
  const wt = ph.replay ? st - 14 : st; // a replay shows earlier play
  if (ph.close) {
    const cl: [number, number, Team, number][] = [[0.28, 0.98, 'A', 9], [0.56, 0.98, 'B', 14], [0.8, 0.98, 'A', 7]];
    cl.forEach(([x, y, team, id], i) => {
      tracks.push({ id, cls: 'player', score: 0.9, box: [x - 0.12, 0.1 + i * 0.03, x + 0.12, y], age: 8, hits: 90, timeSinceUpdate: 0, tMedia, foot: [x, y], vel: [0, 0], team, teamMargin: 0.8 });
    });
  } else if (!ph.empty) {
    for (const p of PLAYERS) {
      const age = st - BIRTH(p.id);
      if (age <= 0) continue;
      if (p.id === 15 && st > 5 && st % 9 < 0.4) continue; // a missed detection: the renderer coasts it
      const foot = playerPos(p, wt - 0.0);
      const f2 = playerPos(p, wt + 0.02), f1 = playerPos(p, wt - 0.02);
      const vel: [number, number] = [(f2[0] - f1[0]) / 0.04, (f2[1] - f1[1]) / 0.04];
      tracks.push({
        id: p.id, cls: p.cls, score: 0.85, box: boxOf(foot), age: Math.min(age, 99), hits: Math.floor(age * 8), timeSinceUpdate: 0, tMedia,
        foot, vel, team: ph.calibrated && p.cls !== 'referee' ? p.team : 'OTHER', teamMargin: ph.calibrated ? 0.6 : 0,
      });
    }
  }
  const bxy = ph.empty || ph.close || ph.ball === 'absent' ? null : ballAt(wt);
  return {
    tMedia, playbackRate: 1, globalMotion: [shiftV(wt), 0], liveness: ph.liveness, scene: ph.scene, tracks,
    ball: { xy: bxy, visibility: ph.ball === 'visible' ? 0.9 : ph.ball === 'searching' ? 0.4 : 0, coastingS: ph.coasting, state: ph.ball },
    match: matchAt(st, ph, withScout && st >= 4),
    teamsCalibrated: ph.calibrated,
    cut: false,
    teamColours: { A: MOCK_SCOUT.kitColours.A, B: MOCK_SCOUT.kitColours.B, confidence: 0.95 },
  };
}
