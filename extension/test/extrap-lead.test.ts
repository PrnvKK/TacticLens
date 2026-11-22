import { describe, expect, it } from 'vitest';
import { Extrapolator } from '../lib/render/math';
import { MARKER } from '../lib/render/tokens';

describe('Extrapolator display lead', () => {
  it('predicts one display frame further than video.currentTime', () => {
    const e = new Extrapolator();
    e.reset(0.4, 0.6, 10, 0.5, -0.25);
    const p = e.read(10.2, 1 / 60, 0, 0, 1 / 60);
    expect(p.gap).toBeCloseTo(0.2 + 1 / 60, 6);
    expect(p.x).toBeCloseTo(0.4 + 0.5 * (0.2 + 1 / 60), 6);
    expect(p.y).toBeCloseTo(0.6 - 0.25 * (0.2 + 1 / 60), 6);
  });

  it('never lets the lead exceed the 400 ms extrapolation clamp', () => {
    const e = new Extrapolator();
    e.reset(0.5, 0.5, 0, 2, 0);
    const p = e.read(0.39, 1 / 60, 0, 0, 1);
    expect(p.gap).toBe(0.4);
    expect(p.clamped).toBe(true);
  });

  it('a negative or zero lead is ignored (paused frames do not move)', () => {
    const e = new Extrapolator();
    e.reset(0.5, 0.5, 1, 1, 0);
    const a = e.read(1.1, 1 / 60);
    const b = e.read(1.1, 1 / 60, 0, 0, -0.2);
    expect(b.gap).toBeCloseTo(a.gap, 9);
    expect(b.x).toBeCloseTo(a.x, 9);
  });
});

describe('Extrapolator acceleration term', () => {
  it('adds a bounded amount during a sprint start and no more', () => {
    const o = { maxAccel: MARKER.motion.maxAccel, accelShare: MARKER.motion.accelShare, accelLeadMaxS: MARKER.motion.accelLeadMaxS };
    const fast = new Extrapolator(o);
    // Same inputs, acceleration disabled: the difference is exactly the 1/2 a t^2 term.
    const reference = new Extrapolator({ ...o, maxAccel: 0 });
    for (const e of [fast, reference]) e.reset(0.4, 0.5, 0, 0.1, 0);
    for (const e of [fast, reference]) e.observe(0.411, 0.5, 0.1, 0.22, 0, 0, 0, 0.1);
    const a = fast.read(0.3, 1 / 60);
    const b = reference.read(0.3, 1 / 60);
    expect(a.x).toBeGreaterThan(b.x);
    expect(a.x - b.x).toBeLessThanOrEqual(MARKER.motion.accelShare * 0.22 * 0.2 + 1e-9);
    expect(Number.isFinite(a.x)).toBe(true);
  });

  it('zeroes acceleration on a 90-degree direction change', () => {
    const o = { maxAccel: MARKER.motion.maxAccel, accelShare: MARKER.motion.accelShare, accelLeadMaxS: MARKER.motion.accelLeadMaxS };
    const e = new Extrapolator(o);
    e.reset(0.4, 0.5, 0, 0.2, 0);
    // A sprint, then a hard cut to +y: the old +x acceleration must not push the point further right.
    e.observe(0.42, 0.51, 0.1, 0.2, 0.25, 0, 0, 0.1);
    e.observe(0.42, 0.56, 0.2, 0, 0.4, 0, 0, 0.2);
    const p = e.read(0.4, 1 / 60);
    // The x velocity is zero and the correction spring has decayed: no forward acceleration excursion.
    expect(p.x).toBeCloseTo(0.42, 1);
    expect(p.y).toBeGreaterThan(0.56);
  });

  it('does nothing when disabled (the default)', () => {
    const e = new Extrapolator();
    e.reset(0.4, 0.5, 0, 0.1, 0);
    e.observe(0.411, 0.5, 0.1, 0.22, 0, 0, 0, 0.1);
    const p = e.read(0.3, 1 / 60);
    const ref = new Extrapolator();
    ref.reset(0.4, 0.5, 0, 0.1, 0);
    ref.observe(0.411, 0.5, 0.1, 0.22, 0, 0, 0, 0.1);
    expect(p.x).toBeCloseTo(ref.read(0.3, 1 / 60).x, 9);
  });
});
