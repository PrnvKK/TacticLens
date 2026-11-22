import { describe, expect, it } from 'vitest';
import { OneEuroFilter } from '../lib/render/math';

const FPS = 60;

describe('OneEuroFilter', () => {
  it('reduces high-frequency jitter around a still target', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0.015, dCutoff: 1 });
    let rawAbs = 0, outAbs = 0, prevRaw = 100, prevOut = 100;
    for (let i = 0; i < FPS * 3; i++) {
      const raw = 100 + (i % 2 ? 5 : -5);
      const out = f.filter(raw, 1 / FPS);
      if (i > FPS) { rawAbs += Math.abs(raw - prevRaw); outAbs += Math.abs(out - prevOut); }
      prevRaw = raw; prevOut = out;
    }
    expect(outAbs).toBeLessThan(rawAbs * 0.15);
    expect(Math.abs(f.value! - 100)).toBeLessThan(1);
  });

  it('tracks a real move without overshooting or jumping', () => {
    const f = new OneEuroFilter({ minCutoff: 1, beta: 0.015, dCutoff: 1 });
    f.reset(0);
    let prev = 0;
    let firstStep = 0;
    for (let i = 1; i <= FPS; i++) {
      const out = f.filter(100, 1 / FPS);
      expect(out).toBeLessThanOrEqual(100 + 1e-9);
      expect(out).toBeGreaterThanOrEqual(prev - 1e-9);
      if (i === 1) firstStep = out;
      prev = out;
    }
    expect(firstStep).toBeGreaterThan(0);
    expect(firstStep).toBeLessThan(80);          // bounded by the target, no snap/overshoot
    expect(prev).toBeGreaterThan(95);            // settled within ~1 s
  });

  it('reacts sooner to a fast ramp when beta is raised', () => {
    const slow = new OneEuroFilter({ minCutoff: 1, beta: 0, dCutoff: 1 });
    const fast = new OneEuroFilter({ minCutoff: 1, beta: 0.05, dCutoff: 1 });
    slow.reset(0); fast.reset(0);
    let a = 0, b = 0;
    for (let i = 1; i <= 30; i++) {
      const target = i * 4;
      a = slow.filter(target, 1 / 60);
      b = fast.filter(target, 1 / 60);
    }
    expect(b).toBeGreaterThan(a);
    expect(b - a).toBeGreaterThan(5);
  });
});
