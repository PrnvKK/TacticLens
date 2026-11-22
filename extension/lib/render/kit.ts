// Renderer-side kit colour state: blend measured shirt colours slowly while teams settle, then lock
// them for the rest of the spell. A long loss of data (new match / recalibration) re-opens the blend.
import {
  displayKitPair, hexToRgbTuple, kitDeltaE, rgbToHex, type DisplayKits, type TeamColours,
} from '@tacticlens/core';

export interface KitTrackerOpts {
  /** Blend time constant while calibrating (seconds). */
  tauS: number;
  /** teamsCalibrated must hold this long before the colours lock. */
  lockAfterS: number;
  /** No colour data for this long re-opens calibration. */
  reopenAfterS: number;
  /** Ignore colour reports below this confidence. */
  minConfidence: number;
  /** Do not lock a pair this close in Lab (both kits near-white, a pure lighting split). */
  minRawDeltaE: number;
  /** A measured pair this far from the locked pair, held this long, re-opens calibration. */
  reopenJumpDeltaE: number;
  reopenJumpS: number;
}

export const KIT_TRACKER_OPTS: KitTrackerOpts = {
  tauS: 1.6,
  lockAfterS: 3.0,
  reopenAfterS: 10.0,
  minConfidence: 0.15,
  minRawDeltaE: 12,
  reopenJumpDeltaE: 24,
  reopenJumpS: 1.5,
};

type Rgb = [number, number, number];

export class KitColourTracker {
  readonly o: KitTrackerOpts;
  private cur: { A: Rgb; B: Rgb } | null = null;
  private locked = false;
  private calibSince: number | null = null;
  private lastRawAt = 0;
  private lastAt = 0;
  private last: DisplayKits | null = null;
  /** Raw pair that was locked, for detecting a real colour change later. */
  private lockRaw: { A: string; B: string } | null = null;
  /** When the measured pair first disagreed strongly with lockRaw. */
  private jumpSince: number | null = null;

  constructor(o: Partial<KitTrackerOpts> = {}) { this.o = { ...KIT_TRACKER_OPTS, ...o }; }

  get isLocked(): boolean { return this.locked; }
  get current(): DisplayKits | null { return this.last; }

  update(raw: TeamColours | undefined, calibrated: boolean, now: number): DisplayKits | null {
    const dt = this.lastAt ? Math.max(0.001, Math.min(1, now - this.lastAt)) : 0.1;
    this.lastAt = now;

    if (raw && raw.confidence >= this.o.minConfidence) {
      this.lastRawAt = now;
      if (this.locked) {
        // A real kit change (swap, new clip, a wildly wrong first fit) must not stay frozen for the
        // whole match. Require the new measurement to persist, so one bad frame cannot flip a team.
        const changed = this.lockRaw && kitDeltaE(this.lockRaw.A, raw.A) >= this.o.reopenJumpDeltaE;
        if (changed) {
          this.jumpSince ??= now;
          if (now - this.jumpSince >= this.o.reopenJumpS) {
            this.locked = false; this.calibSince = null; this.cur = null; this.last = null; this.lockRaw = null; this.jumpSince = null;
          } else return this.last;
        } else this.jumpSince = null;
        if (this.locked) return this.last;                 // frozen until a long data break or a real change
      }
      const next = { A: hexToRgbTuple(raw.A), B: hexToRgbTuple(raw.B) };
      if (!this.cur) this.cur = next;
      else {
        const k = 1 - Math.exp(-dt / this.o.tauS);
        const blend = (a: Rgb, b: Rgb): Rgb => [
          a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k,
        ];
        this.cur = { A: blend(this.cur.A, next.A), B: blend(this.cur.B, next.B) };
      }
      // Only lock when the two measured kits are actually different. A white/white split (one team
      // by sun and shadow) stays open for a later frame that finds the real second kit.
      const distinct = kitDeltaE(raw.A, raw.B) >= this.o.minRawDeltaE;
      if (calibrated && distinct) {
        this.calibSince ??= now;
        if (now - this.calibSince >= this.o.lockAfterS) {
          this.locked = true;
          this.lockRaw = { A: raw.A, B: raw.B };
        }
      } else this.calibSince = null;
      this.last = displayKitPair(rgbToHex(...this.cur.A), rgbToHex(...this.cur.B));
      return this.last;
    }

    if (this.cur && now - this.lastRawAt > this.o.reopenAfterS) {
      this.cur = null; this.last = null; this.locked = false; this.calibSince = null;
      this.lockRaw = null; this.jumpSince = null;
    }
    return this.last;
  }

  reset(): void {
    this.cur = null; this.locked = false; this.calibSince = null;
    this.lastRawAt = 0; this.lastAt = 0; this.last = null;
    this.lockRaw = null; this.jumpSince = null;
  }
}
