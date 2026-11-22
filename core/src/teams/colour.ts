// Kit colour presentation: the teams module measures the real shirt colour, this module maps it to a
// colour that reads on grass. The mapping keeps the hue, clamps lightness/saturation, moves green-ish
// hues out of the turf range, gives white/black kits a contrasting outline, and separates near-identical
// kits by lightness. Pure functions, no DOM.
import { deltaE76, rgbToHex, rgbToLab, type Lab } from './lab';

export interface DisplayKit {
  /** Shirt fill colour, '#rrggbb'. */
  fill: string;
  /** Outline that keeps the fill legible on bright or dark grass. */
  edge: string;
  /** True for near-white kits (HUDs may use ink text). */
  light: boolean;
}

export interface DisplayKits {
  A: DisplayKit;
  B: DisplayKit;
  /** CIE76 difference after the separation pass. */
  deltaE: number;
  /** True when the pair was too close and one team's lightness was moved. */
  adjusted: boolean;
}

/** Below this CIE76 distance two kits read as the same colour on a moving picture. */
export const KIT_MIN_DELTA_E = 20;

export function hexToRgbTuple(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const v = Number.parseInt(s, 16);
  if (!Number.isFinite(v)) return [128, 128, 128];
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn;
  const l = (mx + mn) / 2;
  if (d < 1e-9) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === R) h = ((G - B) / d + (G < B ? 6 : 0)) * 60;
  else if (mx === G) h = ((B - R) / d + 2) * 60;
  else h = ((R - G) / d + 4) * 60;
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const H = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((H / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (H < 60) [r, g, b] = [c, x, 0];
  else if (H < 120) [r, g, b] = [x, c, 0];
  else if (H < 180) [r, g, b] = [0, c, x];
  else if (H < 240) [r, g, b] = [0, x, c];
  else if (H < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v: number): number => Math.round((v + m) * 255);
  return [to(r), to(g), to(b)];
}

const labOf = (hex: string): Lab => {
  const [r, g, b] = hexToRgbTuple(hex);
  return rgbToLab(r, g, b);
};
const lightOf = (hex: string): number => labOf(hex)[0];

/** Hue in degrees, exported for tests/tools. */
export function kitHue(hex: string): number {
  const [r, g, b] = hexToRgbTuple(hex);
  return rgbToHsl(r, g, b).h;
}

function finish(h: number, s: number, l: number): DisplayKit {
  const [r, g, b] = hslToRgb(h, s, l);
  const fill = rgbToHex(r, g, b);
  const lab = rgbToLab(r, g, b);
  // White shirts need a dark edge; black shirts a light one. Everything else gets a deeper shade of
  // its own hue, which reads on grass without becoming a second graphic.
  const edge = lab[0] >= 82 ? '#10151c' : lab[0] <= 26 ? '#e8eef4' : rgbToHex(r * 0.55, g * 0.55, b * 0.55);
  return { fill, edge, light: lab[0] >= 82 };
}

/** Map one measured shirt colour to its on-grass display colour. */
export function displayKitColour(hex: string): DisplayKit {
  const [r, g, b] = hexToRgbTuple(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  // A near-white kit (including off-white/cream) is deliberately near-white, not pastel/grass.
  if (l >= 0.86 || (l >= 0.78 && s < 0.12)) return finish(h, Math.min(s, 0.06), 0.94);
  // A black kit stays charcoal; retain a trace of its hue so navy-black and brown-black differ.
  if (l <= 0.16) return finish(h, Math.min(Math.max(s, 0.08), 0.32), 0.17);
  let H = h, S = s, L = l;
  // Keep the hue but make it printable over turf.
  S = Math.max(0.45, Math.min(0.88, S));
  L = Math.max(0.38, Math.min(0.72, L));
  // Turf sits roughly at HSL hue 80..160. Move those greens to yellow-green or teal-green so a kit
  // never reads as a hole in the pitch.
  if (S > 0.18 && H >= 80 && H <= 160) H = H < 120 ? 72 : 166;
  return finish(H, S, L);
}

/** Shift a display kit's lightness while keeping its hue/saturation. */
function withLightness(kit: DisplayKit, l: number): DisplayKit {
  const [r, g, b] = hexToRgbTuple(kit.fill);
  const { h, s } = rgbToHsl(r, g, b);
  return finish(h, s, Math.max(0.15, Math.min(0.95, l)));
}

/** Map both kits and pull too-similar pairs apart by lightness. */
export function displayKitPair(aHex: string, bHex: string): DisplayKits {
  let A = displayKitColour(aHex);
  let B = displayKitColour(bHex);
  let d = deltaE76(labOf(A.fill), labOf(B.fill));
  let adjusted = false;
  for (let i = 0; i < 8 && d < KIT_MIN_DELTA_E; i++) {
    adjusted = true;
    const lA = lightOf(A.fill), lB = lightOf(B.fill);
    // Move B away from A in lightness. If B is already at an extreme, reverse (the two kits are
    // still distinguishable; a white derby becomes white v light grey rather than white v white).
    let dir = lB > lA ? 1 : -1;
    if ((dir > 0 && lB >= 92) || (dir < 0 && lB <= 18)) dir = -dir;
    let next = Math.max(0.15, Math.min(0.95, lB / 100 + dir * 0.075));
    if (next === lB / 100) { dir = -dir; next = Math.max(0.15, Math.min(0.95, lB / 100 + dir * 0.075)); }
    B = withLightness(B, next);
    d = deltaE76(labOf(A.fill), labOf(B.fill));
  }
  return { A, B, deltaE: d, adjusted };
}

/** CIE76 distance between two measured (raw) kits, for diagnostics/tests. */
export function kitDeltaE(aHex: string, bHex: string): number {
  return deltaE76(labOf(aHex), labOf(bHex));
}
