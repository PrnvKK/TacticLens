import { describe, expect, it } from 'vitest';
import { ByteTrackLite, type PersonDet } from '../../src/tracking/bytetrack';
import { estimateCameraMotion, type GreyFrame } from '../../src/tracking/camera';
import type { Track } from '../../src/types';

const W = 320, H = 180;
const HIST_A = [0.55, 0.3, 0.15];
const HIST_B = [0.1, 0.2, 0.7];

function det(x: number, y: number, o: { team?: 'A' | 'B'; hist?: number[]; h?: number; score?: number } = {}): PersonDet {
  const h = o.h ?? 0.09, w = 0.025;
  return {
    cls: 'player', score: o.score ?? 0.85, box: [x - w / 2, y - h, x + w / 2, y],
    team: o.team ?? 'A', hist: o.hist ?? HIST_A,
  };
}

/** Deterministic moving texture, plus dark player rectangles that move with the camera. */
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

const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

describe('camera motion', () => {
  it('estimates a 400 px/s pan (6.7 px per 10 Hz cycle on a 320 px frame)', () => {
    const shift = (400 * W) / 1920 / 10;   // 6.67 px
    const m = estimateCameraMotion(grey(0), grey(shift));
    expect(m).not.toBeNull();
    expect(m!.dx * W).toBeCloseTo(shift, 0);
    expect(Math.abs(m!.dy)).toBeLessThan(0.01);
    expect(m!.confidence).toBeGreaterThan(0.5);
  });

  it('rejects a frame pair with too few matches', () => {
    const flat: GreyFrame = { data: new Uint8Array(W * H).fill(120), width: W, height: H };
    expect(estimateCameraMotion(flat, flat)).toBeNull();
  });

  it('rejects three bands moving differently (inliers below 50%)', () => {
    const band = (shift: (x: number) => number): GreyFrame => {
      const data = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const sx = x - shift(x);
          const v = 78 + 24 * Math.sin(sx / 7.3) + 18 * Math.cos(y / 5.1) + 12 * Math.sin((sx + y) / 3.7);
          data[y * W + x] = Math.max(0, Math.min(255, v));
        }
      }
      return { data, width: W, height: H };
    };
    const cur = band((x) => (x < W / 3 ? 9 : x < (2 * W) / 3 ? -9 : 2));
    expect(estimateCameraMotion(band(() => 0), cur)).toBeNull();
  });
});

describe('PlayerTrackerV2', () => {
  it('keeps zero ID switches through a 400 px/s camera pan at 10 Hz', () => {
    const tr = new ByteTrackLite();
    const base = [
      { x: 0.2, y: 0.58 }, { x: 0.27, y: 0.68 }, { x: 0.34, y: 0.62 },
      { x: 0.41, y: 0.72 }, { x: 0.48, y: 0.6 }, { x: 0.55, y: 0.7 },
    ];
    let ids: number[] | null = null;
    let switches = 0;
    let moves = 0;
    for (let k = 0; k < 20; k++) {
      const shift = k * (400 / 1920) / 10;          // 400 px/s on a 1920-wide video, 10 Hz
      const dets = base.map((p) => det(p.x + shift, p.y));
      const frame = grey(shift * W, dets.map((d) => ({ x: (d.box[0] + d.box[2]) / 2, y: d.box[3], w: d.box[2] - d.box[0], h: d.box[3] - d.box[1] })));
      const out = tr.update(dets, k * 0.1, k * 0.1, false, { scene: 'WIDE', frame });
      if (tr.motion) moves++;
      if (k >= 2) {
        const now = sorted(out.map((o) => o.id));
        if (!ids) ids = now;
        else if (now.join(',') !== ids.join(',')) switches++;
      }
    }
    expect(ids).toHaveLength(6);
    expect(switches).toBe(0);
    expect(moves).toBeGreaterThan(10);
    expect(tr.debugStats().newIds).toBe(6);         // the initial six only
    expect(tr.debugStats().newIdsTotalPerMinute).toBeGreaterThan(0);
  });

  it('re-attaches a player who exits left and re-enters at the right edge within 3 s', () => {
    const tr = new ByteTrackLite();
    let id = -1;
    for (let k = 0; k < 20; k++) {
      const x = Math.max(0.022, 0.25 - 0.012 * k);
      const out = tr.update([det(x, 0.6)], k * 0.1, k * 0.1, false, { scene: 'WIDE' });
      if (out[0]) id = out[0].id;
    }
    expect(id).toBeGreaterThan(0);
    const out = tr.update([det(0.94, 0.6)], 3.8, 3.8, false, { scene: 'WIDE' });
    expect(out.map((o) => o.id)).toEqual([id]);
    expect(tr.debugStats().edgeReentries).toBe(1);
    expect(tr.debugStats().newIds).toBe(1);
  });

  it('a matched edge track does not absorb a new player appearing at the far edge', () => {
    const tr = new ByteTrackLite();
    let leftId = -1;
    for (let k = 0; k < 10; k++) {
      const out = tr.update([det(0.03, 0.6)], k * 0.1, k * 0.1, false, { scene: 'WIDE' });
      if (out[0]) leftId = out[0].id;
    }
    let rightId = -1;
    for (let k = 10; k < 16; k++) {
      const out = tr.update([det(0.03, 0.6), det(0.95, 0.6)], k * 0.1, k * 0.1, false, { scene: 'WIDE' });
      const left = out.find((o) => (o.box[0] + o.box[2]) / 2 < 0.5);
      const right = out.find((o) => (o.box[0] + o.box[2]) / 2 >= 0.5);
      if (left) expect(left.id).toBe(leftId);
      if (right) rightId = right.id;
    }
    expect(rightId).toBeGreaterThan(leftId);
    expect(tr.debugStats().newIds).toBe(2);
    expect(tr.debugStats().edgeReentries).toBe(0);
  });

  it('keeps IDs through a hard cut and return to the same shot via the gallery', () => {
    const tr = new ByteTrackLite();
    const at = [{ x: 0.25, y: 0.6 }, { x: 0.65, y: 0.66 }];
    let before: number[] = [];
    for (let k = 0; k < 10; k++) {
      const out = tr.update(at.map((p, i) => det(p.x, p.y, { hist: i ? HIST_B : HIST_A })), k * 0.1, k * 0.1, false, { scene: 'WIDE' });
      if (k === 9) before = sorted(out.map((o) => o.id));
    }
    tr.update([], 1.0, 1.0, true);                                    // hard cut: ledger parked, no IDs
    let after: number[] = [];
    for (let k = 0; k < 3; k++) {
      const t = 1.25 + k * 0.1;
      const out = tr.update(at.map((p, i) => det(p.x, p.y, { hist: i ? HIST_B : HIST_A })), t, t, false, { scene: 'WIDE' });
      if (k === 2) after = sorted(out.map((o) => o.id));
    }
    expect(before).toHaveLength(2);
    expect(after).toEqual(before);
    expect(tr.debugStats().galleryMatches).toBe(2);
    expect(tr.debugStats().newIds).toBe(2);
  });

  it('a rewind after a cut re-enables births and drops the future gallery', () => {
    const tr = new ByteTrackLite();
    tr.update([det(0.4, 0.6)], 0, 0, false, { scene: 'WIDE' });
    tr.update([det(0.4, 0.6)], 0.1, 0.1, false, { scene: 'WIDE' });
    tr.update([det(0.4, 0.6)], 10.0, 10.0, true);                    // cut: births suppressed until 10.2, id 1 parked
    tr.update([det(0.4, 0.6)], 5.0, 5.0, false, { scene: 'WIDE' });  // rewind into an earlier segment
    const out = tr.update([det(0.4, 0.6)], 5.1, 5.1, false, { scene: 'WIDE' });
    expect(out.map((o) => o.id)).toEqual([2]);                       // fresh id: the parked gallery must not leak backwards
    expect(tr.debugStats().gallerySize).toBe(0);
    expect(tr.debugStats().newIds).toBe(2);
  });

  it('re-associates a player who stopped during a 2.5 s decoder stall', () => {
    const tr = new ByteTrackLite();
    let id = -1;
    for (let k = 0; k < 12; k++) {
      const out = tr.update([det(0.3 + 0.02 * k, 0.6)], k * 0.1, k * 0.1, false, { scene: 'WIDE' });
      if (out[0]) id = out[0].id;
    }
    const out = tr.update([det(0.3 + 0.02 * 11, 0.6)], 3.6, 3.6, false, { scene: 'WIDE' });
    expect(out.map((o) => o.id)).toEqual([id]);
    expect(out[0]!.timeSinceUpdate).toBe(0);
    expect(tr.debugStats().newIds).toBe(1);
  });

  it('allocates no new IDs during REPLAY/CLOSE', () => {
    const tr = new ByteTrackLite();
    for (let k = 0; k < 10; k++) tr.update([det(0.3, 0.6)], k * 0.1, k * 0.1, false, { scene: 'WIDE' });
    const n0 = tr.debugStats().newIds;
    for (let k = 10; k < 40; k++) {
      const t = k * 0.1;
      tr.update([det(0.75, 0.4), det(0.8, 0.7)], t, t, false, { scene: k < 25 ? 'REPLAY' : 'CLOSE' });
    }
    expect(tr.debugStats().newIds).toBe(n0);
  });

  it('after 25 s without WIDE play drops the gallery and restarts numbering at 1', () => {
    const tr = new ByteTrackLite({ longBreakS: 20 });
    const histC = [0.1, 0.15, 0.75];
    const squad1 = [{ x: 0.25, y: 0.6, hist: HIST_A }, { x: 0.45, y: 0.68, hist: HIST_B }, { x: 0.65, y: 0.62, hist: HIST_A }];
    const squad2 = [{ x: 0.35, y: 0.55, hist: histC }, { x: 0.55, y: 0.75, hist: histC }, { x: 0.75, y: 0.6, hist: HIST_B }];
    const at = (p: { x: number; y: number; hist: number[] }) => det(p.x, p.y, { hist: p.hist });
    const wide = (squad: { x: number; y: number; hist: number[] }[], t: number) =>
      tr.update(squad.map(at), t, t, false, { scene: 'WIDE' });

    for (let k = 0; k < 10; k++) wide(squad1, k * 0.1);                    // ids 1, 2, 3
    tr.update([], 1.0, 1.0, true);                                        // hard cut parks them
    for (let k = 0; k < 3; k++) wide(squad1, 1.25 + k * 0.1);             // gallery hands 1..3 back
    for (let k = 0; k < 5; k++) wide(squad1, 1.55 + k * 0.1);
    let fresh: number[] = [];
    for (let k = 0; k < 5; k++) fresh = sorted(wide(squad2, 2.05 + k * 0.1).map((o) => o.id));
    expect(fresh).toEqual([1, 2, 3, 4, 5, 6]);                            // squad1 still coasting; squad2 fresh 4..6
    tr.update([], 2.5, 2.5, true);                                        // cut parks 1..6 in the gallery
    for (let k = 26; k <= 234; k++) {
      const t = k * 0.1;
      tr.update([], t, t, false, { scene: 'CLOSE' });                     // long break, no WIDE
    }
    wide(squad2.slice(0, 2), 23.5);                                       // two of squad2 return
    const out = wide(squad2.slice(0, 2), 23.6);
    expect(out.map((o) => o.id).sort((a, b) => a - b)).toEqual([1, 2]);   // gallery dropped, numbering restarted
    expect(tr.debugStats().gallerySize).toBe(0);
    expect(tr.debugStats().galleryMatches).toBe(3);
    expect(tr.debugStats().newIds).toBe(8);
  });

  it('coasts a confirmed track for the 3 s time-based max age, then drops it', () => {
    const tr = new ByteTrackLite();
    let id = -1;
    for (let k = 0; k < 20; k++) { const o = tr.update([det(0.4, 0.6)], k * 0.1, k * 0.1); if (o[0]) id = o[0].id; }
    const held = tr.update([], 4.5, 4.5);
    expect(held.map((o) => o.id)).toEqual([id]);
    expect(tr.update([], 5.1, 5.1)).toHaveLength(0);
  });

  it('confirms after 2 of 3 hits and only then exposes the visible ID', () => {
    const tr = new ByteTrackLite();
    expect(tr.update([det(0.4, 0.6)], 0, 0)).toHaveLength(0);
    const out = tr.update([det(0.4, 0.6)], 0.1, 0.1);
    expect(out).toHaveLength(1);
    expect(tr.debugStats().newIds).toBe(1);
  });

  it('catches an 8 m/s sprint start in the velocity within two detections', () => {
    const tr = new ByteTrackLite();
    const y = 0.6, x0 = 0.3, speed = 0.13;   // 0.13 frame widths/s ~= 8 m/s on a 60 m wide shot
    for (let k = 0; k < 12; k++) tr.update([det(x0, y)], k / 9, k / 9, false, { scene: 'WIDE' });
    let out: Track[] = [];
    for (let k = 1; k <= 3; k++) {
      const t = 12 / 9 + k / 9;
      out = tr.update([det(x0 + (speed * k) / 9, y)], t, t, false, { scene: 'WIDE' });
    }
    // Two observations into the sprint the reported velocity must be at least 80% of the new speed:
    // by then the adaptive Kalman noise and the short observation window have both opened up.
    expect(out).toHaveLength(1);
    expect(out[0]!.vel[0] / speed).toBeGreaterThan(0.8);
  });
});
