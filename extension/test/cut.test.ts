import { describe, expect, it } from 'vitest';
import { CUT_CONFIG, CUT_H, CUT_W, CutDetector } from '../lib/render/cut';

const N = CUT_W * CUT_H;
const DT = 1 / 30;

type Rgb = [number, number, number];

/** A deterministic 32x18 frame: turf stripes + kit-coloured blobs at `seed`-dependent spots. */
function frame(seed: number, brightness = 1, hueShift = 0, pan = 0): Uint8ClampedArray {
  const out = new Uint8ClampedArray(N * 4);
  let s = (seed * 2654435761) >>> 0;
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  // Seeds >= 100 are a different shot: a warm crowd/close-up palette, not another green wide angle.
  const warm = seed >= 100;
  const base: Rgb = warm ? [168, 92, 64] : [48, 116, 44];
  for (let y = 0; y < CUT_H; y++) {
    for (let x = 0; x < CUT_W; x++) {
      const stripe = Math.sin((x + pan) / 3.2 + (y + pan) / 5.1) * 14;
      const i = (y * CUT_W + x) * 4;
      out[i] = Math.max(0, Math.min(255, (base[0] + stripe + rnd() * 12 + hueShift) * brightness));
      out[i + 1] = Math.max(0, Math.min(255, (base[1] + stripe + rnd() * 16) * brightness));
      out[i + 2] = Math.max(0, Math.min(255, (base[2] + stripe + rnd() * 12 - hueShift) * brightness));
      out[i + 3] = 255;
    }
  }
  // Two kit blobs; their positions change with the seed, the way different shots frame different players.
  const kits: Rgb[] = seed % 2 ? [[232, 232, 236], [196, 44, 48]] : [[36, 58, 150], [246, 206, 54]];
  for (let b = 0; b < 2; b++) {
    const bx = Math.floor(rnd() * (CUT_W - 4)), by = Math.floor(rnd() * (CUT_H - 5));
    const kit = kits[b]!;
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 3; x++) {
        const i = ((by + y) * CUT_W + bx + x) * 4;
        out[i] = kit[0] * brightness;
        out[i + 1] = kit[1] * brightness;
        out[i + 2] = kit[2] * brightness;
        out[i + 3] = 255;
      }
    }
  }
  return out;
}

/** Feed `count` frames of the same scene at the detector's 30 fps sample cadence. */
function feed(d: CutDetector, count: number, t0: number, make: (i: number) => Uint8ClampedArray): number {
  let t = t0;
  for (let i = 0; i < count; i++) {
    d.push(make(i), t);
    t += DT;
  }
  return t;
}

describe('CutDetector', () => {
  it('reports a hard camera cut, and only once', () => {
    const d = new CutDetector();
    let t = feed(d, 12, 10, () => frame(1));
    const cut = d.push(frame(101, 1, 0, 7), t);
    expect(cut.cut).toBe(true);
    expect(cut.reason).toBe('hard');
    expect(cut.score).toBeGreaterThan(CUT_CONFIG.floor);
    expect(cut.pixelDiff).toBeGreaterThanOrEqual(CUT_CONFIG.pixelFloor);
    t += DT;
    // The next frame is already the new shot: no second cut.
    expect(d.push(frame(101, 1, 0, 8), t).cut).toBe(false);
    expect(d.cuts).toBe(1);
  });

  it('does not fire on a fast pan (the colour distribution stays put)', () => {
    const d = new CutDetector();
    let cuts = 0;
    let t = 20;
    for (let i = 0; i < 45; i++) {
      // 4 px of 32 per frame at 30 fps = ~360 px/s on a 1920-wide frame: a genuinely fast pan.
      if (d.push(frame(7, 1, 0, i * 4), t).cut) cuts++;
      t += DT;
    }
    expect(cuts).toBe(0);
  });

  it('does not fire on a fade to black', () => {
    const d = new CutDetector();
    let cuts = 0;
    let t = 30;
    for (let i = 0; i < 45; i++) {
      const k = Math.max(0, 1 - i / 44);
      if (d.push(frame(9, k), t).cut) cuts++;
      t += DT;
    }
    expect(cuts).toBe(0);
  });

  it('does not treat a paused frame as a cut', () => {
    const d = new CutDetector();
    const t = feed(d, 8, 0, () => frame(4));
    expect(d.push(frame(4), t - DT / 2).cut).toBe(false);   // same media time, next rAF tick
    expect(d.push(frame(4), t - DT / 2).cut).toBe(false);
  });

  it('treats a media-time jump (seek, rewind, loop seam) as a cut', () => {
    const d = new CutDetector();
    const t = feed(d, 10, 40, () => frame(3));
    const forward = d.push(frame(3), t + 5);
    expect(forward.cut).toBe(true);
    expect(forward.reason).toBe('seek');

    const d2 = new CutDetector();
    const t2 = feed(d2, 10, 40, () => frame(3));
    const back = d2.push(frame(3), t2 - 20);
    expect(back.cut).toBe(true);
    expect(back.reason).toBe('seek');
    // The seeked frame is the new baseline, not a second cut.
    expect(d2.push(frame(3), t2 - 20 + DT).cut).toBe(false);
  });

  it('treats a paused scrub (same-ish media time) as a seek, with cooldown', () => {
    const d = new CutDetector();
    feed(d, 6, 5, () => frame(5));
    const r = d.forceSeek(5.2);
    expect(r.cut).toBe(true);
    expect(r.reason).toBe('seek');
    expect(d.forceSeek(5.21).cut).toBe(false);   // one scrub event, one cut
    expect(d.push(frame(5), 5.22).cut).toBe(false);
  });

  it('adapts the threshold to the rolling median but never below the floor', () => {
    const d = new CutDetector();
    feed(d, 20, 0, () => frame(6));
    expect(d.currentThreshold).toBeGreaterThanOrEqual(CUT_CONFIG.floor);
    const cut = d.push(frame(111), 20 * DT + 0.1);
    expect(cut.cut).toBe(true);
    expect(cut.threshold).toBeGreaterThanOrEqual(CUT_CONFIG.floor);
    expect(cut.median).toBeLessThan(CUT_CONFIG.floor);
  });
});
