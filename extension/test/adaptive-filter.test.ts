import { describe, expect, it } from 'vitest';
import { Extrapolator, OneEuroFilter } from '../lib/render/math';
import { MARKER } from '../lib/render/tokens';

const FPS = 60;
const DET_HZ = 9;
const LATENCY = 0.18;          // seconds from capture to FrameState
const PX_PER_M = 100;          // a tight follow shot (19 m wide on a 1920 px frame): 8 m/s = 800 px/s
const SPRINT = 8 * PX_PER_M;   // 800 px/s
const REST_X = 960;
const REST_Y = 800;
const T0 = 1.5;                // sprint starts
const TURN = 2.5;              // 90-degree cut

type Pt = { x: number; y: number };

/** Ground truth: rest, then an 8 m/s sprint, then a 90-degree cut up-field. */
function truth(t: number): Pt & { vx: number; vy: number } {
  if (t < T0) return { x: REST_X, y: REST_Y, vx: 0, vy: 0 };
  if (t < TURN) return { x: REST_X + SPRINT * (t - T0), y: REST_Y, vx: SPRINT, vy: 0 };
  return { x: REST_X + SPRINT * (TURN - T0), y: REST_Y - SPRINT * (t - TURN), vx: 0, vy: -SPRINT };
}

interface ChainOpts {
  /** One Euro beta (old 0.015, new MARKER.filter.beta). */
  beta: number;
  /** Feed the tracker velocity to the filter as well as its own derivative. */
  externalSpeed: boolean;
  /** One display frame of extrapolation lead. */
  lead: number;
  /** Drawn-point velocity cap, px/s. */
  cap: number;
  /** Enable the bounded acceleration term. */
  accel: boolean;
  /** Velocity-estimate time constant (old tracker ~5 detections, new ~2). */
  velTau: number;
}

interface ChainResult {
  /** Median lag over the steady sprint (positive = drawn behind the player), ms. */
  sprintLagMs: number;
  /** Max excursion past the corner after the 90-degree cut, px. */
  cutOvershootPx: number;
}

function runChain(o: ChainOpts): ChainResult {
  const dt = 1 / FPS;
  const mo = new Extrapolator({
    maxGap: 0.4, maxVel: 4.5 * 1920,
    maxAccel: o.accel ? MARKER.motion.maxAccel * 1920 : 0,
    accelShare: MARKER.motion.accelShare,
    accelLeadMaxS: MARKER.motion.accelLeadMaxS,
  });
  const fx = new OneEuroFilter({ minCutoff: MARKER.filter.minCutoffHz, beta: o.beta, dCutoff: MARKER.filter.dCutoffHz });
  const fy = new OneEuroFilter({ minCutoff: MARKER.filter.minCutoffHz, beta: o.beta, dCutoff: MARKER.filter.dCutoffHz });
  let drawX: number | null = null, drawY: number | null = null;
  let vx = 0, vy = 0;                 // tracker velocity estimate (px/s)
  let nextDet = 0.5;
  let drawnX = 0, drawnY = 0;
  let started = false;
  const lags: number[] = [];
  let overshoot = 0;

  for (let t = 0.5; t <= 3.8; t += dt) {
    while (nextDet + LATENCY <= t + 1e-9) {
      const g = truth(nextDet);
      const dgx = g.vx, dgy = g.vy;
      const k = 1 - Math.exp(-(1 / DET_HZ) / o.velTau);
      vx += (dgx - vx) * k; vy += (dgy - vy) * k;
      const speedPx = Math.hypot(vx, vy);
      if (!started) {
        mo.reset(g.x, g.y, nextDet, vx, vy, 0, 0);
        fx.reset(g.x); fy.reset(g.y);
        drawX = g.x; drawY = g.y; started = true;
      } else {
        mo.observe(g.x, g.y, nextDet, vx, vy, 0, 0, nextDet + LATENCY);
      }
      nextDet += 1 / DET_HZ;
    }
    if (!started) continue;
    const p = mo.read(t + o.lead, dt, 0, 0);
    const speedPx = Math.hypot(vx, vy);
    const tx = fx.filter(p.x, dt, o.externalSpeed ? speedPx : 0);
    const ty = fy.filter(p.y, dt, o.externalSpeed ? speedPx : 0);
    if (drawX === null || drawY === null) { drawX = tx; drawY = ty; }
    else {
      let dx = tx - drawX, dy = ty - drawY;
      const d = Math.hypot(dx, dy), max = o.cap * dt;
      if (d > max && d > 0) { dx = (dx / d) * max; dy = (dy / d) * max; }
      drawX += dx; drawY += dy;
    }
    drawnX = drawX; drawnY = drawY;
    const g = truth(t);
    // Steady sprint: from the third sprint detection's arrival to just before the cut.
    if (t >= T0 + 3 / DET_HZ + LATENCY && t < TURN - 0.02) lags.push((g.x - drawnX) / SPRINT * 1000);
    if (t >= TURN) overshoot = Math.max(overshoot, drawnX - (REST_X + SPRINT * (TURN - T0)));
    void drawnY;
  }
  lags.sort((a, b) => a - b);
  return { sprintLagMs: lags[Math.floor(lags.length / 2)] ?? 0, cutOvershootPx: overshoot };
}

const OLD: ChainOpts = {
  beta: 0.015, externalSpeed: false, lead: 0, cap: 720, accel: false, velTau: 0.35,
};
const NEW: ChainOpts = {
  beta: MARKER.filter.beta, externalSpeed: true, lead: MARKER.motion.displayLeadS,
  cap: MARKER.motion.maxPxS, accel: true, velTau: 0.12,
};

describe('adaptive marker chain (9 Hz tracker -> 60 fps marker)', () => {
  it('smooths a still player', () => {
    const f = new OneEuroFilter(MARKER.filter);
    let rawJitter = 0, outJitter = 0, prevRaw = 500, prevOut = 500;
    for (let i = 0; i < FPS * 3; i++) {
      const raw = 500 + (i % 2 ? 5 : -5) + Math.sin(i * 0.7);
      const out = f.filter(raw, 1 / FPS, 0);
      if (i > FPS) { rawJitter += Math.abs(raw - prevRaw); outJitter += Math.abs(out - prevOut); }
      prevRaw = raw; prevOut = out;
    }
    expect(outJitter).toBeLessThan(rawJitter * 0.15);
    expect(Math.abs(f.value! - 500)).toBeLessThan(2);
  });

  it('keeps a sprint within 60 ms after three detections (old chain: much more)', () => {
    const old = runChain(OLD);
    const next = runChain(NEW);
    console.log(`marker lag: old ${old.sprintLagMs.toFixed(0)} ms, new ${next.sprintLagMs.toFixed(0)} ms`);
    expect(next.sprintLagMs).toBeLessThan(60);
    expect(next.sprintLagMs).toBeLessThan(old.sprintLagMs);
  });

  it('bounds the overshoot after a 90-degree cut', () => {
    const next = runChain(NEW);
    const old = runChain(OLD);
    console.log(`cut overshoot: old ${old.cutOvershootPx.toFixed(0)} px, new ${next.cutOvershootPx.toFixed(0)} px`);
    // The marker may run past the corner for at most a quarter second of sprint (the acceleration / lead clamp).
    expect(next.cutOvershootPx).toBeLessThan(SPRINT * 0.25);
    expect(Number.isFinite(next.cutOvershootPx)).toBe(true);
  });

  it('attributes the old lag to the cap, the filter and the velocity estimate', () => {
    const full = runChain(OLD).sprintLagMs;
    const noCap = runChain({ ...OLD, cap: MARKER.motion.maxPxS }).sprintLagMs;
    const adaptiveFilter = runChain({ ...OLD, beta: MARKER.filter.beta, externalSpeed: true }).sprintLagMs;
    const fastVelocity = runChain({ ...OLD, velTau: 0.12 }).sprintLagMs;
    const leadAccel = runChain({ ...OLD, lead: MARKER.motion.displayLeadS, accel: true }).sprintLagMs;
    const next = runChain(NEW).sprintLagMs;
    console.log(
      `lag breakdown (800 px/s, 9 Hz): old ${full.toFixed(0)} ms = cap ${(full - noCap).toFixed(0)} + `
      + `filter ${(full - adaptiveFilter).toFixed(0)} + velocity ${(full - fastVelocity).toFixed(0)}; `
      + `lead/accel -${(full - leadAccel).toFixed(0)}; new ${next.toFixed(0)} ms`,
    );
    expect(next).toBeLessThan(full);
  });
});
