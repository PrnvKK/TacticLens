// Offline micro-benchmarks for the perception CPU paths. Not a browser: canvas work (drawImage / getImageData)
// cannot run here, so these cover the pure-JS halves that dominated the old stages:
//   - camera-flow LK at 320x180 (the old `track` stage was ~34 ms in Node: full-frame corner scan + sort)
//   - grey luma (old: full-res 1920x1080 loop; new: 320x180 derived from the 640 readback)
//   - CHW float conversion for the 640 model input (`prep`)
// Bounds are deliberately loose (5-10x the observed p50) so a loaded CI does not flake; the log line is the
// number to report.
import { describe, expect, it } from 'vitest';
import { CameraFlow, estimateCameraMotion, type GreyFrame } from '../../src/tracking/camera';

const W = 320, H = 180;

function grey(shiftPx: number): GreyFrame {
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = x - shiftPx;
      const v = 78 + 24 * Math.sin(sx / 7.3) + 18 * Math.cos(y / 5.1) + 12 * Math.sin((sx + y) / 3.7) +
        (((Math.floor(sx / 16) + Math.floor(y / 16)) & 1) ? 14 : -6);
      data[y * W + x] = Math.max(0, Math.min(255, v));
    }
  }
  return { data, width: W, height: H };
}

const p50 = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
const nowMs = (): number => (globalThis as unknown as { performance: { now(): number } }).performance.now();

function bench(fn: () => void, n = 12): number {
  fn(); fn();
  const xs: number[] = [];
  for (let i = 0; i < n; i++) { const t = nowMs(); fn(); xs.push(nowMs() - t); }
  return p50(xs);
}

describe('micro benchmarks (CPU half of the brain cycle)', () => {
  it('camera flow at 320x180: one-shot and reused-corner cost', () => {
    const a = grey(0), b = grey(6.7);
    const oneShot = bench(() => { estimateCameraMotion(a, b, []); });
    const flow = new CameraFlow();
    let k = 0;
    const frames = Array.from({ length: 12 }, (_, i) => grey(i * 2.2));
    const reused = bench(() => {
      flow.estimate(frames[k % frames.length]!, frames[(k + 1) % frames.length]!, []);
      k++;
    }, 20);
    console.log(`camera flow 320x180: one-shot ${oneShot.toFixed(2)} ms, reused ${reused.toFixed(2)} ms`);
    expect(oneShot).toBeLessThan(20);
    expect(reused).toBeLessThan(10);
  });

  it('grey luma: full-res 1920x1080 vs the derived 320x180 path', () => {
    const big = new Uint8ClampedArray(1920 * 1080 * 4);
    const bigOut = new Uint8Array(1920 * 1080);
    const full = bench(() => {
      for (let i = 0, j = 0; i < bigOut.length; i++, j += 4) bigOut[i] = 0.299 * big[j]! + 0.587 * big[j + 1]! + 0.114 * big[j + 2]!;
    }, 6);
    // what the pipeline now does: 57.6k samples out of the 640x640 letterbox, content rect 640x360
    const lb = new Uint8ClampedArray(640 * 640 * 4);
    const small = new Uint8Array(320 * 180);
    const derived = bench(() => {
      for (let y = 0, i = 0; y < 180; y++) {
        const row = (140 + y * 2) * 640 * 4;
        for (let x = 0; x < 320; x++, i++) {
          const j = row + x * 8;
          small[i] = 0.299 * lb[j]! + 0.587 * lb[j + 1]! + 0.114 * lb[j + 2]!;
        }
      }
    }, 10);
    console.log(`grey luma: full 1920x1080 ${full.toFixed(2)} ms, derived 320x180 ${derived.toFixed(2)} ms`);
    expect(full).toBeLessThan(30);
    expect(derived).toBeLessThan(4);
  });

  it('prep: CHW float conversion for the 640 model input', () => {
    const rgba = new Uint8ClampedArray(640 * 640 * 4);
    const f = new Float32Array(3 * 640 * 640);
    const ms = bench(() => {
      const n = 640 * 640;
      for (let i = 0, j = 0; i < n; i++, j += 4) { f[i] = rgba[j]! / 255; f[n + i] = rgba[j + 1]! / 255; f[2 * n + i] = rgba[j + 2]! / 255; }
    }, 10);
    console.log(`prep CHW 640x640: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(8);
  });
});
