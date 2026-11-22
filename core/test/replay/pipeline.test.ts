import { describe, expect, it } from 'vitest';
import { GRID_H, GRID_W } from '../../src/scene/analyzer';
import { RawPipeline, type FrameStub, type RawFrame } from '../../src/replay';

/** Deterministic moving texture as a 64x36 RGBA thumb, mirroring the v2 tracker's flow fixture. */
function thumbRgba(shiftPx: number): Uint8ClampedArray {
  const a = new Uint8ClampedArray(GRID_W * GRID_H * 4);
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const sx = x - shiftPx;
      const v = 78 + 24 * Math.sin(sx / 7.3) + 18 * Math.cos(y / 5.1) + 12 * Math.sin((sx + y) / 3.7) +
        (((Math.floor(sx / 8) + Math.floor(y / 8)) & 1) ? 14 : -6);
      const i = (y * GRID_W + x) * 4;
      a[i] = a[i + 1]! = a[i + 2]! = Math.max(0, Math.min(255, v));
      a[i + 3] = 255;
    }
  }
  return a;
}

declare function btoa(s: string): string;

const stub = (t: number, frameIdx: number): FrameStub => ({ t, tMedia: t, playbackRate: 1, quality: 0, frameIdx });
const b64 = (a: Uint8ClampedArray): string => {
  let bin = '';
  for (let i = 0; i < a.length; i++) bin += String.fromCharCode(a[i]!);
  return btoa(bin);
};
const raw = (shiftPx: number): RawFrame => ({ persons: [], thumb: b64(thumbRgba(shiftPx)) });

describe('RawPipeline camera flow', () => {
  it('feeds the recorded thumb to the tracker and reports globalMotion as a per-second pan rate', () => {
    const pipe = new RawPipeline();
    const first = pipe.step(stub(0, 0), raw(0));
    expect(first.globalMotion).toEqual([0, 0]);   // no flow yet: median-velocity fallback with no tracks

    const dt = 0.2, shiftPx = 2;                   // content moves 2 px right per cycle
    const second = pipe.step(stub(dt, 1), raw(shiftPx));
    // The flow displacement is 2 px = 2 / GRID_W per cycle; globalMotion is that divided by the cycle time.
    // (Using the raw displacement would report 2 / GRID_W, ~dt times too small.)
    expect(second.globalMotion[0]).toBeCloseTo(shiftPx / GRID_W / dt, 1);
    expect(Math.abs(second.globalMotion[1])).toBeLessThan(0.05);
  });
});
