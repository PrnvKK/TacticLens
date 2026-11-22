import { describe, expect, it } from 'vitest';
import { decodeYolo, letterboxMap, cropRect, iou } from '../../src/perception/decode';
import { QualityLadder } from '../../src/perception/ladder';
import { BallScheduler } from '../../src/perception/schedule';

describe('decode', () => {
  it('decodes, maps through a letterbox and suppresses duplicates', () => {
    const N = 4, C = 6; // 2 classes
    const d = new Float32Array(C * N);
    const set = (i: number, cx: number, cy: number, w: number, h: number, c0: number, c1: number) => {
      d[i] = cx; d[N + i] = cy; d[2 * N + i] = w; d[3 * N + i] = h; d[4 * N + i] = c0; d[5 * N + i] = c1;
    };
    set(0, 320, 320, 100, 200, 0.9, 0);
    set(1, 322, 322, 100, 200, 0.6, 0);   // duplicate -> NMS
    set(2, 100, 100, 20, 20, 0, 0.5);
    set(3, 500, 500, 20, 20, 0.1, 0.1);   // below threshold
    const map = letterboxMap(1280, 720, 640); // sc .5, oy 140
    const out = decodeYolo(d, C, N, map, 0.25);
    expect(out).toHaveLength(2);
    expect(out[0].box[0]).toBeCloseTo(270 / 0.5);
    expect(out[0].box[1]).toBeCloseTo((220 - 140) / 0.5);
  });
  it('clamps crops inside the frame', () => {
    const r = cropRect(10, 700, 1280, 720, 640);
    expect(r.x0).toBe(0);
    expect(r.y0).toBe(80);
    expect(iou([0, 0, 10, 10], [0, 0, 10, 10])).toBeCloseTo(1);
  });
});

describe('QualityLadder', () => {
  it('steps down after 3 s over threshold and up after 10 s under', () => {
    const l = new QualityLadder();
    let t = 0;
    for (; t < 2.5; t += 0.1) l.push(t, 300);
    expect(l.level).toBe(3);
    for (; t < 7; t += 0.1) l.push(t, 300);
    expect(l.level).toBeLessThan(3);
    const low = l.level;
    for (; t < 12; t += 0.1) l.push(t, 60);
    expect(l.level).toBe(low);           // up is slow
    for (; t < 60; t += 0.1) l.push(t, 60);
    expect(l.level).toBe(3);
  });
  it('can reach Q0 under extreme load', () => {
    const l = new QualityLadder();
    for (let t = 0; t < 60; t += 0.2) l.push(t, 800);
    expect(l.level).toBe(0);
  });
});

describe('BallScheduler', () => {
  const base = { quality: 3 as const, scene: 'WIDE' as const, predicted: null, hint: null, smart: null };
  it('crops at the prediction while visible', () => {
    const s = new BallScheduler();
    expect(s.plan({ ...base, state: 'visible', predicted: [0.5, 0.5] })).toEqual({ mode: 'crop', xy: [0.5, 0.5], why: 'track' });
  });
  it('samples a visible ball every other cycle at Q3, predicting in between', () => {
    const s = new BallScheduler();
    const plans = Array.from({ length: 8 }, () => s.plan({ ...base, state: 'visible', predicted: [0.5, 0.5] }));
    expect(plans.map((p) => p.mode)).toEqual(['crop', 'none', 'crop', 'none', 'crop', 'none', 'crop', 'none']);
    // A scheduled gap is not a miss: the next plan must still be a normal crop.
    for (const p of plans) if (p.mode === 'none') expect(p.skipped).toBe(true);
  });
  it('chases a recently lost ball every cycle, then searches 1280 only every Nth', () => {
    const s = new BallScheduler(5, 3);
    for (let i = 0; i < 3; i++) {
      const p = s.plan({ ...base, state: 'searching', predicted: [0.5, 0.5] });
      expect(p.mode).toBe('crop');
      s.report(p, false);
    }
    const modes: string[] = [];
    for (let i = 0; i < 11; i++) {
      const p = s.plan({ ...base, state: 'searching', predicted: [0.5, 0.5] });
      modes.push(p.mode);
      s.report(p, false);
    }
    // After the miss budget: 1280 on the 1st, 6th and 11th search-branch plans, nothing else.
    expect(modes.filter((m) => m === 'full')).toHaveLength(3);
    expect(modes[0]).toBe('full');
    expect(modes.filter((m) => m === 'none').length).toBeGreaterThan(5);
  });
  it('searches with smart crop first, then 1280 every Nth cycle, nothing in between', () => {
    const s = new BallScheduler(5);
    const modes: string[] = [];
    for (let i = 0; i < 12; i++) {
      const p = s.plan({ ...base, state: 'absent', smart: [0.4, 0.4] });
      modes.push(p.mode);
      s.report(p, false);
    }
    expect(modes[0]).toBe('crop');
    expect(modes.filter((m) => m === 'full').length).toBe(2);
    expect(modes.filter((m) => m === 'none').length).toBeGreaterThan(6);
  });
  it('uses the free soccana hint and skips crowd/graphic scenes and Q0', () => {
    const s = new BallScheduler();
    expect(s.plan({ ...base, state: 'absent', hint: [0.2, 0.3] })).toMatchObject({ mode: 'crop', why: 'hint' });
    expect(s.plan({ ...base, scene: 'CROWD', state: 'visible', predicted: [0.5, 0.5] }).mode).toBe('none');
    expect(s.plan({ ...base, quality: 0, state: 'visible', predicted: [0.5, 0.5] }).mode).toBe('none');
  });
  it('falls back to search after consecutive crop misses', () => {
    const s = new BallScheduler(5, 3);
    for (let i = 0; i < 3; i++) {
      const p = s.plan({ ...base, state: 'searching', predicted: [0.5, 0.5] });
      expect(p.mode).toBe('crop');
      s.report(p, false);
    }
    const p = s.plan({ ...base, state: 'searching', predicted: [0.5, 0.5], smart: [0.3, 0.3] });
    expect(p).toMatchObject({ mode: 'crop', why: 'smart' });
  });
});
