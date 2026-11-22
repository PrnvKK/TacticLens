// Possession FSM. States A, B, CONTESTED, DEAD.
// A team gains possession after holding the nearest-to-ball position within radius R for >= holdS (0.5 s).
// Time with no ball (absent), or outside LIVE, is credited to nobody (DEAD) and is never back-filled.
import type { Track } from '../types';
import { nearest, type Pt } from './geometry';

export type PState = 'A' | 'B' | 'CONTESTED' | 'DEAD';
export interface PossessionOpts {
  holdS: number;        // new holder must be nearest within R this long
  carrierHoldS: number; // new carrier (same team) must be nearest this long
  looseS: number;       // no-one near the ball (or contested) this long -> CONTESTED, credit stops
  radiusH: number;      // R in median body heights
  contestRatio: number; // an opponent within ratio * nearest distance makes the ball contested
}
export const DEFAULT_POSSESSION: PossessionOpts = { holdS: 0.5, carrierHoldS: 0.3, looseS: 1.5, radiusH: 1.1, contestRatio: 1.35 };

export interface PossessionStep {
  turnover?: { to: 'A' | 'B'; from: 'A' | 'B'; carrierId: number };
  pass?: { team: 'A' | 'B'; from: number; to: number };
  spellDone?: { team: 'A' | 'B'; seconds: number };   // spell crossed 8 s (emitted once)
  acquired?: { team: 'A' | 'B'; carrierId: number };  // first confirmed holder after DEAD
}

export class PossessionFSM {
  state: PState = 'DEAD';
  credited = { A: 0, B: 0 };
  spellS = 0;
  carrierId: number | null = null;
  lastHolder: 'A' | 'B' | null = null;   // survives CONTESTED, cleared by a gap so a gap can never produce a turnover
  readonly o: PossessionOpts;
  private cand: { team: 'A' | 'B'; id: number; s: number } | null = null;
  private carrierCand: { id: number; s: number } | null = null;
  private looseT = 0;
  private spellFired = false;

  constructor(o: Partial<PossessionOpts> = {}) { this.o = { ...DEFAULT_POSSESSION, ...o }; }

  /** Ball absent, camera cut, replay, close-up: credit nobody, forget the carrier, no turnover across the gap. */
  gap(): void {
    this.state = 'DEAD'; this.cand = null; this.carrierCand = null; this.carrierId = null;
    this.lastHolder = null; this.looseT = 0; this.spellS = 0; this.spellFired = false;
  }

  /** `players`: team A/B players in shot. `ball`: screen position (null = absent). `H`: median body height. */
  update(dt: number, ball: Pt | null, players: Track[], H: number): PossessionStep {
    const step: PossessionStep = {};
    if (!ball || !players.length) { this.gap(); return step; }
    const o = this.o;
    const R = o.radiusH * H;
    const n1 = nearest(ball, players);
    const inR = n1 && n1.d <= R ? n1 : null;
    let contested = false;
    if (inR) {
      const opp = nearest(ball, players.filter((p) => p.team !== inR.track.team));
      contested = !!opp && opp.d <= R && opp.d < inR.d * o.contestRatio && opp.d - inR.d < 0.35 * H;
    }
    if (!inR || contested) {
      this.cand = null; this.carrierCand = null;
      this.looseT += dt;
      if (this.looseT >= o.looseS && (this.state === 'A' || this.state === 'B')) { this.state = 'CONTESTED'; this.spellS = 0; this.spellFired = false; }
    } else {
      this.looseT = 0;
      const team = inR.track.team as 'A' | 'B', id = inR.track.id;
      if (this.state === team) {
        this.cand = null;
        if (id !== this.carrierId) {
          this.carrierCand = this.carrierCand && this.carrierCand.id === id ? { id, s: this.carrierCand.s + dt } : { id, s: dt };
          if (this.carrierCand.s >= o.carrierHoldS) {
            if (this.carrierId !== null) step.pass = { team, from: this.carrierId, to: id };
            this.carrierId = id; this.carrierCand = null;
          }
        } else this.carrierCand = null;
      } else {
        this.cand = this.cand && this.cand.team === team ? { team, id, s: this.cand.s + dt } : { team, id, s: dt };
        if (this.cand.s >= o.holdS) {
          const prev = this.lastHolder;
          this.state = team; this.carrierId = id; this.carrierCand = null; this.cand = null;
          this.spellS = 0; this.spellFired = false; this.lastHolder = team;
          if (prev && prev !== team) step.turnover = { to: team, from: prev, carrierId: id };
          else step.acquired = { team, carrierId: id };
        }
      }
    }
    if (this.state === 'A' || this.state === 'B') {
      this.credited[this.state] += dt;
      this.spellS += dt;
      if (!this.spellFired && this.spellS > 8) { this.spellFired = true; step.spellDone = { team: this.state, seconds: this.spellS }; }
    }
    return step;
  }

  /** Possession percentages 0..100 over credited time; 50/50 before any credit. */
  percent(): { A: number; B: number } {
    const tot = this.credited.A + this.credited.B;
    if (tot <= 0) return { A: 50, B: 50 };
    return { A: (100 * this.credited.A) / tot, B: (100 * this.credited.B) / tot };
  }
}

