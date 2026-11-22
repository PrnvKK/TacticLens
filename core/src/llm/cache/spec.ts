// Prompt layout, from most stable to most volatile. All Kimi lanes share layer 1 byte for byte, then
// each lane adds its own stable instructions (layer 2), then a match block that changes rarely (layer 3).
// Only the user message (the tail) changes per call.
//
//   system = [shared content][pad][bridge A] | [bridge B][lane instructions][match block][pad][bridge A]
//   user   = [tail]
//
// The "|" marks a 1024-token block boundary. The two bridge strings are fixed text on both sides of every
// boundary, so a token-count error of a few dozen tokens still leaves the boundary inside stable text.
import { hashString } from './serialize';

export const BLOCK_TOKENS = 1024;

export const BRIDGE_A = '\n--- end of layer. Everything above this line is fixed reference material and is identical on every call. ---\n';
export const BRIDGE_B = '\n--- next layer. Treat the text below as the instructions for this lane, then the match facts, then the live message. ---\n';

export interface PromptSpec {
  /** Layer 1: persona, rules, glossary, output schemas and few-shot examples. Identical for every lane. */
  shared: string;
  /** Layer 2: lane-specific stable instructions. */
  lanes: Record<string, string>;
  /** Hash of all stable text; calibration is keyed by it. */
  version: string;
}

export function createPromptSpec(shared: string, lanes: Record<string, string>): PromptSpec {
  const names = Object.keys(lanes).sort();
  const version = hashString([shared, ...names.map((n) => `${n}\n${lanes[n]}`)].join('\n=====\n'));
  return { shared, lanes, version };
}

/** Rarely-changing match facts (teams, kit colours, attack direction, formations). */
export interface MatchBlock {
  teams: { A: { name: string; kit: string; formation?: string }; B: { name: string; kit: string; formation?: string } };
  attack?: { A: string; B: string };
  /** Anything else that changes only on a meaningful event (e.g. "calibrated": true). */
  extra?: Record<string, string | number | boolean>;
}
