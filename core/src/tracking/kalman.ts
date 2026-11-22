/** Scalar constant-velocity Kalman filter, state [p, v]. Time-based (seconds), so it is independent of the frame rate. */
export class Kalman1D {
  p: number;
  v = 0;
  // covariance [[pp, pv],[pv, vv]]
  private pp: number;
  private pv = 0;
  private vv: number;

  constructor(p0: number, private qPos = 1e-5, private qVel = 0.05, private r = 4e-4, p0var = 4e-4, v0var = 0.25) {
    this.p = p0;
    this.pp = p0var;
    this.vv = v0var;
  }

  predict(dt: number): void {
    if (dt <= 0) return;
    this.p += this.v * dt;
    const { pp, pv, vv } = this;
    this.pp = pp + 2 * dt * pv + dt * dt * vv + this.qPos * dt;
    this.pv = pv + dt * vv;
    this.vv = vv + this.qVel * dt;
  }

  update(z: number, r = this.r): void {
    const s = this.pp + r;
    const kp = this.pp / s;
    const kv = this.pv / s;
    const y = z - this.p;
    this.p += kp * y;
    this.v += kv * y;
    const pp = this.pp, pv = this.pv;
    this.pp = (1 - kp) * pp;
    this.pv = (1 - kp) * pv;
    this.vv = this.vv - kv * pv;
  }

  /** Position at dt ahead without mutating. */
  peek(dt: number): number { return this.p + this.v * dt; }
  scaleVelocity(f: number): void { this.v *= f; }

  /**
   * Change the velocity process noise for the next predict. The tracker raises it while a player is
   * sprinting: a constant-velocity model needs more agility to catch a new velocity within two detections.
   */
  setProcessNoise(qVel: number): void { this.qVel = Math.max(0, qVel); }
}
