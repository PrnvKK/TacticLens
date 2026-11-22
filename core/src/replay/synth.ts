// Deterministic synthetic match generator: 22 players in two 4-4-2 teams (11 each, goalkeepers included), a referee,
// a ball passed between players, scheduled turnovers, ball-absent gaps, replay and close-up segments.
// Used to generate fixtures/*.jsonl and as ground truth in tests. Seeded; same config -> byte-identical output.
// `mode: 'frames'` writes finished FrameState; `mode: 'raw'` writes raw detections (persons, torso Lab, ball candidates, scene hints).
import type { BallState, FrameState, SceneKind, Track } from '../types';
import type { FrameRecord, RawFrame, SessionHeader, SessionLabels } from './format';
import { SESSION_VERSION } from './format';
import type { PersonDet } from '../tracking/bytetrack';
import type { Lab } from '../teams/lab';

export interface SynthConfig {
  name: string;
  seed: number;
  durationS: number;
  hz: number;
  mode: 'frames' | 'raw';
  segments: { t0: number; t1: number; team: 'A' | 'B' }[];   // intended possession, the rest of the time follows the last segment
  absent: [number, number][];
  replay: [number, number][];
  close: [number, number][];
  calibratedAtS: number;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Key = string;   // A0..A9, AGK, B0..B9, BGK, REF
const OUTFIELD = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
// 4-4-2 for team A, attacking right: [x, y] in normalised coords.
const BASE_A: [number, number][] = [
  [0.24, 0.38], [0.24, 0.52], [0.24, 0.66], [0.24, 0.8],
  [0.38, 0.38], [0.38, 0.52], [0.38, 0.66], [0.38, 0.8],
  [0.52, 0.5], [0.52, 0.68],
];
const ALL_KEYS: Key[] = [...OUTFIELD.map((i) => `A${i}`), 'AGK', ...OUTFIELD.map((i) => `B${i}`), 'BGK', 'REF'];
const idOf = (k: Key) => ALL_KEYS.indexOf(k) + 1;
const heightAt = (y: number) => 0.07 + 0.09 * y;
const LAB: Record<string, Lab> = { A: [48, 55, 35], B: [35, 5, -45], GK: [85, -5, 75], REF: [18, 0, 0] };

interface Hold { key: Key; team: 'A' | 'B'; arr: number; dep: number }

export interface SynthResult { header: SessionHeader; frames: FrameRecord[]; labels: SessionLabels }

export function generateSynth(cfg: SynthConfig): SynthResult {
  const R = rng(cfg.seed);
  const phase = new Map<Key, number>(ALL_KEYS.map((k) => [k, R() * 6.28]));
  const inWin = (w: [number, number][], t: number) => w.some(([a, b]) => t >= a && t < b);
  const kindAt = (t: number): SceneKind => (inWin(cfg.replay, t) ? 'REPLAY' : inWin(cfg.close, t) ? 'CLOSE' : 'WIDE');

  const pos = (k: Key, t: number, mode: SceneKind): [number, number] => {
    const ph = phase.get(k)!;
    const sway = 0.04 * Math.sin(t / 9);
    const jx = 0.008 * Math.sin(0.8 * t + ph), jy = 0.008 * Math.cos(0.6 * t + ph);
    let b: [number, number];
    if (k === 'REF') b = [0.5 + 0.12 * Math.sin(t / 7), 0.62];
    else if (k === 'AGK') b = [0.06, 0.58];
    else if (k === 'BGK') b = [0.94, 0.58];
    else {
      const base = BASE_A[Number(k.slice(1))]!;
      b = k[0] === 'A' ? base : [1 - base[0], base[1]];
    }
    if (mode === 'REPLAY') b = [1 - b[0] * 0.9, 0.9 - 0.7 * (b[1] - 0.3)];      // a different camera angle and play
    if (mode === 'CLOSE') b = [0.5 + (b[0] - 0.5) * 2.2, 0.5 + (b[1] - 0.6) * 2.2];
    return [b[0] + sway + jx, b[1] + jy];
  };

  // ---- ball ownership schedule (normal play)
  const holds: Hold[] = [];
  const teamAt = (t: number): 'A' | 'B' => {
    let team: 'A' | 'B' = cfg.segments[0]!.team;
    for (const s of cfg.segments) if (t >= s.t0) team = s.team;
    return team;
  };
  {
    let cur = 0, prevKey: Key | null = null;
    while (cur < cfg.durationS + 3) {
      const arr = cur + 0.5;
      const team = teamAt(arr);
      let k: Key;
      do { k = `${team}${OUTFIELD[Math.floor(R() * 10)]}`; } while (k === prevKey);
      const dep = arr + 1.4 + R() * 1.0;
      holds.push({ key: k, team, arr, dep });
      prevKey = k; cur = dep;
    }
  }
  const holdAt = (t: number): { i: number; held: boolean } => {
    let i = 0;
    for (let j = 0; j < holds.length; j++) if (holds[j]!.arr <= t) i = j;
    return { i, held: t < holds[i]!.dep };
  };
  const ballAt = (t: number, scene: SceneKind): [number, number] => {
    if (scene === 'REPLAY') {
      const s = Math.floor(t);
      return pos(`${s % 2 === 0 ? 'A' : 'B'}${(s * 3) % 10}`, t, 'REPLAY');
    }
    const { i, held } = holdAt(t);
    const h = holds[i]!;
    const p = pos(h.key, t, scene);
    if (held || i + 1 >= holds.length) return [p[0], p[1] - 0.004];
    const n = holds[i + 1]!, q = pos(n.key, t, scene);
    const u = (t - h.dep) / (n.arr - h.dep);
    return [p[0] + (q[0] - p[0]) * u, p[1] - 0.004 + (q[1] - p[1]) * u];
  };

  // ---- frames
  const dt = 1 / cfg.hz;
  const n = Math.floor(cfg.durationS * cfg.hz);
  const frames: FrameRecord[] = [];
  const credit = { A: 0, B: 0 };
  let prevKind: SceneKind = 'WIDE';
  let lastBallXY: [number, number] = [0.5, 0.6];
  for (let fi = 0; fi < n; fi++) {
    const t = fi * dt;
    const kind = kindAt(t);
    const calibrated = t >= cfg.calibratedAtS;
    const cut = kind !== prevKind;
    prevKind = kind;
    const visibleKeys: Key[] = kind === 'CLOSE'
      ? ALL_KEYS.filter((k) => { const p = pos(k, t, 'CLOSE'); return p[0] > 0.05 && p[0] < 0.95 && p[1] > 0.1 && p[1] < 0.98; }).slice(0, 8)
      : ALL_KEYS;
    const scale = kind === 'CLOSE' ? 2.2 : 1;

    // ball
    const absentWin = cfg.absent.find(([a, b]) => t >= a && t < b);
    let ballState: BallState = 'visible';
    let ballXY: [number, number] | null = ballAt(t, kind);
    let coasting = 0;
    if (absentWin) {
      coasting = t - absentWin[0];
      ballState = coasting < 1 ? 'searching' : 'absent';
      ballXY = ballState === 'searching' ? lastBallXY : null;
    } else lastBallXY = ballXY;
    const visibility = ballState === 'visible' ? 0.9 : ballState === 'searching' ? Math.max(0.1, 1 - coasting) : 0;

    // truth credit: normal WIDE play, calibrated, ball not absent; credit goes to the holder (passer during transit)
    if (kind === 'WIDE' && calibrated && !absentWin) credit[holds[holdAt(t).i]!.team] += dt;

    const stub = { t, tMedia: t, playbackRate: 1, quality: 0 as const, frameIdx: fi };
    if (cfg.mode === 'frames') {
      const tracks: Track[] = visibleKeys.map((k) => {
        const p = pos(k, t, kind), q = pos(k, t - dt, kind);
        const h = heightAt(p[1]) * scale, w = h * 0.4;
        const team = k[0] === 'A' && k !== 'AGK' ? 'A' : k[0] === 'B' && k !== 'BGK' ? 'B' : 'OTHER';
        return {
          id: idOf(k), cls: k === 'REF' ? 'referee' : k.endsWith('GK') ? 'goalkeeper' : 'player', score: 0.9,
          box: [p[0] - w / 2, p[1] - h, p[0] + w / 2, p[1]], age: t, hits: fi + 1, timeSinceUpdate: 0, tMedia: t,
          foot: [p[0], p[1]], vel: cut ? [0, 0] : [(p[0] - q[0]) / dt, (p[1] - q[1]) / dt],
          team: calibrated ? team : 'OTHER', teamMargin: calibrated && team !== 'OTHER' ? 0.9 : 0,
        } as Track;
      });
      const frame: FrameState = {
        ...stub, globalMotion: [0, 0], scene: { kind, confidence: 0.95 }, tracks,
        ball: { xy: ballXY, visibility, coastingS: coasting, state: ballState }, teamsCalibrated: calibrated,
      };
      frames.push({ kind: 'frame', frame });
    } else {
      const persons: PersonDet[] = [];
      const labs: (Lab | null)[] = [];
      for (const k of visibleKeys) {
        const p = pos(k, t, kind);
        const h = heightAt(p[1]) * scale, w = h * 0.4;
        const j = () => (R() - 0.5) * 0.004;
        persons.push({ cls: k === 'REF' ? 'referee' : k.endsWith('GK') ? 'goalkeeper' : 'player', score: 0.9, box: [p[0] - w / 2 + j(), p[1] - h + j(), p[0] + w / 2 + j(), p[1] + j()] });
        const base = k === 'REF' ? LAB.REF! : k.endsWith('GK') ? LAB.GK! : LAB[k[0]!]!;
        labs.push([base[0] + (R() - 0.5) * 3, base[1] + (R() - 0.5) * 3, base[2] + (R() - 0.5) * 3]);
      }
      const raw: RawFrame = {
        persons, labs,
        ballCands: ballState === 'visible' && ballXY ? [{ xy: ballXY, score: 0.85 }] : [],
        scene: { kind, confidence: 0.95, cut },
      };
      frames.push({ kind: 'frame', frame: stub, raw });
    }
  }

  // ---- truth: turnovers are scheduled ownership changes in clean live play (no gap, replay or close within the hold)
  const turnovers: SessionLabels['turnovers'] = [];
  for (let i = 1; i < holds.length; i++) {
    const a = holds[i - 1]!, b = holds[i]!;
    if (a.team === b.team || b.arr >= cfg.durationS - 1.5) continue;
    const lo = a.arr - 0.5, hi = b.arr + 1.5;
    const dirty = [...cfg.absent, ...cfg.replay, ...cfg.close].some(([x, y]) => x < hi && y > lo);
    if (!dirty && lo >= cfg.calibratedAtS) turnovers.push({ t: Math.round(b.arr * 100) / 100, to: b.team });
  }
  const tot = credit.A + credit.B;
  const labels: SessionLabels = {
    fixture: cfg.name, source: 'synthetic', durationS: cfg.durationS,
    possession: { A: Math.round((1000 * credit.A) / tot) / 10, B: Math.round((1000 * credit.B) / tot) / 10 },
    turnovers, absent: cfg.absent, replay: cfg.replay, close: cfg.close, calibratedAtS: cfg.calibratedAtS,
    note: 'Possession truth excludes replay, close-up, ball-absent time and calibration. Turnover t is the scheduled arrival at the new holder; the engine confirms ~0.5 s later.',
  };
  const header: SessionHeader = {
    kind: 'header', version: SESSION_VERSION, source: 'synthetic', hz: cfg.hz, hasRaw: cfg.mode === 'raw',
    video: { name: cfg.name, durationS: cfg.durationS }, meta: { seed: cfg.seed, generator: 'core/src/replay/synth.ts' },
  };
  return { header, frames, labels };
}

/** The three committed fixtures (fixtures/<name>.jsonl and fixtures/<name>.labels.json). */
export const SYNTH_FIXTURES: SynthConfig[] = [
  {
    name: 'synth-a-dominant', seed: 11, durationS: 100, hz: 5, mode: 'frames', calibratedAtS: 1.5,
    segments: [{ t0: 0, t1: 36, team: 'A' }, { t0: 36, t1: 50, team: 'B' }, { t0: 50, t1: 100, team: 'A' }],
    absent: [[58, 64]], replay: [[74, 84]], close: [],
  },
  {
    name: 'synth-balanced', seed: 22, durationS: 100, hz: 5, mode: 'frames', calibratedAtS: 1.5,
    segments: [{ t0: 0, t1: 20, team: 'A' }, { t0: 20, t1: 40, team: 'B' }, { t0: 40, t1: 60, team: 'A' }, { t0: 60, t1: 80, team: 'B' }, { t0: 80, t1: 100, team: 'A' }],
    absent: [[28, 32], [66, 69]], replay: [[46, 54]], close: [[86, 90]],
  },
  {
    name: 'synth-raw-b-dominant', seed: 33, durationS: 100, hz: 5, mode: 'raw', calibratedAtS: 6,
    segments: [{ t0: 0, t1: 30, team: 'B' }, { t0: 30, t1: 44, team: 'A' }, { t0: 44, t1: 100, team: 'B' }],
    absent: [[20, 25]], replay: [[60, 70]], close: [],
  },
];
