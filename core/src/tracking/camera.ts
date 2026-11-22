// Camera-motion compensation for the player tracker: sparse Lucas-Kanade flow on a small greyscale frame,
// masked over the player boxes, then a RANSAC similarity fit. Pure TS and DOM-free: callers pass a grey
// pixel array (typically 320x180) and normalised player boxes.
//
// The tracker uses the returned 2x3 matrix to warp its predicted boxes into the current frame before
// association, so a pan moves every box with the picture instead of breaking IoU one player at a time.
//
// Performance (the brain has a ~176 ms cycle budget, and this used to take ~34 ms per frame in Node):
//   - a coarse corner scan (stride 2) over precomputed gradients, a small top-K heap instead of sorting
//     every pixel, 60 corners, 2 pyramid levels and 5 LK iterations;
//   - CameraFlow reuses the corner set for a few frames (LK moves each corner into the new frame) and
//     recycles every pyramid / scratch array, so a steady cycle allocates nothing.
// `estimateCameraMotion` keeps the old one-shot API for tests and callers that do not need reuse.

/** Greyscale pixels, row-major, `width * height` values (0..255 or 0..1; both work). */
export interface GreyFrame {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export type Box4 = [number, number, number, number];

/** Similarity transform in normalised frame coordinates: [a, -b, tx, b, a, ty]. */
export interface CameraMotion {
  /** Translation of the frame centre, normalised frame units (matches FrameState.globalMotion). */
  dx: number;
  dy: number;
  scale: number;
  rotation: number;          // radians
  inliers: number;
  total: number;             // tracked point pairs
  confidence: number;        // inliers / total, 0 when rejected
  matrix: [number, number, number, number, number, number];
}

export interface CameraFlowOpts {
  maxCorners: number;        // default 60
  minDistance: number;       // NMS radius in pixels, default 4
  winRadius: number;         // LK patch radius, default 3 (7x7)
  levels: number;            // pyramid levels, default 2
  iterations: number;        // LK iterations per level, default 5
  ransacIters: number;       // default 120
  inlierPx: number;          // residual threshold in pixels, default 2
  minInlierRatio: number;    // reject below this, default 0.5
  minPairs: number;          // default 8
  maxShiftFrac: number;      // reject points moving more than this * min(w,h), default 0.3
  /** Corner scan stride in pixels (default 2) and corner re-detection period in frames (default 5). */
  detectStep: number;
  detectEvery: number;
}

export const DEFAULT_CAMERA_FLOW: CameraFlowOpts = {
  maxCorners: 60, minDistance: 4, winRadius: 3, levels: 2, iterations: 5,
  ransacIters: 120, inlierPx: 2, minInlierRatio: 0.5, minPairs: 8, maxShiftFrac: 0.3,
  detectStep: 2, detectEvery: 5,
};

interface Pyr { data: Float32Array; w: number; h: number }
interface Pair { px: number; py: number; qx: number; qy: number }
interface Sim { a: number; b: number; tx: number; ty: number }
interface Scratch { gx: Float32Array; gy: Float32Array; heapX: Int32Array; heapY: Int32Array; heapS: Float32Array }

function halve(src: Pyr, out?: Pyr): Pyr {
  const w = Math.max(1, src.w >> 1), h = Math.max(1, src.h >> 1);
  const data = out && out.data.length === w * h ? out.data : new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.min(src.h - 1, y * 2), y1 = Math.min(src.h - 1, y * 2 + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(src.w - 1, x * 2), x1 = Math.min(src.w - 1, x * 2 + 1);
      data[y * w + x] = 0.25 * (src.data[y0 * src.w + x0]! + src.data[y0 * src.w + x1]! +
        src.data[y1 * src.w + x0]! + src.data[y1 * src.w + x1]!);
    }
  }
  if (out) { out.w = w; out.h = h; return out; }
  return { data, w, h };
}

/** Build (or refill) a pyramid in `dst`; returns the number of levels actually used. */
function buildPyr(img: GreyFrame, levels: number, dst: Pyr[]): number {
  const n = img.width * img.height;
  let l0 = dst[0];
  if (!l0 || l0.data.length !== n) { l0 = { data: new Float32Array(n), w: img.width, h: img.height }; dst[0] = l0; }
  l0.w = img.width; l0.h = img.height;
  const src = img.data;
  const d = l0.data;
  for (let i = 0; i < n; i++) d[i] = src[i]!;
  let used = 1;
  for (let l = 1; l < Math.max(1, levels); l++) {
    const prev = dst[used - 1]!;
    if (prev.w < 24 || prev.h < 16) break;
    dst[used] = halve(prev, dst[used]);
    used++;
  }
  dst.length = used;
  return used;
}

function sample(p: Pyr, x: number, y: number): number {
  if (x < 0 || y < 0 || x > p.w - 1 || y > p.h - 1) return NaN;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(p.w - 1, x0 + 1), y1 = Math.min(p.h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const a = p.data[y0 * p.w + x0]!, b = p.data[y0 * p.w + x1]!;
  const c = p.data[y1 * p.w + x0]!, d = p.data[y1 * p.w + x1]!;
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** Pixels whose centre lies in any masked box (boxes normalised, expanded by a small margin). */
function maskOf(boxes: Box4[], w: number, h: number, margin = 0.08): { x0: number; y0: number; x1: number; y1: number }[] {
  return boxes.map((b) => {
    const mx = (b[2] - b[0]) * margin, my = (b[3] - b[1]) * margin;
    return {
      x0: Math.max(0, Math.floor((b[0] - mx) * w)), y0: Math.max(0, Math.floor((b[1] - my) * h)),
      x1: Math.min(w - 1, Math.ceil((b[2] + mx) * w)), y1: Math.min(h - 1, Math.ceil((b[3] + my) * h)),
    };
  });
}

function masked(m: { x0: number; y0: number; x1: number; y1: number }[], x: number, y: number): boolean {
  for (const r of m) if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return true;
  return false;
}

/** Top-K min-heap push (K = heap arrays' length). */
function heapPush(hx: Int32Array, hy: Int32Array, hs: Float32Array, count: number, x: number, y: number, s: number): number {
  const k = hs.length;
  if (count < k) {
    let i = count++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hs[p]! <= s) break;
      hx[i] = hx[p]!; hy[i] = hy[p]!; hs[i] = hs[p]!;
      i = p;
    }
    hx[i] = x; hy[i] = y; hs[i] = s;
    return count;
  }
  if (s <= hs[0]!) return count;
  // replace the root and sift down
  let i = 0;
  for (;;) {
    const l = i * 2 + 1, r = l + 1;
    let m = i, ms = s;
    if (l < k && hs[l]! < ms) { m = l; ms = hs[l]!; }
    if (r < k && hs[r]! < ms) { m = r; ms = hs[r]!; }
    if (m === i) break;
    hx[i] = hx[m]!; hy[i] = hy[m]!; hs[i] = hs[m]!;
    i = m;
  }
  hx[i] = x; hy[i] = y; hs[i] = s;
  return count;
}

function makeScratch(n: number, k: number, old?: Scratch): Scratch {
  if (old && old.gx.length === n && old.heapS.length === k) return old;
  return { gx: new Float32Array(n), gy: new Float32Array(n), heapX: new Int32Array(k), heapY: new Int32Array(k), heapS: new Float32Array(k) };
}

/** Shi-Tomasi corners with deterministic score-ordered NMS. Returns [x, y] pairs in full-res pixels. */
export function detectCorners(img: GreyFrame, boxes: Box4[] = [], o: CameraFlowOpts = DEFAULT_CAMERA_FLOW, scratch?: Scratch): [number, number][] {
  const { width: w, height: h } = img;
  if (w < 8 || h < 8) return [];
  const n = w * h;
  const k = Math.max(4, o.maxCorners * 4);
  const s = makeScratch(n, k, scratch);
  const { gx, gy, heapX, heapY, heapS } = s;
  const src = img.data;

  // central-difference gradients once, then reuse them in every 5x5 corner window
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = 0.5 * (src[i + 1]! - src[i - 1]!);
      gy[i] = 0.5 * (src[i + w]! - src[i - w]!);
    }
  }

  const mask = maskOf(boxes, w, h);
  const step = Math.max(1, o.detectStep);
  const R = 2;
  let count = 0;
  for (let y = R + 1; y < h - R - 1; y += step) {
    for (let x = R + 1; x < w - R - 1; x += step) {
      if (masked(mask, x, y)) continue;
      let sxx = 0, sxy = 0, syy = 0;
      for (let dy = -R; dy <= R; dy++) {
        const row = (y + dy) * w + x;
        for (let dx = -R; dx <= R; dx++) {
          const ix = gx[row + dx]!, iy = gy[row + dx]!;
          sxx += ix * ix; sxy += ix * iy; syy += iy * iy;
        }
      }
      const tr = sxx + syy, det = sxx * syy - sxy * sxy;
      const lmin = tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
      if (lmin > 1e-4) count = heapPush(heapX, heapY, heapS, count, x, y, lmin);
    }
  }
  if (!count) return [];

  // heap -> descending score order
  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => heapS[b]! - heapS[a]! || heapY[b]! - heapY[a]! || heapX[b]! - heapX[a]!);
  const out: [number, number][] = [];
  const md2 = o.minDistance * o.minDistance;
  for (const i of order) {
    const x = heapX[i]!, y = heapY[i]!;
    let ok = true;
    for (const q of out) { const dx = q[0] - x, dy = q[1] - y; if (dx * dx + dy * dy < md2) { ok = false; break; } }
    if (!ok) continue;
    out.push([x, y]);
    if (out.length >= o.maxCorners) break;
  }
  return out;
}

/** Pyramidal Lucas-Kanade displacement of one point; null when the local patch is singular. */
function lk(prev: Pyr[], cur: Pyr[], p: [number, number], o: CameraFlowOpts): [number, number] | null {
  const levels = Math.min(prev.length, cur.length);
  let gx = 0, gy = 0;
  for (let l = levels - 1; l >= 0; l--) {
    const P = prev[l]!, C = cur[l]!;
    const scale = 2 ** l;
    const px = p[0] / scale, py = p[1] / scale;
    gx *= 2; gy *= 2;
    for (let it = 0; it < o.iterations; it++) {
      let a = 0, b = 0, c = 0, bx = 0, by = 0;
      let n = 0;
      for (let dy = -o.winRadius; dy <= o.winRadius; dy++) {
        for (let dx = -o.winRadius; dx <= o.winRadius; dx++) {
          const x = px + dx, y = py + dy;
          if (x < 1 || y < 1 || x >= P.w - 1 || y >= P.h - 1) continue;
          const ix = 0.5 * (sample(P, x + 1, y)! - sample(P, x - 1, y)!);
          const iy = 0.5 * (sample(P, x, y + 1)! - sample(P, x, y - 1)!);
          const q = sample(C, x + gx, y + gy);
          const pr = sample(P, x, y);
          if (!Number.isFinite(ix) || !Number.isFinite(iy) || !Number.isFinite(q) || !Number.isFinite(pr)) continue;
          const itv = q - pr;
          a += ix * ix; b += ix * iy; c += iy * iy;
          bx -= ix * itv; by -= iy * itv;
          n++;
        }
      }
      if (n < 6) return null;
      const det = a * c - b * b;
      if (Math.abs(det) < 1e-8) return null;
      let ux = (c * bx - b * by) / det;
      let uy = (a * by - b * bx) / det;
      // A pan never needs more than a few pixels per iteration at the coarsest level.
      const lim = 4;
      if (Math.abs(ux) > lim) ux = Math.sign(ux) * lim;
      if (Math.abs(uy) > lim) uy = Math.sign(uy) * lim;
      gx += ux; gy += uy;
      if (Math.abs(ux) < 0.01 && Math.abs(uy) < 0.01) break;
    }
  }
  return [gx, gy];
}

function fitSim(pairs: Pair[], ia: number, ib: number): Sim | null {
  const p1 = pairs[ia]!, p2 = pairs[ib]!;
  const bx = p1.px - p2.px, by = p1.py - p2.py;
  const ax = p1.qx - p2.qx, ay = p1.qy - p2.qy;
  const den = bx * bx + by * by;
  if (den < 1e-6) return null;
  const a = (ax * bx + ay * by) / den;
  const b = (ay * bx - ax * by) / den;
  const scale = Math.hypot(a, b);
  if (!(scale > 0.85 && scale < 1.15)) return null;
  return { a, b, tx: p1.qx - (a * p1.px - b * p1.py), ty: p1.qy - (b * p1.px + a * p1.py) };
}

function residual2(p: Pair, s: Sim): number {
  const x = s.a * p.px - s.b * p.py + s.tx;
  const y = s.b * p.px + s.a * p.py + s.ty;
  const dx = x - p.qx, dy = y - p.qy;
  return dx * dx + dy * dy;
}

function refine(pairs: Pair[], idx: number[]): Sim | null {
  let mpx = 0, mpy = 0, mqx = 0, mqy = 0;
  for (const i of idx) { const p = pairs[i]!; mpx += p.px; mpy += p.py; mqx += p.qx; mqy += p.qy; }
  const n = idx.length;
  if (!n) return null;
  mpx /= n; mpy /= n; mqx /= n; mqy /= n;
  let numA = 0, numB = 0, den = 0;
  for (const i of idx) {
    const p = pairs[i]!;
    const px = p.px - mpx, py = p.py - mpy, qx = p.qx - mqx, qy = p.qy - mqy;
    numA += qx * px + qy * py;
    numB += qy * px - qx * py;
    den += px * px + py * py;
  }
  if (den < 1e-6) return null;
  const a = numA / den, b = numB / den;
  return { a, b, tx: mqx - (a * mpx - b * mpy), ty: mqy - (b * mpx + a * mpy) };
}

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FitOut { motion: CameraMotion | null; pairs: Pair[] }

function fitMotion(pairs: Pair[], w: number, h: number, opts: CameraFlowOpts): CameraMotion | null {
  if (pairs.length < opts.minPairs) return null;
  const R = prng(0x5eed1234);
  const thr2 = opts.inlierPx * opts.inlierPx;
  let best: Sim | null = null, bestN = 0;
  for (let it = 0; it < opts.ransacIters; it++) {
    const ia = Math.floor(R() * pairs.length);
    let ib = Math.floor(R() * pairs.length);
    if (ib === ia) ib = (ib + 1) % pairs.length;
    const s = fitSim(pairs, ia, ib);
    if (!s) continue;
    let n = 0;
    for (const p of pairs) if (residual2(p, s) <= thr2) n++;
    if (n > bestN) { bestN = n; best = s; }
  }
  if (!best) return null;
  let inIdx: number[] = [];
  for (let i = 0; i < pairs.length; i++) if (residual2(pairs[i]!, best) <= thr2) inIdx.push(i);
  const refined = refine(pairs, inIdx);
  if (refined && Math.hypot(refined.a, refined.b) > 0.85 && Math.hypot(refined.a, refined.b) < 1.15) {
    best = refined;
    inIdx = [];
    for (let i = 0; i < pairs.length; i++) if (residual2(pairs[i]!, best) <= thr2) inIdx.push(i);
  }
  const inliers = inIdx.length;
  const ratio = inliers / pairs.length;
  if (inliers < Math.max(6, opts.minPairs) || ratio < opts.minInlierRatio) return null;
  const scale = Math.hypot(best.a, best.b);
  const rot = Math.atan2(best.b, best.a);
  return {
    dx: best.tx / w, dy: best.ty / h, scale, rotation: rot,
    inliers, total: pairs.length, confidence: ratio,
    matrix: [best.a, -best.b * (h / w), best.tx / w, best.b * (w / h), best.a, best.ty / h],
  };
}

/**
 * Stateful flow estimator: corners and pyramids persist across cycles. The tracked corner set is refreshed
 * every `detectEvery` frames; in between each corner is moved by its own LK displacement, so a pan does not
 * leave the patches behind. Call `reset()` on a cut/seek/new source.
 */
export class CameraFlow {
  readonly opts: CameraFlowOpts;
  private prevPyr: Pyr[] = [];
  private curPyr: Pyr[] = [];
  private corners: [number, number][] = [];
  private scratch: Scratch | undefined;
  private age = 0;
  private w = 0;
  private h = 0;

  constructor(o: Partial<CameraFlowOpts> = {}) {
    this.opts = { ...DEFAULT_CAMERA_FLOW, ...o };
  }

  reset(): void {
    this.corners = [];
    this.age = 0;
    this.w = 0;
    this.h = 0;
  }

  estimate(prev: GreyFrame, cur: GreyFrame, boxes: Box4[] = [], o: Partial<CameraFlowOpts> = {}): CameraMotion | null {
    if (!prev || !cur) return null;
    const opts: CameraFlowOpts = { ...this.opts, ...o };
    const w = prev.width, h = prev.height;
    if (w < 24 || h < 16 || cur.width !== w || cur.height !== h) return null;
    if (w !== this.w || h !== this.h) { this.corners = []; this.age = 0; this.w = w; this.h = h; }
    const pf = prev;
    const cf = cur;

    const n = w * h;
    if (!this.scratch || this.scratch.gx.length !== n) this.scratch = makeScratch(n, Math.max(4, opts.maxCorners * 4), this.scratch);

    // Detect on the previous frame; between detections the stored corners already live there (each cycle
    // moves them by their own displacement when the current frame becomes the next previous frame).
    if (!this.corners.length || this.age % Math.max(1, opts.detectEvery) === 0) {
      this.corners = detectCorners(pf, boxes, opts, this.scratch);
      if (!this.corners.length) { this.age++; return null; }
    }

    buildPyr(pf, opts.levels, this.prevPyr);
    buildPyr(cf, opts.levels, this.curPyr);

    // A cheap cycle may use fewer corners (and iterations); the rest of the set is dropped rather than left
    // behind, because a corner that is not moved forward is stale for the next pair.
    const use = this.corners.length > opts.maxCorners ? this.corners.slice(0, opts.maxCorners) : this.corners;
    const maxShift = opts.maxShiftFrac * Math.min(w, h);
    const pairs: Pair[] = [];
    for (const [px, py] of use) {
      const d = lk(this.prevPyr, this.curPyr, [px, py], opts);
      if (!d) continue;
      if (!Number.isFinite(d[0]) || !Number.isFinite(d[1])) continue;
      if (d[0] * d[0] + d[1] * d[1] > maxShift * maxShift) continue;
      pairs.push({ px, py, qx: px + d[0], qy: py + d[1] });
    }

    const motion = fitMotion(pairs, w, h, opts);
    this.age++;
    if (!motion) {
      // Nothing coherent: force a fresh detection next cycle instead of reusing drifting corners.
      this.corners = [];
      return null;
    }
    // Move the reused corners into the current frame (where they must live for the next pair).
    const next: [number, number][] = [];
    for (const p of pairs) {
      if (p.qx < 2 || p.qy < 2 || p.qx > w - 3 || p.qy > h - 3) continue;
      next.push([p.qx, p.qy]);
      if (next.length >= opts.maxCorners) break;
    }
    this.corners = next;
    return motion;
  }
}

/**
 * Estimate the global 2D similarity between two greyscale frames.
 * Returns null when too few corners are tracked or RANSAC inliers fall below minInlierRatio (default 50%).
 * One-shot: detects corners every call; use `CameraFlow` for the per-cycle path that reuses them.
 */
export function estimateCameraMotion(
  prev: GreyFrame,
  cur: GreyFrame,
  boxes: Box4[] = [],
  o: Partial<CameraFlowOpts> = {},
): CameraMotion | null {
  return new CameraFlow({ ...o, detectEvery: 1 }).estimate(prev, cur, boxes);
}

/** Apply a normalised similarity matrix to a point. */
export function warpPoint(p: [number, number], m: CameraMotion): [number, number] {
  const [a, b, tx, c, d, ty] = m.matrix;
  return [a * p[0] + b * p[1] + tx, c * p[0] + d * p[1] + ty];
}

/** Warp an axis-aligned normalised box; returns the axis-aligned bounding box of the transformed corners. */
export function warpBox(box: Box4, m: CameraMotion): Box4 {
  const pts: [number, number][] = [
    warpPoint([box[0], box[1]], m), warpPoint([box[2], box[1]], m),
    warpPoint([box[2], box[3]], m), warpPoint([box[0], box[3]], m),
  ];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  return [x0, y0, x1, y1];
}
