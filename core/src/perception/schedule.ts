import type { BallState, QualityLevel, SceneKind } from '../types';

export type BallPlan =
  | { mode: 'none'; skipped?: boolean }   // skipped: a healthy, visible ball's scheduled gap (not a miss)
  | { mode: 'crop'; xy: [number, number]; why: 'track' | 'hint' | 'smart' }   // normalised centre
  | { mode: 'full' };

export interface BallPlanCtx {
  state: BallState;
  quality: QualityLevel;
  scene: SceneKind;
  predicted: [number, number] | null;  // Kalman prediction, normalised
  hint: [number, number] | null;       // ball reported by the players model this frame
  smart: [number, number] | null;      // last carrier, else densest player cluster
}

/**
 * Chooses which ball pass to run this cycle: crop 640 at the predicted position while
 * tracking, smart crop / 1280 full frame every Nth cycle while searching or absent. Pure; the brain executes
 * the plan and reports the outcome with `report`.
 *
 * Rate rule (the player model runs every cycle and owns the FrameState cadence):
 *  - a visible, stable ball is sampled every other cycle at Q3 (every 3rd/4th at Q2/Q1) and the ball Kalman
 *    predicts in between, so the expensive second model never halves the player detection rate;
 *  - a searching ball (recent miss) is chased every cycle for up to `missesToSearch` cycles;
 *  - the 1280 full-frame search runs at most once every `searchEvery` cycles.
 */
export class BallScheduler {
  private cycle = 0;
  private misses = 0;
  private searchCycle = 0;
  private smartTried = false;

  constructor(private searchEvery = 5, private missesToSearch = 3) {}

  plan(c: BallPlanCtx): BallPlan {
    this.cycle++;
    if (c.quality === 0 || c.scene === 'CROWD' || c.scene === 'GRAPHIC') return { mode: 'none' };
    const everyQ = c.quality === 3 ? 2 : c.quality === 2 ? 3 : 4;
    // Only a visible ball gets the scheduled gap; a searching ball is chased every cycle until the
    // miss budget runs out. The first cycle is always sampled so a fresh plan starts with a detection.
    const gated = c.state === 'visible' && (this.cycle - 1) % everyQ !== 0;
    if (c.state === 'visible' || (c.state === 'searching' && this.misses < this.missesToSearch)) {
      if (gated) return { mode: 'none', skipped: true };
      const xy = c.predicted ?? c.hint;
      if (xy) return { mode: 'crop', xy, why: 'track' };
    }
    // Searching (misses exhausted) or absent. A hint is free (the players model reported a ball), so
    // take it every cycle; the expensive full-frame 1280 search stays on its Nth-cycle budget.
    this.searchCycle++;
    if (c.hint) return { mode: 'crop', xy: c.hint, why: 'hint' };
    if (this.searchCycle % this.searchEvery === 1 || this.searchEvery === 1) {
      if (!this.smartTried && c.smart) { this.smartTried = true; return { mode: 'crop', xy: c.smart, why: 'smart' }; }
      return c.quality === 1 ? (c.smart ? { mode: 'crop', xy: c.smart, why: 'smart' } : { mode: 'none' }) : { mode: 'full' };
    }
    return { mode: 'none' };
  }

  /** Report outcome of an executed plan. */
  report(plan: BallPlan, found: boolean): void {
    if (plan.mode === 'none') return;
    if (found) { this.misses = 0; this.smartTried = false; this.searchCycle = 0; }
    else this.misses++;
  }

  reset(): void { this.cycle = 0; this.misses = 0; this.searchCycle = 0; this.smartTried = false; }
}
