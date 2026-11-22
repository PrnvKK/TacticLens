// Hysteresis gate: hidden -> shown needs confidence >= 0.75 continuously for 0.6 s;
// shown -> held when < 0.75 (>= 0.6); anything -> hidden when < 0.6. Video time, seconds.
import type { Gate } from '../types';

export class HysteresisGate {
  state: Gate = 'hidden';
  toggles = 0;
  private since = -1;
  constructor(readonly hi = 0.75, readonly lo = 0.6, readonly holdS = 0.6) {}

  update(conf: number, t: number): Gate {
    const prev = this.state;
    if (conf < this.lo) { this.state = 'hidden'; this.since = -1; }
    else if (conf >= this.hi) {
      if (this.state === 'hidden') {
        if (this.since < 0) this.since = t;
        if (t - this.since >= this.holdS) this.state = 'shown';
      } else this.state = 'shown';
    } else {
      this.since = -1;
      if (this.state === 'shown') this.state = 'held';
    }
    if (this.state !== prev) this.toggles++;
    return this.state;
  }
  reset(): void { if (this.state !== 'hidden') this.toggles++; this.state = 'hidden'; this.since = -1; }
}
