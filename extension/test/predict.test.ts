import { describe, expect, it } from 'vitest';
import { EXTRAP_MAX_S, Extrapolator } from '../lib/render/math';

/** Video-time read helper: `dt` is the wall-clock frame delta (for the correction spring only). */
function readAt(e: Extrapolator, now: number, dt = 1 / 60): { x: number; y: number; gap: number; clamped: boolean } {
  return e.read(now, dt);
}

describe('Extrapolator (latency compensation)', () => {
  it('extrapolates at the tracker velocity over the media gap', () => {
    const e = new Extrapolator();
    e.reset(0.4, 0.6, 10, 0.5, -0.25);
    const p = readAt(e, 10.2);
    expect(p.gap).toBeCloseTo(0.2, 6);
    expect(p.x).toBeCloseTo(0.4 + 0.5 * 0.2, 6);
    expect(p.y).toBeCloseTo(0.6 - 0.25 * 0.2, 6);
  });

  it('paused: a frozen clock holds the point (gap does not grow)', () => {
    const e = new Extrapolator();
    e.reset(0.3, 0.5, 2, 1, 0);
    const a = readAt(e, 2.1);
    let last = a;
    // 30 render frames with the video clock frozen at 2.1
    for (let i = 0; i < 30; i++) last = readAt(e, 2.1);
    expect(last.gap).toBeCloseTo(0.1, 6);
    expect(last.x).toBeCloseTo(a.x, 6);
  });

  it('seek/rewind: never predicts backwards from the next observation', () => {
    const e = new Extrapolator();
    e.reset(0.8, 0.5, 30, 1, 0);
    const p = readAt(e, 12);                    // rewound past the observation
    expect(p.gap).toBe(0);
    expect(p.x).toBeCloseTo(0.8, 6);
    // a new observation after the seek starts a fresh, forward timeline
    e.observe(0.2, 0.5, 12.1, 1, 0, 0, 0, 12.1);
    expect(readAt(e, 12.2).gap).toBeCloseTo(0.1, 6);
  });

  it('2x playback: the gap is in video seconds, so it doubles for the same wall latency', () => {
    const e = new Extrapolator();
    e.reset(0.1, 0.5, 100, 0.4, 0);
    const wall = 0.15;                          // 150 ms of wall-clock latency
    const at1 = readAt(e, 100 + wall * 1);
    const e2 = new Extrapolator();
    e2.reset(0.1, 0.5, 100, 0.4, 0);
    const at2 = readAt(e2, 100 + wall * 2);
    expect(at2.gap).toBeCloseTo(0.3, 6);
    expect(at2.x - 0.1).toBeCloseTo(2 * (at1.x - 0.1), 6);
  });

  it('clamps extrapolation to EXTRAP_MAX_S (400 ms) and freezes beyond it', () => {
    const e = new Extrapolator();
    e.reset(0.5, 0.5, 0, 2, 0);
    expect(EXTRAP_MAX_S).toBe(0.4);
    const p = readAt(e, 1.2);
    expect(p.gap).toBe(0.4);
    expect(p.clamped).toBe(true);
    expect(p.x).toBeCloseTo(0.5 + 2 * 0.4, 6);
    expect(readAt(e, 5).x).toBeCloseTo(p.x, 6);
  });

  it('applies a new detection as a smooth correction, never a snap', () => {
    const e = new Extrapolator();
    e.reset(0.4, 0.6, 1, 0.5, 0);
    const before = readAt(e, 1.25);             // prediction 0.525
    expect(before.x).toBeCloseTo(0.525, 6);
    // the detection lands 180 ms late and is 0.02 behind the prediction
    e.observe(0.505, 0.6, 1.25, 0.5, 0, 0, 0, 1.25);
    const atApply = readAt(e, 1.25, 0);
    expect(atApply.x).toBeCloseTo(before.x, 6);  // no jump on arrival
    // 40 ms later it has moved part-way toward the corrected track, not all the way
    const mid = readAt(e, 1.25, 0.04);
    expect(mid.x).toBeLessThan(before.x);
    expect(mid.x).toBeGreaterThan(0.505 + 0.5 * 0);
    // 240 ms later (three time constants) the correction is gone
    let p = readAt(e, 1.25, 0.08);
    p = readAt(e, 1.25, 0.08);
    p = readAt(e, 1.25, 0.08);
    expect(p.x).toBeCloseTo(0.505, 3);
  });

  it('adds camera motion that arrived after the observation while coasting (a pan)', () => {
    const e = new Extrapolator();
    e.reset(0.5, 0.5, 1, 0, 0, 0, 0);
    // no detection this cycle; the camera is panning right at 1 frame width/s
    const p = e.read(1.2, 1 / 60, 1, 0);
    expect(p.x).toBeCloseTo(0.5 + 1 * 0.2, 6);
  });

  it('caps a wild velocity, and a large correction stays continuous (no snap)', () => {
    const e = new Extrapolator({ maxVel: 4.5 });
    e.reset(0.5, 0.5, 0, 100, 0);
    expect(readAt(e, 0.2).x - 0.5).toBeLessThanOrEqual(4.5 * 0.2 + 1e-9);
    // a detector glitch 0.75 frames away: the drawn point must not jump past where it already was
    const before = readAt(e, 0.4);
    e.observe(0.9, 0.5, 0.2, 100, 0, 0, 0, 0.4);
    const p = readAt(e, 0.4, 0);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(p.x).toBeLessThanOrEqual(before.x + 1e-9);
    // and it converges to the new prediction over ~3 time constants
    readAt(e, 0.4, 0.08); readAt(e, 0.4, 0.08); readAt(e, 0.4, 0.08);
    expect(Math.abs(readAt(e, 0.4, 0.08).x - (0.9 + 3.25 * 0.2))).toBeLessThan(0.05);
  });
});
