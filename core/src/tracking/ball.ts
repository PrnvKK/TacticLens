import type { BallState } from '../types';
import { Kalman1D } from './kalman';

export interface BallCandidate { xy: [number, number]; score: number }
export interface BallOut {
  xy: [number, number] | null;
  visibility: number;
  coastingS: number;
  state: BallState;
}
export interface BallOpts {
  absentAfterS: number;   // coast duration
  gate: number;           // normalised distance a detection may jump while tracking
  maxSpeed: number;       // normalised units/s; the gate grows with it
  confirmDist: number;    // two off-gate detections this close confirm a jump
}

/**
 * Ball tracker: own 4-state Kalman (x, y, vx, vy as two Kalman1D) and three states.
 * visible = detected this frame; searching = no detection for < absentAfterS (Kalman coasts, velocity decays);
 * absent = >= absentAfterS (xy null) until the next confirmed detection.
 * A detection that jumps outside the gate is held as a candidate and accepted only when a second nearby one confirms it.
 */
export class BallTracker {
  private kx: Kalman1D | null = null;
  private ky: Kalman1D | null = null;
  private lastSeen = -Infinity;
  private lastT = -Infinity;
  private cand: { xy: [number, number]; t: number } | null = null;
  state: BallState = 'absent';
  readonly o: BallOpts;

  constructor(o: Partial<BallOpts> = {}) {
    this.o = { absentAfterS: 1.0, gate: 0.06, maxSpeed: 1.2, confirmDist: 0.05, ...o };
  }

  /**
   * Advance between scheduled observation frames. The brain deliberately skips the ball model every
   * other cycle while the ball is visible; that is not a miss, so this predicts the Kalman (with the
   * same coast damping) and keeps the ball state/visibility. A real search miss uses `update`.
   */
  advance(t: number): BallOut {
    const dt = Number.isFinite(this.lastT) ? Math.max(0, t - this.lastT) : 0;
    if (this.kx && this.ky) {
      this.kx.predict(dt); this.ky.predict(dt);
      if (t - this.lastSeen > 0.15) {
        const decay = Math.exp(-dt * 3);
        this.kx.scaleVelocity(decay); this.ky.scaleVelocity(decay);
      }
    }
    this.lastT = t;
    const coast = t - this.lastSeen;
    if (!this.kx || !this.ky || !Number.isFinite(coast) || coast >= this.o.absentAfterS) {
      this.state = 'absent';
      return { xy: null, visibility: 0, coastingS: Number.isFinite(coast) ? coast : 0, state: 'absent' };
    }
    // Keep "visible" for the first few scheduled skips (~3 cycles); after that the ball is genuinely stale.
    this.state = this.state === 'visible' && coast < 0.35 ? 'visible' : 'searching';
    return {
      xy: [this.kx.p, this.ky.p],
      visibility: Math.max(0, 1 - coast / this.o.absentAfterS),
      coastingS: coast,
      state: this.state,
    };
  }

  reset(): void { this.kx = this.ky = null; this.lastSeen = -Infinity; this.cand = null; this.state = 'absent'; }

  /** Predicted position at time t (no mutation), or null when absent. */
  predict(t: number): [number, number] | null {
    if (!this.kx || !this.ky || this.state === 'absent') return null;
    const dt = Math.max(0, t - this.lastT);
    return [this.kx.peek(dt), this.ky.peek(dt)];
  }

  update(t: number, cands: BallCandidate[], cut = false): BallOut {
    if (cut) this.reset();
    const dt = Number.isFinite(this.lastT) ? Math.max(0, t - this.lastT) : 0;
    if (this.kx && this.ky) {
      this.kx.predict(dt); this.ky.predict(dt);
      if (t - this.lastSeen > 0.15) {
        const decay = Math.exp(-dt * 3);   // damp velocity while coasting
        this.kx.scaleVelocity(decay); this.ky.scaleVelocity(decay);
      }
    }
    this.lastT = t;

    const pred: [number, number] | null = this.kx && this.ky && this.state !== 'absent' ? [this.kx.p, this.ky.p] : null;
    let pick: BallCandidate | null = null;
    for (const c of cands) {
      const d = pred ? Math.hypot(c.xy[0] - pred[0], c.xy[1] - pred[1]) : 0;
      const v = c.score / (1 + 8 * d);   // score discounted by distance to prediction
      if (!pick || v > pick.score / (1 + 8 * (pred ? Math.hypot(pick.xy[0] - pred[0], pick.xy[1] - pred[1]) : 0))) pick = c;
    }

    let accepted = false;
    if (pick) {
      if (!pred) accepted = true;
      else {
        const gate = this.o.gate + this.o.maxSpeed * Math.max(dt, 0.05) * 0.5 + 0.02 * (t - this.lastSeen);
        const d = Math.hypot(pick.xy[0] - pred[0], pick.xy[1] - pred[1]);
        if (d <= gate) accepted = true;
        else if (this.cand && t - this.cand.t < 1 && Math.hypot(pick.xy[0] - this.cand.xy[0], pick.xy[1] - this.cand.xy[1]) < this.o.confirmDist) {
          accepted = true;                 // two nearby detections away from the track: the ball jumped
          this.kx = this.ky = null;
        } else this.cand = { xy: pick.xy, t };
      }
    }

    if (accepted && pick) {
      if (!this.kx || !this.ky) {
        this.kx = new Kalman1D(pick.xy[0], 1e-4, 1.0, 2e-4, 1e-4, 0.5);
        this.ky = new Kalman1D(pick.xy[1], 1e-4, 1.0, 2e-4, 1e-4, 0.5);
      } else { this.kx.update(pick.xy[0]); this.ky.update(pick.xy[1]); }
      this.lastSeen = t;
      this.cand = null;
      this.state = 'visible';
      return { xy: [this.kx.p, this.ky.p], visibility: 1, coastingS: 0, state: 'visible' };
    }

    const coast = t - this.lastSeen;
    if (!this.kx || !this.ky || !Number.isFinite(coast) || coast >= this.o.absentAfterS) {
      this.state = 'absent';
      return { xy: null, visibility: 0, coastingS: Number.isFinite(coast) ? coast : 0, state: 'absent' };
    }
    this.state = 'searching';
    return {
      xy: [this.kx.p, this.ky.p],
      visibility: Math.max(0, 1 - coast / this.o.absentAfterS),
      coastingS: coast,
      state: 'searching',
    };
  }
}
