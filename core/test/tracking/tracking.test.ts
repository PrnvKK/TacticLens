import { describe, expect, it } from 'vitest';
import { ByteTrackLite, type PersonDet } from '../../src/tracking/bytetrack';
import { BallTracker } from '../../src/tracking/ball';
import { hungarian } from '../../src/tracking/hungarian';

function det(cx: number, cy: number, score = 0.8, w = 0.02, h = 0.08): PersonDet {
  return { cls: 'player', score, box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2] };
}

describe('hungarian', () => {
  it('finds the optimal assignment, rectangular too', () => {
    const c = [[4, 1, 3], [2, 0, 5], [3, 2, 2]];
    const a = hungarian(c, 3, 3);
    const total = a.reduce((s, [r, k]) => s + c[r][k], 0);
    expect(total).toBe(5);
    expect(hungarian([[1, 2], [3, 4], [0, 9]], 3, 2)).toHaveLength(2);
  });
});

describe('ByteTrackLite', () => {
  const dt = 0.125;
  const scene = (t: number) => Array.from({ length: 10 }, (_, i) => det(0.1 + i * 0.08 + 0.01 * t * (i % 2 ? 1 : -1), 0.5 + (i % 3) * 0.1));

  it('keeps stable ids for moving players over 20 s; ids appear only after the birth delay', () => {
    const tr = new ByteTrackLite();
    let ids: number[] = [];
    for (let k = 0; k < 160; k++) {
      const t = k * dt;
      const out = tr.update(scene(t), t);
      if (k === 0) expect(out).toHaveLength(0);
      if (k === 5) ids = out.map((o) => o.id).sort((a, b) => a - b);
    }
    const final = tr.update(scene(160 * dt), 160 * dt).map((o) => o.id).sort((a, b) => a - b);
    expect(ids).toHaveLength(10);
    expect(final).toEqual(ids);
  });

  it('v1 fallback: survives a 0.6 s occlusion and drops the track after its 1 s maxAge', () => {
    const tr = new ByteTrackLite({ tracker: 'v1' });
    let id = -1;
    for (let k = 0; k < 20; k++) {
      const t = k * dt;
      const out = tr.update([det(0.3 + 0.01 * t, 0.5)], t);
      if (k === 19) id = out[0].id;
    }
    let t = 20 * dt;
    for (let k = 0; k < 5; k++, t += dt) {
      const out = tr.update([], t);
      expect(out[0].id).toBe(id);
      expect(out[0].timeSinceUpdate).toBeGreaterThan(0);
    }
    const back = tr.update([det(0.3 + 0.01 * t, 0.5)], t);
    expect(back[0].id).toBe(id);
    t += 0.9;
    tr.update([], t);
    expect(tr.update([], t + 0.3)).toHaveLength(0);
  });

  it('uses a low-score detection to keep a track alive', () => {
    const tr = new ByteTrackLite();
    for (let k = 0; k < 10; k++) tr.update([det(0.5, 0.5, 0.9)], k * dt);
    const out = tr.update([det(0.5, 0.5, 0.2)], 10 * dt);
    expect(out[0].timeSinceUpdate).toBe(0);
  });

  it('drops all tracks on a cut and never reuses ids', () => {
    const tr = new ByteTrackLite();
    let first = 0;
    for (let k = 0; k < 10; k++) { const o = tr.update([det(0.5, 0.5)], k * dt); if (o[0]) first = o[0].id; }
    const after: ReturnType<ByteTrackLite['update']>[] = [];
    for (let k = 10; k < 16; k++) after.push(tr.update([det(0.2, 0.3)], k * dt, k * dt, k === 10));
    expect(after[0]).toHaveLength(0);
    expect(after[5][0].id).toBeGreaterThan(first);
  });

  it('estimates global motion from median velocity', () => {
    const tr = new ByteTrackLite();
    let out: ReturnType<ByteTrackLite['update']> = [];
    for (let k = 0; k < 40; k++) {
      const t = k * dt;
      out = tr.update(Array.from({ length: 8 }, (_, i) => det(0.2 + i * 0.07 + 0.1 * t, 0.5 + (i % 2) * 0.1)), t);
    }
    const [vx, vy] = ByteTrackLite.medianVelocity(out);
    expect(vx).toBeGreaterThan(0.07);
    expect(vx).toBeLessThan(0.13);
    expect(Math.abs(vy)).toBeLessThan(0.02);
  });

  it('handles pan: whole-frame drift of 1.5% per frame keeps ids', () => {
    const tr = new ByteTrackLite();
    const ids: number[][] = [];
    for (let k = 0; k < 30; k++) {
      const out = tr.update(Array.from({ length: 8 }, (_, i) => det(0.5 + i * 0.07 - 0.015 * k, 0.5)), k * dt);
      if (k === 8 || k === 29) ids.push(out.map((o) => o.id).sort((a, b) => a - b));
    }
    expect(ids[0].length).toBeGreaterThanOrEqual(7);
    expect(ids[1]).toEqual(ids[0]);
  });
});

describe('BallTracker', () => {
  it('goes absent -> visible -> searching (decaying visibility) -> absent after ~1 s', () => {
    const b = new BallTracker();
    expect(b.update(0, []).state).toBe('absent');
    let o = b.update(0.1, [{ xy: [0.5, 0.5], score: 0.6 }]);
    expect(o.state).toBe('visible');
    expect(o.visibility).toBe(1);
    o = b.update(0.3, []);
    expect(o.state).toBe('searching');
    expect(o.xy).not.toBeNull();
    const v1 = o.visibility;
    o = b.update(0.7, []);
    expect(o.visibility).toBeLessThan(v1);
    expect(o.coastingS).toBeCloseTo(0.6);
    o = b.update(1.2, []);
    expect(o.state).toBe('absent');
    expect(o.xy).toBeNull();
    o = b.update(1.4, [{ xy: [0.2, 0.2], score: 0.5 }]);
    expect(o.state).toBe('visible');
  });
  it('predicts a moving ball, ignores a single far outlier, accepts a confirmed jump', () => {
    const b = new BallTracker();
    for (let k = 0; k < 10; k++) b.update(k * 0.1, [{ xy: [0.2 + 0.05 * k, 0.5], score: 0.6 }]);
    const p = b.predict(1.0)!;
    expect(p[0]).toBeGreaterThan(0.6);
    let o = b.update(1.0, [{ xy: [0.95, 0.1], score: 0.9 }]);
    expect(o.state).toBe('searching');
    o = b.update(1.1, [{ xy: [0.955, 0.105], score: 0.9 }]);
    expect(o.state).toBe('visible');
    expect(o.xy![0]).toBeGreaterThan(0.85);
  });
  it('resets on a cut', () => {
    const b = new BallTracker();
    b.update(0, [{ xy: [0.5, 0.5], score: 0.6 }]);
    expect(b.update(0.1, [], true).state).toBe('absent');
  });
  it('advances across a scheduled skip without pretending it was a missed detection', () => {
    const b = new BallTracker();
    b.update(0, [{ xy: [0.5, 0.5], score: 0.6 }]);
    const a = b.advance(2 / 12);                      // one skipped ball-model cycle at 12 Hz
    expect(a.state).toBe('visible');
    expect(a.coastingS).toBeCloseTo(1 / 6);
    const c = b.advance(1.4);                        // long gap: the state still decays to absent
    expect(c.state).toBe('absent');
    expect(c.xy).toBeNull();
  });
});
