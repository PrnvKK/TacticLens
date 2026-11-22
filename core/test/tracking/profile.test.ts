import { describe, expect, it } from 'vitest';
import { ByteTrackLite, type PersonDet } from '../../src/tracking/bytetrack';
import { type GreyFrame } from '../../src/tracking/camera';
import { BROADCAST_PROFILE, GAME_PROFILE } from '../../src/tracking/profile';
import { trackerOptsFromProfile } from '../../src/tracking/v2';
import type { Track } from '../../src/types';

const DT = 1 / 9;                       // 9 Hz brain rate
const W = 320, H = 180;                 // grey frame for camera flow

function det(cx: number, cy: number, h = 0.06, w = 0.018, score = 0.85): PersonDet {
  return { cls: 'player', score, box: [cx - w / 2, cy - h, cx + w / 2, cy] };
}

interface RunResult { newIds: number; newIdsPerMin: number; switches: number; frames: number }

/** Greedy nearest-neighbour: for each true centre, the id of the closest track within a radius. */
function assignIds(tracks: Track[], truths: [number, number][]): (number | null)[] {
  return truths.map(([tx, ty]) => {
    let best: number | null = null, bd = 0.05;
    for (const t of tracks) {
      const tcx = (t.box[0] + t.box[2]) / 2, tcy = (t.box[1] + t.box[3]) / 2;
      const d = Math.hypot(tcx - tx, tcy - ty);
      if (d < bd) { bd = d; best = t.id; }
    }
    return best;
  });
}

/**
 * EA FC-style motion: three players in a row trace a square together, with 2x speed bursts on every
 * other leg and a sharp 90-degree turn at every corner. A corner out of a burst leg displaces the
 * detection ~sqrt(2)*v*DT from the straight-line Kalman prediction.
 */
function runTurnsBursts(): { broadcast: RunResult; game: RunResult } {
  const run = (profile: typeof BROADCAST_PROFILE): RunResult => {
    const tr = new ByteTrackLite({ tracker: 'v2', ...trackerOptsFromProfile(profile) });
    const off = [-0.07, 0, 0.07];
    // legs alternate slow (0.3) and fast (0.6): every other corner is a burst-turn
    const legs: [number, number, number][] = [
      [0.3, 0, 6], [0, -0.6, 6], [-0.3, 0, 6], [0, 0.6, 6],
      [0.3, 0, 6], [0, -0.6, 6], [-0.3, 0, 6], [0, 0.6, 6],
    ];
    let cx = 0.45, cy = 0.55;
    let switches = 0;
    const prev: (number | null)[] = [null, null, null];
    let k = 0;
    for (const [vx, vy, n] of legs) {
      for (let i = 0; i < n; i++, k++) {
        cx += vx * DT; cy += vy * DT;
        const t = k * DT;
        const dets = off.map((o) => det(cx + o, cy));
        const out = tr.update(dets, t, t, false, { scene: 'WIDE' });
        if (k >= 9) {
          const ids = assignIds(out, off.map((o) => [cx + o, cy - 0.03] as [number, number]));
          for (let p = 0; p < 3; p++) {
            if (ids[p] !== null && prev[p] !== null && ids[p] !== prev[p]) switches++;
            if (ids[p] !== null) prev[p] = ids[p];
          }
        }
      }
    }
    const s = tr.debugStats();
    return { newIds: s.newIds, newIdsPerMin: s.newIdsPerMinute, switches, frames: k };
  };
  return { broadcast: run(BROADCAST_PROFILE), game: run(GAME_PROFILE) };
}

/** Deterministic moving texture (same as the v2 camera tests). */
function grey(shiftPx: number, rects: { x: number; y: number; w: number; h: number }[] = []): GreyFrame {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = x - shiftPx;
      const v = 78 + 24 * Math.sin(sx / 7.3) + 18 * Math.cos(y / 5.1) + 12 * Math.sin((sx + y) / 3.7) +
        (((Math.floor(sx / 16) + Math.floor(y / 16)) & 1) ? 14 : -6);
      data[y * W + x] = Math.max(0, Math.min(255, v));
    }
  }
  for (const r of rects) {
    const x0 = Math.max(0, Math.round((r.x - r.w / 2) * W)), x1 = Math.min(W - 1, Math.round((r.x + r.w / 2) * W));
    const y0 = Math.max(0, Math.round((r.y - r.h) * H)), y1 = Math.min(H - 1, Math.round(r.y * H));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) data[y * W + x] = 18;
  }
  return { data, width: W, height: H };
}

/** Fast camera pan (players fixed on the pitch): the flow must warp every box with the picture. */
function runFastPan(): { broadcast: RunResult; game: RunResult } {
  const run = (profile: typeof BROADCAST_PROFILE): RunResult => {
    const tr = new ByteTrackLite({ tracker: 'v2', ...trackerOptsFromProfile(profile) });
    const base = [{ x: 0.25, y: 0.55 }, { x: 0.35, y: 0.65 }, { x: 0.45, y: 0.55 }, { x: 0.55, y: 0.65 }];
    let switches = 0;
    const prev: (number | null)[] = [null, null, null, null];
    for (let k = 0; k < 40; k++) {
      const shift = (k * 800) / 1920 / 9;      // 800 px/s on a 1920-wide source, 9 Hz
      const dets = base.map((p) => det(p.x + shift, p.y));
      const frame = grey(shift * W, dets.map((d) => ({ x: (d.box[0] + d.box[2]) / 2, y: d.box[3], w: d.box[2] - d.box[0], h: d.box[3] - d.box[1] })));
      const out = tr.update(dets, k * DT, k * DT, false, { scene: 'WIDE', frame });
      if (k >= 6) {
        const ids = assignIds(out, base.map((p) => [p.x + shift, p.y - 0.03] as [number, number]));
        for (let p = 0; p < 4; p++) {
          if (ids[p] !== null && prev[p] !== null && ids[p] !== prev[p]) switches++;
          if (ids[p] !== null) prev[p] = ids[p];
        }
      }
    }
    const s = tr.debugStats();
    return { newIds: s.newIds, newIdsPerMin: s.newIdsPerMinute, switches, frames: 40 };
  };
  return { broadcast: run(BROADCAST_PROFILE), game: run(GAME_PROFILE) };
}

describe('SourceProfile tracking (EA FC vs broadcast)', () => {
  it('broadcast profile reproduces the shipped defaults exactly', () => {
    expect(trackerOptsFromProfile(BROADCAST_PROFILE).centreGate).toBe(1.2);
    expect(trackerOptsFromProfile(BROADCAST_PROFILE).matchIou).toBe(0.25);
    expect(trackerOptsFromProfile(BROADCAST_PROFILE).maxAgeS).toBe(3.0);
    expect(trackerOptsFromProfile(BROADCAST_PROFILE).posQVel).toBe(0.15);
    expect(trackerOptsFromProfile(BROADCAST_PROFILE).boxSmoothAlpha).toBe(0);
    expect(trackerOptsFromProfile(BROADCAST_PROFILE).camLevels).toBe(2);
    const game = trackerOptsFromProfile(GAME_PROFILE);
    expect(game.centreGate).toBeGreaterThan(1.2);
    expect(game.camLevels).toBeGreaterThan(2);
    expect(game.camMaxShiftFrac).toBeGreaterThan(0.3);
  });

  it('game profile holds IDs through sharp 90-degree turns and 2x bursts at 9 Hz', () => {
    const r = runTurnsBursts();
    // game must not allocate extra IDs beyond the initial three; broadcast churns under burst turns.
    expect(r.game.newIds).toBeLessThanOrEqual(r.broadcast.newIds);
    expect(r.game.switches).toBeLessThanOrEqual(r.broadcast.switches);
    expect(r.game.switches).toBe(0);
    expect(r.broadcast.switches).toBeGreaterThan(0);
  });

  it('game profile keeps up with a fast camera pan (no regression)', () => {
    const r = runFastPan();
    expect(r.game.newIds).toBeLessThanOrEqual(r.broadcast.newIds);
    expect(r.game.switches).toBeLessThanOrEqual(r.broadcast.switches);
    expect(r.broadcast.switches).toBe(0);   // an 800 px/s pan is trackable by both profiles
    expect(r.game.switches).toBe(0);
  });
});
