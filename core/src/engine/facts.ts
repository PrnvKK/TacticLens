// Rule-computed facts for the director. Every fact carries the same contract:
// { valid, confidence, sinceS, targets }. Kimi may only cite facts; it never invents numbers.
// Pure data; no DOM, no network.
import type { MarkingPair } from './engine';

export interface Fact {
  valid: boolean;
  /** 0..1, product of the observation confidence and how well the condition is met. */
  confidence: number;
  /** Seconds the underlying condition has held (0 when it just started). */
  sinceS: number;
  /** Live track ids the graphic may point at. */
  targets: number[];
}

export interface OverloadFact extends Fact {
  team: 'A' | 'B' | null;
  attackers: number;
  defenders: number;
  /** Attacker ids first, then defender ids. */
  near: number[];
}

export interface KeyPlayerCandidate {
  id: number;
  team: 'A' | 'B';
  /** touches + 3 * carries into the final third + 2 * passes received, last 60 s. */
  score: number;
  confidence: number;
  touches: number;
  carries: number;
  received: number;
}

export interface KeyPlayerFact extends Fact {
  /** The player on the ball right now; key-player graphics are only meaningful while this holds. */
  carrierId: number | null;
  candidates: KeyPlayerCandidate[];
}

export interface FormationFact extends Fact {
  team: 'A' | 'B';
  lines: number;
  outfielders: number;
  label: string | null;
}

export interface LinksFact extends Fact {
  team: 'A' | 'B' | null;
  pairs: MarkingPair[];
}

export interface PassingFact extends Fact {
  carrierId: number;
  options: { id: number; score: number }[];
  team: 'A' | 'B' | null;
}

export interface FreePlayerFact extends Fact {
  carrierId: number;
  freeId: number | null;
  /** Distance from the free player to their nearest opponent, ~metres. */
  spaceM: number;
  team: 'A' | 'B' | null;
}

export interface PressFact extends Fact {
  carrierId: number;
  pressers: number;
  team: 'A' | 'B' | null;
}

export interface PossessionSwingFact extends Fact {
  team: 'A' | 'B' | null;
  deltaPct: number;
  windowS: number;
}

export interface SwitchFact extends Fact {
  carrierId: number;
  targetId: number | null;
  team: 'A' | 'B' | null;
}

export interface CounterFact extends Fact {
  runnerId: number | null;
  team: 'A' | 'B' | null;
}

export interface PocketFact extends Fact {
  gapM: number;
}

export interface NearBallFact {
  A: number;
  B: number;
  ids: number[];
  radiusM: number;
}

export interface EngineFacts {
  nearBall: NearBallFact;
  overload: OverloadFact;
  formation: Record<'A' | 'B', FormationFact>;
  links: LinksFact;
  passing: PassingFact;
  freePlayer: FreePlayerFact;
  press: PressFact;
  swing: PossessionSwingFact;
  keyPlayer: KeyPlayerFact;
  switchArc: SwitchFact;
  counter: CounterFact;
  pocket: PocketFact;
}

const fact = (targets: number[] = []): Fact => ({ valid: false, confidence: 0, sinceS: 0, targets });

export function emptyFacts(): EngineFacts {
  return {
    nearBall: { A: 0, B: 0, ids: [], radiusM: 0 },
    overload: { ...fact(), team: null, attackers: 0, defenders: 0, near: [] },
    formation: {
      A: { ...fact(), team: 'A', lines: 0, outfielders: 0, label: null },
      B: { ...fact(), team: 'B', lines: 0, outfielders: 0, label: null },
    },
    links: { ...fact(), team: null, pairs: [] },
    passing: { ...fact(), carrierId: -1, options: [], team: null },
    freePlayer: { ...fact(), carrierId: -1, freeId: null, spaceM: 0, team: null },
    press: { ...fact(), carrierId: -1, pressers: 0, team: null },
    swing: { ...fact(), team: null, deltaPct: 0, windowS: 30 },
    keyPlayer: { ...fact(), carrierId: null, candidates: [] },
    switchArc: { ...fact(), carrierId: -1, targetId: null, team: null },
    counter: { ...fact(), runnerId: null, team: null },
    pocket: { ...fact(), gapM: 0 },
  };
}
