// On-pitch primitives. Pure Canvas2D: px in, pixels out.
// Callers pass already-smoothed positions and eased progress; nothing here owns state.
// Look: graphics are painted on the grass, not boxed around players. Perspective squash comes
// from the engine; everything else is a broadcast-ink palette of white, team colour and Kimi lime.
import { clamp, hexToRgb, lerp, rgba, brightenRgb, type RGB } from './math';
import { COLOUR, DISPLAY_STACK, MARKER, UI_STACK } from './tokens';

export type Pt = [number, number];
const TAU = Math.PI * 2;
export const ACCENT_RGB: RGB = hexToRgb(COLOUR.accent);
const WHITE: RGB = hexToRgb(COLOUR.white);
const INK: RGB = hexToRgb(COLOUR.ink);
const WARN: RGB = hexToRgb(COLOUR.warn);
const NEUTRAL: RGB = [223, 228, 234];
const DIM: RGB = [150, 158, 168];

export const font = (px: number, weight = 600, display = false): string =>
  `${weight} ${Math.max(11, px)}px ${display ? DISPLAY_STACK : UI_STACK}`;

function ell(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number): void {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, TAU);
}

function pathPts(ctx: CanvasRenderingContext2D, pts: Pt[], close: boolean): void {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  if (close) ctx.closePath();
}

const perimeter = (pts: Pt[], close: boolean): number => {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  if (close && pts.length > 2) s += Math.hypot(pts[0]![0] - pts[pts.length - 1]![0], pts[0]![1] - pts[pts.length - 1]![1]);
  return s;
};

/** Catmull-Rom through points, sampled so joins are smooth at broadcast scale. */
function catmullRom(ctx: CanvasRenderingContext2D, pts: Pt[], close = false, steps = 10): void {
  if (pts.length < 2) return;
  const p = pts;
  const n = p.length;
  const at = (i: number): Pt => close ? p[((i % n) + n) % n]! : p[Math.max(0, Math.min(n - 1, i))]!;
  ctx.beginPath();
  if (!close) ctx.moveTo(p[0]![0], p[0]![1]);
  else ctx.moveTo((at(-1)[0] + p[0]![0]) / 2, (at(-1)[1] + p[0]![1]) / 2);
  const segs = close ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      ctx.lineTo(x, y);
    }
  }
  if (close) ctx.closePath();
}

/** Rounded closed polygon: quadratic through edge midpoints. No Catmull overshoot on a hull. */
function smoothClosed(ctx: CanvasRenderingContext2D, pts: Pt[]): void {
  if (pts.length < 3) return;
  const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  ctx.beginPath();
  const first = mid(pts[pts.length - 1]!, pts[0]!);
  ctx.moveTo(first[0], first[1]);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!, n = pts[(i + 1) % pts.length]!;
    const m = mid(p, n);
    ctx.quadraticCurveTo(p[0], p[1], m[0], m[1]);
  }
  ctx.closePath();
}

function curveLength(pts: Pt[], close = false): number {
  if (pts.length < 2) return 0;
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  if (close) s += Math.hypot(pts[0]![0] - pts[pts.length - 1]![0], pts[0]![1] - pts[pts.length - 1]![1]);
  return Math.max(s, 1);
}

/**
 * Calm player marker: a flattened ellipse at the feet in the brightened team colour. It is deliberately
 * an outline, not a disc, but it must survive a bright, sunlit pitch and a white or yellow kit:
 *  - a faint dark contact shadow under the feet (dark separation from bright grass),
 *  - a soft outer glow plus a wider halo in team colour (reads at 60 fps),
 *  - a thin kit-edge keyline, the team-colour stroke, and a white inner rim (an edge on any kit).
 * `strength` 0..1 is the carrier/highlighted state: slightly thicker, brighter, never a new shape.
 */
export function drawGroundMarker(
  ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, squash: number,
  rgb: RGB, edge: RGB, alpha: number, u: number, strength = 0,
): void {
  if (alpha <= 0.01) return;
  const k = clamp(strength, 0, 1);
  const ry = Math.max(1, rx * squash);
  const team = brightenRgb(rgb, MARKER.lightnessBoost, MARKER.minLightness, MARKER.maxLightness);
  const a = alpha * lerp(MARKER.opacity, MARKER.strong.opacity, k);
  const size = clamp(rx / (MARKER.sizeRefPx * u), MARKER.sizeScaleMin, MARKER.sizeScaleMax);
  const stroke = MARKER.strokePx * u * size * lerp(1, MARKER.strong.stroke, k);

  // 1. soft dark contact shadow, offset below the feet: the marker reads on bright grass
  ell(ctx, x, y + ry * MARKER.shadowOffset, rx * MARKER.shadowScale, ry * MARKER.shadowScale);
  ctx.fillStyle = rgba(INK, MARKER.shadowAlpha * a);
  ctx.fill();

  // 2. wide team halo, then a tighter glow
  ell(ctx, x, y, rx * MARKER.haloScale, ry * MARKER.haloScale);
  ctx.strokeStyle = rgba(team, MARKER.haloAlpha * a);
  ctx.lineWidth = MARKER.haloPx * u * size;
  ctx.stroke();
  ell(ctx, x, y, rx * MARKER.glowScale, ry * MARKER.glowScale);
  ctx.strokeStyle = rgba(team, MARKER.glowAlpha * lerp(1, MARKER.strong.glow, k) * a);
  ctx.lineWidth = MARKER.glowPx * u * size;
  ctx.stroke();

  // 3. a translucent team tint inside the ellipse
  ell(ctx, x, y, rx, ry);
  ctx.fillStyle = rgba(team, MARKER.fillAlpha * lerp(1, MARKER.strong.fill, k) * a);
  ctx.fill();

  // 4. kit-edge keyline just outside the main stroke (white kits get a dark edge, black kits a light one)
  ell(ctx, x + MARKER.keylineOffsetPx * u, y + MARKER.keylineOffsetPx * u, rx, ry);
  ctx.strokeStyle = rgba(edge, MARKER.keylineAlpha * a);
  ctx.lineWidth = stroke + MARKER.keylinePx * u;
  ctx.stroke();

  // 5. main team-colour stroke
  ell(ctx, x, y, rx, ry);
  ctx.strokeStyle = rgba(team, MARKER.strokeAlpha * a);
  ctx.lineWidth = stroke;
  ctx.stroke();

  // 6. thin white inner rim: a guaranteed bright edge whatever the kit or the turf
  ell(ctx, x, y, rx * MARKER.innerRimScale, ry * MARKER.innerRimScale);
  ctx.strokeStyle = rgba(WHITE, MARKER.innerRimAlpha * a);
  ctx.lineWidth = MARKER.innerRimPx * u * size * lerp(1, MARKER.strong.innerRim, k);
  ctx.stroke();
}

/** Ball marker with a tapered comet trail. trail is oldest-first, age in seconds. */
export function drawBall(
  ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number, scale: number,
  trail: { x: number; y: number; age: number }[], u: number,
): void {
  if (alpha <= 0.01) return;
  const rr = r * scale;
  // shadow on the grass
  ctx.beginPath();
  ctx.ellipse(x, y + rr * 0.85, rr * 1.15, rr * 0.38, 0, 0, TAU);
  ctx.fillStyle = `rgba(0,0,0,${(0.28 * alpha).toFixed(3)})`;
  ctx.fill();
  // comet trail, two passes: a soft team-neutral glow and a white core
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1]!, b = trail[i]!;
      const k = clamp(1 - b.age / 0.6, 0, 1);
      if (k <= 0.02) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = pass === 0 ? rgba(ACCENT_RGB, 0.2 * k * alpha) : rgba(WHITE, 0.55 * k * alpha);
      ctx.lineWidth = pass === 0 ? Math.max(2, rr * 3.1 * k) : Math.max(1, rr * 1.05 * k);
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }
  // sphere
  const g = ctx.createRadialGradient(x - rr * 0.32, y - rr * 0.36, rr * 0.1, x, y, rr * 1.12);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.6, '#eef4f8');
  g.addColorStop(1, '#c7d4dc');
  ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = `rgba(4,10,16,${(0.55 * alpha).toFixed(3)})`;
  ctx.lineWidth = Math.max(1, 0.8 * u);
  ctx.stroke();
  ctx.fillStyle = `rgba(10,16,22,${(0.7 * alpha).toFixed(3)})`;
  ctx.beginPath(); ctx.arc(x - rr * 0.28, y - rr * 0.16, rr * 0.19, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(x + rr * 0.3, y + rr * 0.22, rr * 0.14, 0, TAU); ctx.fill();
  // live ring + two ticks
  ctx.beginPath(); ctx.arc(x, y, rr * 1.9, 0, TAU);
  ctx.strokeStyle = rgba(WHITE, 0.7 * alpha);
  ctx.lineWidth = 1.4 * u;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, rr * 2.55, -0.5, 0.5);
  ctx.strokeStyle = rgba(ACCENT_RGB, 0.8 * alpha);
  ctx.lineWidth = 1.5 * u;
  ctx.stroke();
}

/** Dim layer with soft radial holes. a is the dim strength (0.35 in the show). */
export function drawDim(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, a: number,
  holes: { x: number; y: number; r: number }[],
): void {
  if (a <= 0.003) return;
  ctx.fillStyle = `rgba(2,6,10,${a.toFixed(3)})`;
  ctx.fillRect(x, y, w, h);
  if (!holes.length) return;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  for (const hl of holes) {
    const cy = hl.y - hl.r * 0.75;
    const g = ctx.createRadialGradient(hl.x, cy, hl.r * 0.15, hl.x, cy, hl.r * 2.3);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.85)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(hl.x - hl.r * 2.5, cy - hl.r * 2.5, hl.r * 5, hl.r * 5);
  }
  ctx.restore();
  // a breath of cool light in the hole
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (const hl of holes) {
    const cy = hl.y - hl.r * 0.7;
    const g = ctx.createRadialGradient(hl.x, cy, hl.r * 0.1, hl.x, cy, hl.r * 1.8);
    g.addColorStop(0, 'rgba(190,220,255,0.055)');
    g.addColorStop(1, 'rgba(190,220,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(hl.x - hl.r * 2, cy - hl.r * 2, hl.r * 4, hl.r * 4);
  }
  ctx.restore();
}

/** Spotlight ring: a segmented stroke draws 0 -> 360 degrees, then glow-pulses. */
export function drawSpotRing(
  ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, squash: number, p: number, alpha: number, u: number,
  rgb: RGB = WHITE, pulse = 0,
): void {
  if (alpha <= 0.01 || p <= 0) return;
  const ry = rx * squash;
  const a0 = -Math.PI / 2;
  const sweep = TAU * clamp(p, 0, 1);
  for (let pass = 0; pass < 2; pass++) {
    ctx.beginPath();
    ctx.ellipse(x, y, rx * (1.38 + pass * 0.14), ry * (1.38 + pass * 0.14), 0, a0, a0 + sweep);
    ctx.strokeStyle = pass === 0 ? rgba(ACCENT_RGB, 0.38 * alpha) : rgba(rgb, (0.9 - pass * 0.35) * alpha);
    ctx.lineWidth = (pass === 0 ? 8 : 2.6) * u;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
  if (pulse > 0.01) {
    ctx.beginPath();
    ctx.ellipse(x, y, rx * (1.6 + pulse * 0.25), ry * (1.6 + pulse * 0.25), 0, 0, TAU);
    ctx.strokeStyle = rgba(ACCENT_RGB, 0.32 * (1 - pulse) * alpha);
    ctx.lineWidth = 2 * u;
    ctx.stroke();
  }
}

/** Player tag: leader line draws, then text wipes left to right. */
export function drawTag(
  ctx: CanvasRenderingContext2D, x: number, y: number, text: string, p: number, alpha: number, u: number,
  fontPx: number, flip = false, plateRgb: RGB = ACCENT_RGB, ink: RGB = INK, below = false,
): void {
  if (alpha <= 0.01 || p <= 0) return;
  const lead = clamp(p / 0.42, 0, 1);
  const wipe = clamp((p - 0.42) / 0.58, 0, 1);
  const dx = (flip ? -1 : 1) * 18 * u, dy = (below ? 26 : -30) * u;
  const x1 = x + dx * lead, y1 = y + dy * lead;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x1 + (flip ? -10 : 10) * u * wipe, y1);
  ctx.strokeStyle = rgba(plateRgb, alpha);
  ctx.lineWidth = 1.8 * u;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 2.4 * u, 0, TAU);
  ctx.fillStyle = rgba(plateRgb, alpha);
  ctx.fill();
  if (wipe <= 0) return;
  ctx.font = font(fontPx, 700);
  const tw = ctx.measureText(text).width;
  const padX = 9 * u, h = Math.max(fontPx, 11) + 11 * u;
  const w = tw + padX * 2 + 4 * u;
  const bx = flip ? x1 - 10 * u - w : x1 + 10 * u;
  const by = below ? y1 + 2 * u : y1 - h;
  ctx.save();
  ctx.beginPath();
  ctx.rect(flip ? bx + w * (1 - wipe) : bx, by - 2, w * wipe, h + 4);
  ctx.clip();
  ctx.beginPath();
  ctx.roundRect(bx, by, w, h, 3 * u);
  ctx.fillStyle = `rgba(6,10,16,${(0.9 * alpha).toFixed(3)})`;
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(bx, by, w, 2 * u, 1 * u);
  ctx.fillStyle = rgba(plateRgb, alpha);
  ctx.fill();
  ctx.beginPath();
  ctx.rect(bx, by, 3 * u, h);
  ctx.fillStyle = rgba(plateRgb, alpha);
  ctx.fill();
  ctx.fillStyle = rgba(WHITE, alpha);
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + padX, by + h / 2 + 0.5);
  // tiny team ink square keeps the tag tied to the plate
  ctx.fillStyle = rgba(ink, 0.9 * alpha);
  ctx.fillRect(bx + w - padX * 0.55, by + h / 2 - 1.5 * u, 3 * u, 3 * u);
  ctx.restore();
}

function arrowHead(
  ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, size: number,
  rgb: RGB, alpha: number, pop: number,
): void {
  if (pop <= 0) return;
  const ang = Math.atan2(by - ay, bx - ax);
  const s = size * pop;
  ctx.beginPath();
  ctx.moveTo(bx + Math.cos(ang) * s * 0.45, by + Math.sin(ang) * s * 0.45);
  ctx.lineTo(bx + Math.cos(ang + 2.48) * s, by + Math.sin(ang + 2.48) * s);
  ctx.lineTo(bx + Math.cos(ang - 2.48) * s, by + Math.sin(ang - 2.48) * s);
  ctx.closePath();
  ctx.fillStyle = rgba(rgb, alpha);
  ctx.fill();
  if (pop > 0.9) {
    ctx.strokeStyle = rgba(WHITE, 0.5 * alpha);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** Pass lane. Draws origin -> target, then pulses a travelling bead. */
export function drawLane(
  ctx: CanvasRenderingContext2D, a: Pt, b: Pt, p: number, q: number, alpha: number, width: number,
  rgb: RGB, blocked: boolean, u: number, pulse = 0, now = 0,
): void {
  if (alpha <= 0.01) return;
  const sx = lerp(a[0], b[0], q), sy = lerp(a[1], b[1], q);
  const pp = clamp(p, 0, 1);
  const ex = lerp(a[0], b[0], pp), ey = lerp(a[1], b[1], pp);
  const breathe = 0.86 + 0.14 * Math.sin(now * 2.4 + a[0] * 0.01);
  ctx.lineCap = 'round';
  // soft glow under the line
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
  ctx.strokeStyle = rgba(rgb, (blocked ? 0.12 : 0.2) * alpha * breathe);
  ctx.lineWidth = width * 3.2;
  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
  ctx.strokeStyle = rgba(rgb, (blocked ? 0.55 : 0.9) * alpha * breathe);
  ctx.lineWidth = width;
  ctx.setLineDash(blocked ? [width * 2.4, width * 2.4] : []);
  ctx.lineDashOffset = blocked ? -now * width * 3 : 0;
  ctx.stroke();
  ctx.setLineDash([]);
  if (blocked && p > 0.5) {
    const mx = lerp(a[0], b[0], 0.5), my = lerp(a[1], b[1], 0.5), k = 5.5 * u;
    ctx.beginPath();
    ctx.moveTo(mx - k, my - k); ctx.lineTo(mx + k, my + k);
    ctx.moveTo(mx + k, my - k); ctx.lineTo(mx - k, my + k);
    ctx.strokeStyle = rgba(rgb, 0.95 * alpha);
    ctx.lineWidth = 2.2 * u;
    ctx.stroke();
  } else if (!blocked) {
    arrowHead(ctx, a[0], a[1], b[0], b[1], 11 * u + width, rgb, alpha, clamp((p - 0.88) / 0.12, 0, 1));
    if (pp > 0.2) {
      const t = (now * 0.55 + pulse) % 1;
      const bx = lerp(sx, ex, t), by = lerp(sy, ey, t);
      ctx.beginPath();
      ctx.arc(bx, by, Math.max(1.6, width * 0.55), 0, TAU);
      ctx.fillStyle = rgba(WHITE, 0.85 * alpha);
      ctx.fill();
    }
  }
}

/** Shape hull: translucent fill, smooth outline, corner ticks. */
export function drawHull(ctx: CanvasRenderingContext2D, pts: Pt[], p: number, alpha: number, rgb: RGB, u: number): void {
  if (pts.length < 3 || alpha <= 0.01) return;
  const k = clamp(p, 0, 1);
  smoothClosed(ctx, pts);
  ctx.fillStyle = rgba(rgb, 0.09 * k * alpha);
  ctx.fill();
  const per = curveLength(pts, true) * 1.35;
  ctx.setLineDash([per * k, per]);
  ctx.strokeStyle = rgba(rgb, 0.72 * alpha);
  ctx.lineWidth = 1.7 * u;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.setLineDash([]);
  if (p > 0.5) {
    for (const q of pts) {
      ctx.beginPath();
      ctx.arc(q[0], q[1], 2.6 * u, 0, TAU);
      ctx.fillStyle = rgba(rgb, 0.85 * alpha);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(q[0], q[1], 4.8 * u, 0, TAU);
      ctx.strokeStyle = rgba(WHITE, 0.14 * alpha);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

export interface FormationLine {
  pts: Pt[];
  confidence: number;
  emphasis: boolean;
}

/** Formation lines: Catmull-Rom through each line, faded by line confidence. */
export function drawFormation(
  ctx: CanvasRenderingContext2D, lines: FormationLine[], p: number, alpha: number, rgb: RGB, u: number,
): void {
  if (alpha <= 0.01) return;
  const k = clamp(p, 0, 1);
  lines.forEach((line, idx) => {
    if (line.pts.length < 2) return;
    const conf = clamp(line.confidence, 0, 1);
    const a = alpha * (0.32 + conf * 0.68) * (line.emphasis ? 1 : 0.55);
    if (a <= 0.01) return;
    const per = curveLength(line.pts, false) * 1.3;
    catmullRom(ctx, line.pts, false, 12);
    // glow pass
    ctx.setLineDash([per * k, per]);
    ctx.strokeStyle = rgba(rgb, a * 0.12);
    ctx.lineWidth = (line.emphasis ? 6 : 3.5) * u;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.strokeStyle = line.emphasis ? rgba(WHITE, a * 0.88) : rgba(rgb, a * 0.7);
    ctx.lineWidth = (line.emphasis ? 1.9 : 1.0) * u;
    ctx.stroke();
    ctx.setLineDash([]);
    if (k > 0.7) {
      const dots = clamp(k * 1.4 - 0.4, 0, 1);
      for (const q of line.pts) {
        ctx.beginPath();
        ctx.arc(q[0], q[1], (line.emphasis ? 2.6 : 1.8) * u, 0, TAU);
        ctx.fillStyle = rgba(line.emphasis ? WHITE : rgb, dots * a);
        ctx.fill();
      }
      // end ticks, like a broadcast line graphic
      if (line.pts.length && line.emphasis) {
        const e = line.pts[line.pts.length - 1]!, s = line.pts[0]!;
        for (const q of [s, e]) {
          ctx.beginPath();
          ctx.moveTo(q[0], q[1] - 5 * u);
          ctx.lineTo(q[0], q[1] + 5 * u);
          ctx.strokeStyle = rgba(WHITE, a * 0.7);
          ctx.lineWidth = 1.3 * u;
          ctx.stroke();
        }
      }
    }
    void idx;
  });
}

/** Overload box: corner brackets snap in, label plate counts up. */
export function drawOverload(
  ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, p: number, alpha: number,
  text: string, rgb: RGB, u: number, fontPx: number,
): void {
  if (alpha <= 0.01) return;
  const k = 1 - clamp(p, 0, 1);
  const grow = k * 22 * u;
  const L = x0 - grow, T = y0 - grow, R = x1 + grow, B = y1 + grow;
  const c = Math.min(16 * u, (R - L) / 3, (B - T) / 3);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.roundRect(L, T, R - L, B - T, 7 * u);
  ctx.fillStyle = rgba(rgb, 0.065 * alpha * (1 - k * 0.55));
  ctx.fill();
  ctx.strokeStyle = rgba(rgb, 0.2 * alpha);
  ctx.lineWidth = 1 * u;
  ctx.stroke();
  ctx.strokeStyle = rgba(rgb, 0.98 * alpha);
  ctx.lineWidth = 3 * u;
  ctx.beginPath();
  ctx.moveTo(L, T + c); ctx.lineTo(L, T); ctx.lineTo(L + c, T);
  ctx.moveTo(R - c, T); ctx.lineTo(R, T); ctx.lineTo(R, T + c);
  ctx.moveTo(R, B - c); ctx.lineTo(R, B); ctx.lineTo(R - c, B);
  ctx.moveTo(L + c, B); ctx.lineTo(L, B); ctx.lineTo(L, B - c);
  ctx.stroke();
  if (text) {
    ctx.font = font(fontPx, 700, true);
    const tw = ctx.measureText(text).width;
    const w = tw + 17 * u, h = fontPx + 11 * u;
    // bottom-right inside the box: clear of the scorebar and the left lower-third
    const lx = R - w - 7 * u;
    const ly = B - h - 7 * u;
    ctx.beginPath();
    ctx.roundRect(lx, ly, w, h, 3 * u);
    ctx.fillStyle = `rgba(6,10,16,${(0.92 * alpha).toFixed(3)})`;
    ctx.fill();
    ctx.beginPath();
    ctx.rect(lx, ly, 3 * u, h);
    ctx.fillStyle = rgba(rgb, alpha);
    ctx.fill();
    ctx.fillStyle = rgba(WHITE, alpha);
    ctx.textBaseline = 'middle';
    ctx.fillText(text, lx + 9 * u, ly + h / 2 + 0.5);
  }
}

/** Marking link: thin dashed line and a small distance tag. */
export function drawLink(
  ctx: CanvasRenderingContext2D, a: Pt, b: Pt, alpha: number, rgb: RGB, u: number, pulse: number, label = '',
): void {
  if (alpha <= 0.01) return;
  const breathe = 0.7 + 0.3 * Math.sin(pulse * TAU);
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.strokeStyle = rgba(rgb, 0.62 * alpha * breathe);
  ctx.lineWidth = 1.4 * u;
  ctx.setLineDash([5 * u, 4.4 * u]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(a[0], a[1], 1.9 * u, 0, TAU);
  ctx.fillStyle = rgba(rgb, 0.85 * alpha);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(b[0], b[1], 1.9 * u, 0, TAU);
  ctx.fillStyle = rgba(WHITE, 0.8 * alpha);
  ctx.fill();
  if (pulse > 0) {
    ctx.beginPath();
    ctx.arc(a[0], a[1], (9 + 8 * pulse) * u, 0, TAU);
    ctx.strokeStyle = rgba(rgb, 0.6 * (1 - pulse) * alpha);
    ctx.lineWidth = 1.6 * u;
    ctx.stroke();
  }
  if (label) {
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const ox = -Math.sin(ang) * 10 * u, oy = Math.cos(ang) * 10 * u;
    ctx.font = font(10.5 * u, 700);
    const tw = ctx.measureText(label).width;
    const w = tw + 10 * u, h = 14 * u;
    ctx.beginPath();
    ctx.roundRect(mx - w / 2 + ox, my - h / 2 + oy, w, h, 2 * u);
    ctx.fillStyle = `rgba(6,10,16,${(0.86 * alpha).toFixed(3)})`;
    ctx.fill();
    ctx.fillStyle = rgba(WHITE, 0.9 * alpha);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(label, mx + ox, my + oy + 0.5);
    ctx.textAlign = 'left';
  }
}

/** Run arrow ahead of a sprinting player. */
export function drawRun(
  ctx: CanvasRenderingContext2D, a: Pt, dir: Pt, len: number, p: number, alpha: number, rgb: RGB, u: number,
): void {
  const m = Math.hypot(dir[0], dir[1]);
  if (m < 1e-6 || alpha <= 0.01) return;
  const reach = len * clamp(p, 0, 1);
  const ex = a[0] + (dir[0] / m) * reach, ey = a[1] + (dir[1] / m) * reach;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(ex, ey);
  ctx.strokeStyle = rgba(rgb, 0.16 * alpha);
  ctx.lineWidth = 9 * u;
  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(ex, ey);
  ctx.strokeStyle = rgba(rgb, 0.92 * alpha);
  ctx.lineWidth = 2.8 * u;
  ctx.stroke();
  arrowHead(ctx, a[0], a[1], ex, ey, 11 * u, rgb, alpha, clamp((p - 0.82) / 0.18, 0, 1));
  if (p > 0.6) {
    const ang = Math.atan2(dir[1], dir[0]);
    for (let i = 0; i < 2; i++) {
      const d = reach * (0.34 + i * 0.18);
      const cx = a[0] + Math.cos(ang) * d, cy = a[1] + Math.sin(ang) * d;
      ctx.beginPath();
      ctx.arc(cx, cy, 1.6 * u, 0, TAU);
      ctx.fillStyle = rgba(WHITE, 0.65 * alpha);
      ctx.fill();
    }
  }
}

/** Pressure ring: eight segments, n lit (one per opponent within pressure range). */
export function drawPressure(
  ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, squash: number, n: number,
  p: number, alpha: number, rgb: RGB, u: number,
): void {
  if (alpha <= 0.01) return;
  const ry = rx * squash;
  const seg = TAU / 8, gap = 0.2;
  for (let i = 0; i < 8; i++) {
    const lit = i < n;
    ctx.beginPath();
    ctx.ellipse(x, y, rx * 1.74, ry * 1.74, 0, -Math.PI / 2 + i * seg + gap, -Math.PI / 2 + (i + 1) * seg - gap);
    ctx.strokeStyle = rgba(lit ? ACCENT_RGB : rgb, (lit ? 0.95 : 0.22) * alpha * clamp(p * 1.6 - i * 0.06, 0, 1));
    ctx.lineWidth = (lit ? 3.8 : 1.8) * u;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}

/** Space pocket: soft radial light on the grass. */
export function drawPocket(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, p: number, alpha: number, rgb: RGB): void {
  if (alpha <= 0.01) return;
  const rr = Math.max(r, 12) * (0.7 + 0.3 * p);
  const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
  g.addColorStop(0, rgba(rgb, 0.32 * alpha * p));
  g.addColorStop(0.6, rgba(rgb, 0.14 * alpha * p));
  g.addColorStop(1, rgba(rgb, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(x, y, rr, rr * 0.58, 0, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x, y, rr * 0.72, rr * 0.42, 0, 0, TAU);
  ctx.strokeStyle = rgba(WHITE, 0.18 * alpha * p);
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 5]);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Switch arc: curved arrow carrier -> far-side player, with a travelling light. */
export function drawSwitch(
  ctx: CanvasRenderingContext2D, a: Pt, b: Pt, p: number, q: number, alpha: number, rgb: RGB, u: number, now = 0,
): void {
  if (alpha <= 0.01) return;
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  const cx = mx + (dy / l) * -l * 0.28, cy = my + (dx / l) * l * 0.28 - l * 0.12;
  const steps = 30;
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, it = 1 - t;
    pts.push([it * it * a[0] + 2 * it * t * cx + t * t * b[0], it * it * a[1] + 2 * it * t * cy + t * t * b[1]]);
  }
  const i0 = Math.floor(clamp(q, 0, 1) * steps), i1 = Math.max(i0 + 1, Math.floor(clamp(p, 0, 1) * steps));
  const draw = (): void => {
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) (i === i0 ? ctx.moveTo(pts[i]![0], pts[i]![1]) : ctx.lineTo(pts[i]![0], pts[i]![1]));
  };
  draw();
  ctx.strokeStyle = rgba(rgb, 0.14 * alpha);
  ctx.lineWidth = 8 * u;
  ctx.lineCap = 'round';
  ctx.stroke();
  draw();
  ctx.strokeStyle = rgba(rgb, 0.94 * alpha);
  ctx.lineWidth = 2.6 * u;
  ctx.stroke();
  const e = pts[Math.min(i1, steps)]!, pr = pts[Math.max(i1 - 1, 0)]!;
  arrowHead(ctx, pr[0], pr[1], e[0], e[1], 11 * u, rgb, alpha, clamp((p - 0.88) / 0.12, 0, 1));
  if (p > 0.4) {
    const t = (now * 0.42) % 1;
    const fi = Math.floor(t * (i1 - i0)) + i0;
    const pt = pts[Math.min(fi, i1)]!;
    ctx.beginPath();
    ctx.arc(pt[0], pt[1], 2.1 * u, 0, TAU);
    ctx.fillStyle = rgba(WHITE, 0.9 * alpha);
    ctx.fill();
  }
}

/** Prediction ghost: marching dashes, solid on a hit, desaturated fade on a miss. */
export function drawPrediction(
  ctx: CanvasRenderingContext2D, a: Pt, b: Pt, p: number, alpha: number, status: 'open' | 'hit' | 'miss' | 'void',
  march: number, resolveP: number, u: number,
): void {
  if (alpha <= 0.01) return;
  const pp = clamp(p, 0, 1);
  const ex = lerp(a[0], b[0], pp), ey = lerp(a[1], b[1], pp);
  const miss = status === 'miss' || status === 'void';
  const rgb: RGB = miss ? DIM : status === 'hit' ? WHITE : ACCENT_RGB;
  const al = miss ? alpha * (1 - resolveP) : alpha;
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(ex, ey);
  ctx.strokeStyle = rgba(rgb, 0.16 * al);
  ctx.lineWidth = 8 * u;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(ex, ey);
  ctx.strokeStyle = rgba(rgb, 0.95 * al);
  ctx.lineWidth = 2.6 * u;
  const dash = 9 * u;
  ctx.setLineDash(status === 'hit' ? [dash * 1.5 * (1 - resolveP) + 0.01, dash * 1.2 * (1 - resolveP)] : [dash, dash * 0.8]);
  ctx.lineDashOffset = -march * dash * 1.8;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
  arrowHead(ctx, a[0], a[1], b[0], b[1], 12 * u, rgb, al, clamp((p - 0.82) / 0.18, 0, 1));
  // target ellipse
  ctx.beginPath();
  ctx.ellipse(b[0], b[1], 18 * u, 7 * u, 0, 0, TAU);
  ctx.strokeStyle = rgba(rgb, 0.8 * al);
  ctx.lineWidth = 1.8 * u;
  ctx.setLineDash(status === 'open' ? [4 * u, 4 * u] : []);
  ctx.stroke();
  ctx.setLineDash([]);
  if (status === 'open') {
    const pulse = (march * 0.33) % 1;
    ctx.beginPath();
    ctx.ellipse(b[0], b[1], (20 + pulse * 10) * u, (8 + pulse * 4) * u, 0, 0, TAU);
    ctx.strokeStyle = rgba(ACCENT_RGB, 0.3 * (1 - pulse) * al);
    ctx.lineWidth = 1.2 * u;
    ctx.stroke();
  }
}

/** Lag ghost: faint marker where the ball was when a slow answer arrived. */
export function drawLagGhost(
  ctx: CanvasRenderingContext2D, ghost: Pt, now: Pt | null, p: number, alpha: number, text: string, u: number, fontPx: number,
): void {
  if (alpha <= 0.01) return;
  const al = alpha * clamp(p, 0, 1);
  const col = WARN;
  if (now) {
    ctx.beginPath(); ctx.moveTo(ghost[0], ghost[1]); ctx.lineTo(now[0], now[1]);
    ctx.strokeStyle = rgba(col, 0.5 * al);
    ctx.lineWidth = 1.3 * u;
    ctx.setLineDash([4 * u, 4 * u]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.beginPath(); ctx.arc(ghost[0], ghost[1], 9 * u, 0, TAU);
  ctx.fillStyle = rgba(col, 0.16 * al);
  ctx.fill();
  ctx.strokeStyle = rgba(col, 0.85 * al);
  ctx.lineWidth = 1.8 * u;
  ctx.setLineDash([3 * u, 3 * u]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = font(fontPx, 700);
  const tw = ctx.measureText(text).width;
  const bx = ghost[0] + 13 * u, by = ghost[1] - 26 * u, w = tw + 12 * u, h = fontPx + 9 * u;
  ctx.beginPath(); ctx.roundRect(bx, by, w, h, 2 * u);
  ctx.fillStyle = `rgba(6,10,16,${(0.86 * al).toFixed(3)})`;
  ctx.fill();
  ctx.beginPath(); ctx.rect(bx, by, 2.5 * u, h); ctx.fillStyle = rgba(col, al); ctx.fill();
  ctx.fillStyle = rgba(col, 0.98 * al);
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + 7 * u, by + h / 2 + 0.5);
}

/** Calibration / lock-on scan line with a soft trailing wash. */
export function drawScan(ctx: CanvasRenderingContext2D, x: number, y0: number, y1: number, alpha: number, u: number): void {
  if (alpha <= 0.01) return;
  const g = ctx.createLinearGradient(x - 110 * u, 0, x, 0);
  g.addColorStop(0, rgba(ACCENT_RGB, 0));
  g.addColorStop(0.72, rgba(ACCENT_RGB, 0.14 * alpha));
  g.addColorStop(1, rgba(ACCENT_RGB, 0.34 * alpha));
  ctx.fillStyle = g;
  ctx.fillRect(x - 110 * u, y0, 110 * u, y1 - y0);
  ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1);
  ctx.strokeStyle = rgba(ACCENT_RGB, alpha);
  ctx.lineWidth = Math.max(2, 2 * u);
  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + 1.5 * u, y0); ctx.lineTo(x + 1.5 * u, y1);
  ctx.strokeStyle = rgba(WHITE, 0.5 * alpha);
  ctx.lineWidth = Math.max(1, 1 * u);
  ctx.stroke();
  for (const yy of [y0, y1]) {
    ctx.beginPath(); ctx.arc(x, yy, 3 * u, 0, TAU); ctx.fillStyle = rgba(WHITE, alpha); ctx.fill();
  }
}

/** Branded wipe into and out of REPLAY. p 0..1, entering true when state -> REPLAY. */
export function drawReplayWipe(
  ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, p: number,
  entering: boolean, kitA: RGB, kitB: RGB, u: number,
): void {
  const k = clamp(p, 0, 1);
  const peak = Math.sin(k * Math.PI);
  if (peak <= 0.01) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();

  // A dark veil covers the cut; a slanted lime/team band sweeps across it.
  ctx.fillStyle = `rgba(3,7,11,${(0.94 * Math.pow(peak, 0.72)).toFixed(3)})`;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  const sweep = entering ? k : 1 - k;
  const x = r.x - r.w * 0.18 + sweep * r.w * 1.32;
  const slant = r.h * 0.34;
  // team-colour trailing edge
  for (const [col, off, alpha] of [[kitA, 0.09, 0.36], [kitB, 0.035, 0.3]] as [RGB, number, number][]) {
    ctx.beginPath();
    ctx.moveTo(x - off * r.w, r.y);
    ctx.lineTo(x - off * r.w - r.w * 0.022, r.y);
    ctx.lineTo(x - off * r.w - r.w * 0.022 - slant, r.y + r.h);
    ctx.lineTo(x - off * r.w - slant, r.y + r.h);
    ctx.closePath();
    ctx.fillStyle = rgba(col, peak * alpha);
    ctx.fill();
  }
  // the lime leading band, with a soft wash behind it
  const wash = ctx.createLinearGradient(x - r.w * 0.2, 0, x, 0);
  wash.addColorStop(0, 'rgba(215,255,62,0)');
  wash.addColorStop(0.82, 'rgba(215,255,62,0.10)');
  wash.addColorStop(1, 'rgba(215,255,62,0.3)');
  ctx.fillStyle = wash;
  ctx.beginPath();
  ctx.moveTo(x - r.w * 0.2, r.y);
  ctx.lineTo(x, r.y);
  ctx.lineTo(x - slant, r.y + r.h);
  ctx.lineTo(x - r.w * 0.2 - slant, r.y + r.h);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x, r.y);
  ctx.lineTo(x + 2.2 * u, r.y);
  ctx.lineTo(x + 2.2 * u - slant, r.y + r.h);
  ctx.lineTo(x - slant, r.y + r.h);
  ctx.closePath();
  ctx.fillStyle = rgba(ACCENT_RGB, 0.86 * peak);
  ctx.fill();

  const textA = clamp((peak - 0.18) / 0.55, 0, 1);
  if (textA > 0.01) {
    const cx = r.x + r.w * 0.5, cy = r.y + r.h * 0.52;
    ctx.globalAlpha = textA;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center';
    // top rule + kicker
    ctx.fillStyle = 'rgba(215,255,62,0.95)';
    ctx.fillRect(cx - r.w * 0.31, cy - r.h * 0.21, r.w * 0.62, Math.max(1, 0.16 * u));
    ctx.font = font(Math.min(r.h * 0.023, 18 * u), 700);
    ctx.fillStyle = 'rgba(215,255,62,0.92)';
    ctx.fillText('TACTICLENS  /  MULTI-ANGLE', cx, cy - r.h * 0.155);
    // hero word
    ctx.font = font(Math.min(r.h * 0.2, r.w * 0.115), 700, true);
    ctx.fillStyle = rgba(WHITE, 1);
    ctx.fillText('REPLAY', cx, cy + r.h * 0.085);
    ctx.font = font(Math.min(r.h * 0.024, 18 * u), 500);
    ctx.fillStyle = 'rgba(247,249,251,0.55)';
    ctx.fillText('THE SEQUENCE, FRAME BY FRAME', cx, cy + r.h * 0.145);
    // bottom team ticks
    const ty = cy + r.h * 0.2;
    ctx.fillStyle = rgba(kitA, 0.85); ctx.fillRect(cx - r.w * 0.31, ty, r.w * 0.095, Math.max(1, 0.17 * u));
    ctx.fillStyle = rgba(ACCENT_RGB, 0.95); ctx.fillRect(cx - r.w * 0.205, ty, r.w * 0.052, Math.max(1, 0.17 * u));
    ctx.fillStyle = rgba(kitB, 0.85); ctx.fillRect(cx - r.w * 0.143, ty, r.w * 0.095, Math.max(1, 0.17 * u));
    ctx.textAlign = 'left';
  }
  ctx.restore();
}

/** Freeze-frame treatment: slight vignette, corner brackets, a hairline still-frame border. */
export function drawFreeze(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, alpha: number, u: number): void {
  if (alpha <= 0.01) return;
  const g = ctx.createRadialGradient(r.x + r.w / 2, r.y + r.h / 2, r.w * 0.2, r.x + r.w / 2, r.y + r.h / 2, r.w * 0.72);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.78, `rgba(0,0,0,${0.1 * alpha})`);
  g.addColorStop(1, `rgba(0,0,0,${0.3 * alpha})`);
  ctx.fillStyle = g;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = `rgba(215,255,62,${0.16 * alpha})`;
  ctx.lineWidth = 1;
  ctx.strokeRect(r.x + 6 * u, r.y + 6 * u, r.w - 12 * u, r.h - 12 * u);
  const c = 16 * u;
  ctx.strokeStyle = `rgba(215,255,62,${0.7 * alpha})`;
  ctx.lineWidth = 2 * u;
  ctx.beginPath();
  const L = r.x + 6 * u, T = r.y + 6 * u, R = r.x + r.w - 6 * u, B = r.y + r.h - 6 * u;
  ctx.moveTo(L, T + c); ctx.lineTo(L, T); ctx.lineTo(L + c, T);
  ctx.moveTo(R - c, T); ctx.lineTo(R, T); ctx.lineTo(R, T + c);
  ctx.moveTo(R, B - c); ctx.lineTo(R, B); ctx.lineTo(R - c, B);
  ctx.moveTo(L + c, B); ctx.lineTo(L, B); ctx.lineTo(L, B - c);
  ctx.stroke();
}

/** Distance tag helper used by marking links and tests. */
export function distanceLabel(metres: number): string {
  return `~${Math.max(2, Math.round(metres))} m`;
}

export const NEUTRAL_RGB: RGB = NEUTRAL;
export const INK_RGB = INK;
