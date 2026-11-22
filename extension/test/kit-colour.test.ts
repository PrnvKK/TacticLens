import { describe, expect, it } from 'vitest';
import {
  displayKitColour, displayKitPair, hexToRgbTuple, KIT_MIN_DELTA_E, kitDeltaE, kitHue, type TeamColours,
} from '@tacticlens/core';
import { KitColourTracker } from '../lib/render/kit';

describe('kit colour display mapping', () => {
  it('keeps white kits near-white with a dark outline', () => {
    const k = displayKitColour('#f2f2f2');
    const [r, g, b] = hexToRgbTuple(k.fill);
    expect(Math.min(r, g, b)).toBeGreaterThan(225);
    expect(k.edge).toBe('#10151c');
    expect(k.light).toBe(true);
  });

  it('turns black kits into charcoal with a light outline', () => {
    const k = displayKitColour('#111111');
    const [r, g, b] = hexToRgbTuple(k.fill);
    expect(Math.max(r, g, b)).toBeLessThan(80);
    expect(k.edge).toBe('#e8eef4');
    expect(k.light).toBe(false);
  });

  it('keeps yellow reading as yellow, not grass', () => {
    const k = displayKitColour('#ffd633');
    const [r, g, b] = hexToRgbTuple(k.fill);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(150);
    expect(b).toBeLessThan(120);
    expect(kitHue(k.fill)).toBeLessThan(70);
  });

  it('pushes a green kit out of the turf hue range', () => {
    const k = displayKitColour('#2e9b44');
    const h = kitHue(k.fill);
    expect(h < 80 || h > 160).toBe(true);
    expect(hexToRgbTuple(k.fill)[1]).toBeGreaterThan(hexToRgbTuple(k.fill)[0]);
  });

  it('separates two near-identical kits by lightness', () => {
    const pair = displayKitPair('#3d8bff', '#3f8cff');
    expect(pair.adjusted).toBe(true);
    expect(pair.deltaE).toBeGreaterThanOrEqual(KIT_MIN_DELTA_E);
    expect(pair.A.fill).not.toBe(pair.B.fill);
  });

  it('separates a white derby without losing the white side', () => {
    const pair = displayKitPair('#f5f5f5', '#ececec');
    expect(pair.deltaE).toBeGreaterThanOrEqual(KIT_MIN_DELTA_E);
    const l = [pair.A.fill, pair.B.fill].map((c) => hexToRgbTuple(c)[0]);
    expect(Math.max(...l)).toBeGreaterThan(220);
    expect(Math.abs(l[0]! - l[1]!)).toBeGreaterThan(20);
  });

  it('leaves genuinely different kits apart', () => {
    expect(kitDeltaE('#d12b2b', '#1c3fae')).toBeGreaterThan(30);
    const pair = displayKitPair('#d12b2b', '#1c3fae');
    expect(pair.deltaE).toBeGreaterThan(30);
  });
});

describe('KitColourTracker', () => {
  const raw = (A: string, B: string): TeamColours => ({ A, B, confidence: 0.9 });

  it('blends slowly, locks after teamsCalibrated holds, then ignores new colours', () => {
    const tracker = new KitColourTracker({ tauS: 0.05, lockAfterS: 3 });
    let out = tracker.update(raw('#d12b2b', '#1c3fae'), true, 0);
    for (let t = 0.1; t <= 3.2; t += 0.1) out = tracker.update(raw('#d12b2b', '#1c3fae'), true, t);
    expect(tracker.isLocked).toBe(true);
    const locked = out!;
    const after = tracker.update(raw('#e8e8e8', '#222222'), true, 4)!;
    expect(after.A.fill).toBe(locked.A.fill);
    expect(after.B.fill).toBe(locked.B.fill);
  });

  it('re-opens after a long data break', () => {
    const tracker = new KitColourTracker({ tauS: 0.05, lockAfterS: 0.2, reopenAfterS: 2 });
    for (let t = 0; t <= 1; t += 0.1) tracker.update(raw('#d12b2b', '#1c3fae'), true, t);
    expect(tracker.isLocked).toBe(true);
    expect(tracker.update(undefined, false, 5)).toBeNull();
    expect(tracker.current).toBeNull();
    const fresh = tracker.update(raw('#f2f2f2', '#111111'), true, 6);
    expect(fresh).not.toBeNull();
    expect(tracker.current!.A.edge).toBe('#10151c');
  });

  it('does not lock two near-identical white kits', () => {
    const tracker = new KitColourTracker({ tauS: 0.05, lockAfterS: 0.2 });
    for (let t = 0; t <= 3; t += 0.1) tracker.update(raw('#f2f2f2', '#f5f5f5'), true, t);
    expect(tracker.isLocked).toBe(false);
  });

  it('re-opens when a real kit change persists after the lock', () => {
    const tracker = new KitColourTracker({ tauS: 0.05, lockAfterS: 0.2, reopenJumpDeltaE: 20, reopenJumpS: 0.5 });
    for (let t = 0; t <= 1; t += 0.1) tracker.update(raw('#d12b2b', '#1c3fae'), true, t);
    expect(tracker.isLocked).toBe(true);
    // The first white frame is not enough; a sustained change is.
    tracker.update(raw('#f2f2f2', '#111111'), true, 2);
    expect(tracker.isLocked).toBe(true);
    for (let t = 2.1; t <= 2.7; t += 0.1) tracker.update(raw('#f2f2f2', '#111111'), true, t);
    expect(tracker.isLocked).toBe(false);
  });
});
