export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(ax - bx, ay - by);

/** Solves cubic-bezier(x1,y1,x2,y2) like CSS. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number): number => ((ay * t + by) * t + cy) * t;
  const dx = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-5) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 20; i++) {
      const e = sx(t);
      if (Math.abs(e - x) < 1e-5) break;
      if (x > e) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

/** Critically damped spring (exact step). tau = time constant in seconds. */
export interface Spring { x: number; v: number }
export function springStep(s: Spring, target: number, tau: number, dt: number): void {
  const w = 2 / Math.max(tau, 1e-3);
  const e = Math.exp(-w * dt);
  const d = s.x - target;
  const tmp = (s.v + w * d) * dt;
  s.x = target + (d + tmp) * e;
  s.v = (s.v - w * tmp) * e;
}

// ---------------------------------------------------------------------------
// One Euro filter (Casiez, Roussel & Vogel 2012). Low latency on fast movement, strong smoothing
// when the signal is slow — exactly what a 9 Hz tracker feeding a 60 fps marker needs.
// ---------------------------------------------------------------------------

export interface OneEuroOpts {
  /** Cutoff (Hz) at zero speed. Lower = calmer at rest. */
  minCutoff?: number;
  /** Speed coefficient: higher = less lag during fast runs. */
  beta?: number;
  /** Cutoff (Hz) for the derivative estimate. */
  dCutoff?: number;
}

/** Defaults for screen-space marker positions, px and seconds. */
export const ONE_EURO_DEFAULTS: Required<OneEuroOpts> = { minCutoff: 1.0, beta: 0.015, dCutoff: 1.0 };

function smoothingAlpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * Math.max(cutoff, 1e-3));
  return 1 / (1 + tau / Math.max(dt, 1e-3));
}

export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;

  constructor(o: OneEuroOpts = {}) {
    this.minCutoff = o.minCutoff ?? ONE_EURO_DEFAULTS.minCutoff;
    this.beta = o.beta ?? ONE_EURO_DEFAULTS.beta;
    this.dCutoff = o.dCutoff ?? ONE_EURO_DEFAULTS.dCutoff;
  }

  /** Start at `value` with no velocity history (new track, cut, seek). */
  reset(value: number): void { this.x = value; this.dx = 0; }

  get value(): number | null { return this.x; }

  filter(value: number, dt: number, speed = 0): number {
    if (this.x === null) { this.x = value; return value; }
    const step = Math.max(1e-3, Math.min(0.25, dt));
    const rawDx = (value - this.x) / step;
    const aD = smoothingAlpha(this.dCutoff, step);
    this.dx = aD * rawDx + (1 - aD) * this.dx;
    // `speed` is an external speed signal in the same units/s (the tracker's velocity in px/s). The
    // filter's own derivative lags during an acceleration, so the cutoff must open on the tracker's
    // estimate as well: max() takes whichever says "this point is moving fast".
    const cutoff = this.minCutoff + this.beta * Math.max(Math.abs(this.dx), Math.max(0, speed));
    const a = smoothingAlpha(cutoff, step);
    this.x = a * value + (1 - a) * this.x;
    return this.x;
  }
}

// ---------------------------------------------------------------------------
// Latency compensation. A FrameState arrives ~100-340 ms after its frame was captured, so drawing the raw
// detection position makes every ring trail its player. Each track therefore gets a constant-velocity
// prediction in *video* time plus a critically damped correction that absorbs the disagreement with each
// new detection (~80 ms). The correction is an offset, not a chase: a moving target causes no steady-state
// lag, unlike a spring that follows the moving position itself.
// ---------------------------------------------------------------------------

/** Never extrapolate further than this much video time from the last observation. */
export const EXTRAP_MAX_S = 0.4;
/**
 * Safety bound on the correction spring displacement, normalised frame units. It must be generous: the
 * correction is what keeps the drawn point continuous, and clamping it *shorter* than the real error is
 * exactly the snap this class exists to avoid. Half a frame is far beyond any plausible latency error.
 */
const CORR_MAX = 0.5;

export interface PredictOpts {
  /** Max video seconds of extrapolation (default EXTRAP_MAX_S). */
  maxGap?: number;
  /** Max |velocity| in normalised units per second of video time (default 4.5 = 4.5 frame widths/s). */
  maxVel?: number;
  /** Correction spring time constant, seconds (default 0.08). */
  tau?: number;
  /** Clamp on the estimated acceleration, normalised frame widths / s^2. 0 disables the term. */
  maxAccel?: number;
  /** Acceleration displacement may add at most this share of the constant-velocity displacement. */
  accelShare?: number;
  /** Acceleration is extrapolated for at most this many video seconds (default 0.25). */
  accelLeadMaxS?: number;
}

export interface Predicted {
  x: number;
  y: number;
  /** Video seconds extrapolated from the last observation (0 on a seek, clamped to maxGap). */
  gap: number;
  /** True when `now` is at least maxGap after the observation (prediction is frozen). */
  clamped: boolean;
}

const limit = (v: number, m: number): number => (v > m ? m : v < -m ? -m : v);

/**
 * A point observed at media times with a velocity, extrapolated to the current video time.
 *
 *  - pause: the caller's video clock stops advancing, so `gap` freezes and the point holds.
 *  - seek/rewind: a `now` before the observation gives gap 0 (never predict backwards).
 *  - 2x: `now` is video time, so a wall second of latency is two video seconds; the clamp is in video time.
 *  - pans: the observed image velocity already includes camera motion; while coasting, camera velocity that
 *    arrived after the observation is added on top ((gm - camAtObservation) * gap).
 *  - display lead: `read(..., leadS)` predicts to the frame that will actually be presented, not to
 *    video.currentTime. The engine passes one display frame scaled by playbackRate.
 *  - acceleration: when enabled, a lightly smoothed d(v)/dt adds 1/2 a t^2 for at most accelLeadMaxS,
 *    capped to a share of the velocity displacement so a noisy detector cannot fling the marker. It is
 *    zeroed on a >90 degree direction change, which is the only case that could overshoot.
 */
export class Extrapolator {
  x0 = 0;
  y0 = 0;
  t0 = 0;
  vx = 0;
  vy = 0;
  /** Estimated acceleration at the last observation (normalised / s^2), and its clamp. */
  ax = 0;
  ay = 0;
  /** Camera pan velocity at the last observation (normalised / s of video). */
  camx = 0;
  camy = 0;
  private ex: Spring = { x: 0, v: 0 };
  private ey: Spring = { x: 0, v: 0 };
  private maxVel: number;
  private maxGap: number;
  private tau: number;
  private maxAccel: number;
  private accelShare: number;
  private accelLeadMaxS: number;

  constructor(o: PredictOpts = {}) {
    this.maxVel = o.maxVel ?? 4.5;
    this.maxGap = o.maxGap ?? EXTRAP_MAX_S;
    this.tau = o.tau ?? 0.08;
    this.maxAccel = o.maxAccel ?? 0;
    this.accelShare = o.accelShare ?? 0.35;
    this.accelLeadMaxS = o.accelLeadMaxS ?? 0.25;
  }

  /** Update the clamp / spring tuning at runtime (source-profile switch). */
  configure(o: PredictOpts = {}): void {
    if (o.maxVel !== undefined) this.maxVel = o.maxVel;
    if (o.maxGap !== undefined) this.maxGap = o.maxGap;
    if (o.tau !== undefined) this.tau = o.tau;
    if (o.maxAccel !== undefined) this.maxAccel = o.maxAccel;
    if (o.accelShare !== undefined) this.accelShare = o.accelShare;
    if (o.accelLeadMaxS !== undefined) this.accelLeadMaxS = o.accelLeadMaxS;
  }

  /** Start at a known position with no correction (new track, cut, seek). */
  reset(x: number, y: number, t: number, vx = 0, vy = 0, camx = 0, camy = 0): void {
    this.x0 = x; this.y0 = y; this.t0 = t;
    this.vx = limit(vx, this.maxVel); this.vy = limit(vy, this.maxVel);
    this.ax = 0; this.ay = 0;
    this.camx = camx; this.camy = camy;
    this.ex.x = 0; this.ex.v = 0;
    this.ey.x = 0; this.ey.v = 0;
  }

  /**
   * Apply a detection taken at media time `t`, at the current video time `now`, without moving the point that
   * is already on screen. `vx/vy` is the tracker velocity at `t`, `cam*` the camera pan velocity of the same
   * snapshot. Returns false for a duplicate/stale frame (nothing changed).
   */
  observe(x: number, y: number, t: number, vx: number, vy: number, camx: number, camy: number, now: number): boolean {
    const dt = t - this.t0;
    if (dt < -0.05) { this.reset(x, y, t, vx, vy, camx, camy); return true; }   // seek/rewind
    if (dt <= 1e-3) return false;                     // same frame (or reordered): ignore
    if (dt > 1) { this.reset(x, y, t, vx, vy, camx, camy); return true; }      // long stall: don't blend

    // Blend the filtered tracker velocity with the raw observation velocity: the filter is stable but lags,
    // the raw difference is responsive but noisy. A long gap (>0.75 s) keeps the tracker velocity alone.
    let nx = limit(vx, this.maxVel), ny = limit(vy, this.maxVel);
    if (dt <= 0.75) {
      const rawX = (x - this.x0) / dt, rawY = (y - this.y0) / dt;
      if (Math.abs(rawX) <= this.maxVel * 1.5 && Math.abs(rawY) <= this.maxVel * 1.5) {
        nx = limit(0.5 * nx + 0.5 * rawX, this.maxVel);
        ny = limit(0.5 * ny + 0.5 * rawY, this.maxVel);
      }
    }

    // Keep the drawn position continuous at the moment the snapshot is applied.
    const gOld = clamp(now - this.t0, 0, this.maxGap);
    const oldX = this.x0 + this.vx * gOld + this.ex.x;
    const oldY = this.y0 + this.vy * gOld + this.ey.x;
    // Acceleration estimate from successive observation velocities. A sharp direction change (>90 deg)
    // zeroes it: adding the old acceleration after a cut would push the marker past the new path.
    if (this.maxAccel > 0 && dt >= 0.02 && dt <= 0.5) {
      if (nx * this.vx + ny * this.vy < 0) {
        this.ax = 0; this.ay = 0;
      } else {
        const axRaw = limit((nx - this.vx) / dt, this.maxAccel);
        const ayRaw = limit((ny - this.vy) / dt, this.maxAccel);
        this.ax = 0.5 * this.ax + 0.5 * axRaw;
        this.ay = 0.5 * this.ay + 0.5 * ayRaw;
      }
    } else {
      this.ax = 0; this.ay = 0;
    }
    this.x0 = x; this.y0 = y; this.t0 = t;
    this.vx = nx; this.vy = ny;
    this.camx = camx; this.camy = camy;
    const gNew = clamp(now - t, 0, this.maxGap);
    this.ex.x = limit(oldX - (x + nx * gNew), CORR_MAX);
    this.ey.x = limit(oldY - (y + ny * gNew), CORR_MAX);
    return true;
  }

  /**
   * Advance the correction spring and return the position at video time `now`, optionally `leadS`
   * seconds further ahead (the frame that will actually be presented).
   */
  read(now: number, dt: number, gmX = 0, gmY = 0, leadS = 0): Predicted {
    springStep(this.ex, 0, this.tau, dt);
    springStep(this.ey, 0, this.tau, dt);
    const raw = now + Math.max(0, leadS) - this.t0;
    const gap = clamp(raw, 0, this.maxGap);
    // Camera pan that arrived after the observation (coasting tracks only; zero for a fresh snapshot).
    const dxc = gap > 0 ? limit(gmX - this.camx, 3) : 0;
    const dyc = gap > 0 ? limit(gmY - this.camy, 3) : 0;
    // 1/2 a t^2, trusted for at most accelLeadMaxS, and only a fraction of the velocity displacement:
    // the term helps during a sprint start without ever being able to run away from the observation.
    let adx = 0, ady = 0;
    if (this.maxAccel > 0 && gap > 0) {
      const ga = Math.min(gap, this.accelLeadMaxS);
      adx = 0.5 * this.ax * ga * ga;
      ady = 0.5 * this.ay * ga * ga;
      const vmag = Math.hypot(this.vx, this.vy);
      const cap = this.accelShare * (vmag * gap + 0.01 * gap);
      const amag = Math.hypot(adx, ady);
      if (amag > cap && amag > 0) { adx = (adx / amag) * cap; ady = (ady / amag) * cap; }
    }
    return {
      x: this.x0 + (this.vx + dxc) * gap + this.ex.x + adx,
      y: this.y0 + (this.vy + dyc) * gap + this.ey.x + ady,
      gap,
      clamped: raw >= this.maxGap,
    };
  }
}

export interface Rect { x: number; y: number; w: number; h: number }

/** object-fit: contain mapping of a video into a container. */
export function containRect(cw: number, ch: number, vw: number, vh: number): Rect {
  if (!(vw > 0 && vh > 0) || !(cw > 0 && ch > 0)) return { x: 0, y: 0, w: cw, h: ch };
  const s = Math.min(cw / vw, ch / vh);
  const w = vw * s, h = vh * s;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

/** object-fit: cover mapping. The rect can extend past the container; callers clip. */
export function coverRect(cw: number, ch: number, vw: number, vh: number): Rect {
  if (!(vw > 0 && vh > 0) || !(cw > 0 && ch > 0)) return { x: 0, y: 0, w: cw, h: ch };
  const s = Math.max(cw / vw, ch / vh);
  const w = vw * s, h = vh * s;
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

export function fitRect(cw: number, ch: number, vw: number, vh: number, fit: 'contain' | 'cover'): Rect {
  return fit === 'cover' ? coverRect(cw, ch, vw, vh) : containRect(cw, ch, vw, vh);
}

export type RGB = [number, number, number];
export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const v = parseInt(n, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
export const mixRgb = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const rgba = (c: RGB, a: number): string =>
  `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${clamp(a, 0, 1).toFixed(3)})`;

/**
 * Raise an sRGB colour's HSL lightness while keeping its hue and saturation. Used for the marker
 * stroke: the measured kit can be a dark red that disappears into shadowed grass, but shifting the
 * hue would break the team identity. Greys (s = 0) stay grey and simply lighten.
 */
export function brightenRgb(c: RGB, amount: number, minL = 0, maxL = 1): RGB {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (d > 1e-9) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (mx === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  const base = Math.max(l, clamp(minL, 0, 1));
  const lifted = clamp(l + amount, Math.max(0, minL), Math.min(1, maxL));
  const L = Math.max(base, lifted);   // brighten only: never darken a near-white kit
  const ch = (1 - Math.abs(2 * L - 1)) * s;
  const x = ch * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = L - ch / 2;
  let rr = 0, gg = 0, bb = 0;
  if (h < 60) { rr = ch; gg = x; }
  else if (h < 120) { rr = x; gg = ch; }
  else if (h < 180) { gg = ch; bb = x; }
  else if (h < 240) { gg = x; bb = ch; }
  else if (h < 300) { rr = x; bb = ch; }
  else { rr = ch; bb = x; }
  return [Math.round((rr + m) * 255), Math.round((gg + m) * 255), Math.round((bb + m) * 255)];
}

/** Andrew monotone chain. */
export function convexHull(pts: [number, number][]): [number, number][] {
  if (pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0) lo.pop();
    lo.push(q);
  }
  const up: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (up.length >= 2 && cross(up[up.length - 2]!, up[up.length - 1]!, q) <= 0) up.pop();
    up.push(q);
  }
  lo.pop(); up.pop();
  return lo.concat(up);
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
