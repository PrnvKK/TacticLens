import { describe, expect, it } from 'vitest';
import { brightenRgb, hexToRgb, type RGB } from '../lib/render/math';
import { drawGroundMarker } from '../lib/render/draw';
import { COLOUR, MARKER, relativeLuminance } from '../lib/render/tokens';

const hex = (c: RGB): string => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const contrast = (a: string, b: string): number => {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
};
const hue = (c: RGB): number => {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < 1e-9) return 0;
  if (mx === r) return (((g - b) / d + (g < b ? 6 : 0)) * 60) % 360;
  if (mx === g) return ((b - r) / d + 2) * 60;
  return ((r - g) / d + 4) * 60;
};

const BRIGHT_GRASS = '#4f9e57';    // sunlit turf
const SHADOW_GRASS = '#1b5c2f';    // shadowed turf
const KITS = ['#f2f2f2', '#ffd633', '#d12b2b', '#1c3fae', '#111111'];

describe('marker style tokens', () => {
  it('is bright, with a 2.5-3 px stroke at 1080p', () => {
    expect(MARKER.opacity).toBeGreaterThanOrEqual(0.9);
    const px1080 = MARKER.strokePx * 1.5;   // u at a 1920-wide video rect
    expect(px1080).toBeGreaterThanOrEqual(2.5);
    expect(px1080).toBeLessThanOrEqual(3);
    expect(MARKER.strong.stroke).toBeGreaterThan(1);
    expect(MARKER.strong.opacity).toBeGreaterThan(MARKER.opacity);
  });

  it('brightens the kit without shifting its hue', () => {
    for (const kit of KITS) {
      const c = hexToRgb(kit);
      const b = brightenRgb(c, MARKER.lightnessBoost, MARKER.minLightness, MARKER.maxLightness);
      expect(relativeLuminance(hex(b))).toBeGreaterThanOrEqual(relativeLuminance(kit) - 1e-6);
      if (Math.max(...c) - Math.min(...c) > 12) {
        // Saturated team colours keep their identity (yellow stays yellow, red stays red).
        const dh = Math.abs(((hue(b) - hue(c) + 540) % 360) - 180);
        expect(dh).toBeLessThan(6);
      }
    }
  });

  it('keeps white and yellow kits readable rather than washing them out', () => {
    const white = brightenRgb(hexToRgb('#f2f2f2'), MARKER.lightnessBoost, MARKER.minLightness, MARKER.maxLightness);
    const yellow = brightenRgb(hexToRgb('#ffd633'), MARKER.lightnessBoost, MARKER.minLightness, MARKER.maxLightness);
    expect(relativeLuminance(hex(white))).toBeGreaterThan(0.85);
    expect(hue(yellow)).toBeLessThan(70);
    expect(relativeLuminance(hex(yellow))).toBeGreaterThan(0.5);
  });

  it('has an edge that survives sunlit and shadowed grass for every kit', () => {
    for (const kit of KITS) {
      const team = hex(brightenRgb(hexToRgb(kit), MARKER.lightnessBoost, MARKER.minLightness, MARKER.maxLightness));
      for (const grass of [BRIGHT_GRASS, SHADOW_GRASS]) {
        // The marker is a composite: team stroke + white inner rim + dark under-shadow/keyline.
        const best = Math.max(contrast(team, grass), contrast(COLOUR.white, grass), contrast(COLOUR.ink, grass));
        expect(best, `${kit} on ${grass}`).toBeGreaterThanOrEqual(3);
      }
    }
    // The two elements that guarantee it:
    expect(contrast(COLOUR.white, BRIGHT_GRASS)).toBeGreaterThanOrEqual(3);
    expect(contrast(COLOUR.ink, BRIGHT_GRASS)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(COLOUR.ink, SHADOW_GRASS)).toBeGreaterThanOrEqual(1.5);   // keyline, not the only cue
    expect(contrast(COLOUR.white, SHADOW_GRASS)).toBeGreaterThanOrEqual(4.5);
  });

  it('paints the full composite: shadow, halo, glow, keyline, team stroke and white rim', () => {
    const strokes: number[] = [];
    let fills = 0;
    const ctx = {
      beginPath() { /* noop */ }, ellipse() { /* noop */ },
      fill() { fills++; }, stroke() { strokes.push(this.lineWidth); },
      fillStyle: '', strokeStyle: '', lineWidth: 1,
    } as unknown as CanvasRenderingContext2D;
    drawGroundMarker(ctx, 100, 200, 30, 0.5, [210, 50, 55], [170, 20, 30], 1, 1.5, 0);
    expect(fills).toBe(2);
    expect(strokes).toHaveLength(5);
    // At u = 1.5 and a nominal player size, the team stroke is ~2.7 CSS px (the 1080p target).
    expect(strokes.some((w) => w > 2.5 && w < 3)).toBe(true);
    expect(Math.max(...strokes)).toBeGreaterThan(strokes[3]!);   // the soft halo is wider than the stroke
  });
});
