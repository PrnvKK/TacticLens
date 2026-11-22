export type Lab = [number, number, number];

function lin(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}
function f(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
}

/** sRGB (0..255) to CIE Lab (D65). */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE Lab (D65) to sRGB (0..255), clamped to the gamut. */
export function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t: number): number => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) * (6 / 29) * (t - 4 / 29));
  const X = 0.95047 * inv(fx), Y = inv(fy), Z = 1.08883 * inv(fz);
  const R = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const G = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  const B = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  const enc = (c: number): number => {
    const x = Math.max(0, Math.min(1, c));
    return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055));
  };
  return [enc(R), enc(G), enc(B)];
}

/** Component-wise median of a list (robust against outliers). */
export function median3(list: [number, number, number][]): [number, number, number] {
  if (!list.length) return [0, 0, 0];
  const med = (i: 0 | 1 | 2): number => {
    const s = list.map((c) => c[i]).sort((x, y) => x - y);
    return s[s.length >> 1]!;
  };
  return [med(0), med(1), med(2)];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (c: number): string => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** CIE76 colour difference (adequate for the kit-separation threshold). */
export function deltaE76(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Pitch-grass test by hue (HSV hue 55..170 deg), with enough saturation and brightness to be turf. */
export function isGrass(r: number, g: number, b: number): boolean {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (mx < 24 || d < 0.1 * mx) return false;
  if (mx !== g) return false;               // green must dominate (hue 60..180)
  const h = 60 * (2 + (b - r) / d);         // mx === g branch
  return h >= 50 && h <= 170;
}

export interface TorsoSample { lab: Lab; n: number; fraction: number }

const BIN_BITS = 3;                       // 8 x 8 x 8 coarse RGB bins
const BIN_SIDE = 1 << BIN_BITS;
const BIN_SHIFT = 8 - BIN_BITS;

/**
 * Lab of the torso region (upper body: 15%..50% of box height, central 50% of width), grass masked.
 *
 * A plain mean is too fragile in a crowded box: a white touchline, a sponsor board, a skin-toned arm
 * or the crowd behind a thin player can drag both teams toward white. This builds a coarse RGB
 * histogram and returns the mean of the dominant colour mode instead. A kit fills one or two
 * neighbouring bins, while contamination is a minority spread over many bins, so the mode stays on
 * the shirt. Falls back to the full mean when no single mode is convincing.
 *
 * `rgba` is an RGBA image of size W x H; `box` is in the same pixels. Returns null if too few
 * non-grass pixels.
 */
export function sampleTorso(
  rgba: ArrayLike<number>,
  W: number,
  H: number,
  box: [number, number, number, number],
): TorsoSample | null {
  const bw = box[2] - box[0], bh = box[3] - box[1];
  if (bw < 4 || bh < 8) return null;
  const x0 = Math.max(0, Math.round(box[0] + bw * 0.25)), x1 = Math.min(W, Math.round(box[2] - bw * 0.25));
  const y0 = Math.max(0, Math.round(box[1] + bh * 0.15)), y1 = Math.min(H, Math.round(box[1] + bh * 0.5));
  const hist = new Uint16Array(BIN_SIDE * BIN_SIDE * BIN_SIDE);
  let sr = 0, sg = 0, sb = 0, n = 0, tot = 0, bestBin = -1, bestCount = 0;
  const binOf = (r: number, g: number, b: number): number =>
    ((r >> BIN_SHIFT) << (2 * BIN_BITS)) | ((g >> BIN_SHIFT) << BIN_BITS) | (b >> BIN_SHIFT);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      tot++;
      const r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!;
      if (isGrass(r, g, b)) continue;
      sr += r; sg += g; sb += b; n++;
      const bin = binOf(r, g, b);
      const c = ++hist[bin]!;
      if (c > bestCount) { bestCount = c; bestBin = bin; }
    }
  }
  if (n < 6 || n < 0.25 * tot) return null;
  // The mode must own a meaningful share of the torso. Thin shirts and heavy compression noise can
  // split a kit across bins; in that case the full mean is the safer estimate.
  if (bestBin < 0 || bestCount < Math.max(6, n * 0.3)) {
    return { lab: rgbToLab(sr / n, sg / n, sb / n), n, fraction: n / tot };
  }
  let mr = 0, mg = 0, mb = 0, mn = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      const r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!;
      if (isGrass(r, g, b) || binOf(r, g, b) !== bestBin) continue;
      mr += r; mg += g; mb += b; mn++;
    }
  }
  if (mn < 6) return { lab: rgbToLab(sr / n, sg / n, sb / n), n, fraction: n / tot };
  return { lab: rgbToLab(mr / mn, mg / mn, mb / mn), n, fraction: n / tot };
}

/**
 * Team distance in Lab with lightness down-weighted. Shadows and exposure move L far more than the
 * chroma that actually identifies a kit; 0.4 keeps white vs sky-blue apart without letting a sunlit
 * half of one white team become its own "second team" (the old 0.6 weight did exactly that in EA FC).
 */
export const TEAM_L_WEIGHT = 0.4;

/** Distance in Lab with lightness down-weighted (shadows and exposure move L a lot). */
export function labDist(a: Lab, b: Lab, wL = TEAM_L_WEIGHT): number {
  const dl = (a[0] - b[0]) * wL, da = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}
