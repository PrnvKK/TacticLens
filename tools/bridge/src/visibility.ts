// Visibility rules shared by memory, MCP exposure and prompts.
// 0.6 is the engine's low hysteresis gate: below it a stat is hidden and a fact is not trustworthy.
import type { StatKey, StatValue } from '@tacticlens/core';
import type { FactLite, StatLite } from './protocol';

export const FACT_GATE = 0.6;
export const MAX_OVERLOAD_SIDE = 4;

/** Numeric stats the Telegram analyst may ever quote. */
export const NUMERIC_STATS: readonly StatKey[] = ['possession', 'passes', 'turnovers'];

export function statVisible(stat: StatLite | undefined): boolean {
  return !!stat
    && stat.gate === 'shown'
    && typeof stat.confidence === 'number'
    && Number.isFinite(stat.confidence)
    && stat.confidence >= FACT_GATE;
}

export function visiblePair(stat: StatLite | undefined): { A: number; B: number } | null {
  if (!statVisible(stat) || !stat || !stat.value || typeof stat.value !== 'object' || Array.isArray(stat.value)) return null;
  const v = stat.value as { A?: unknown; B?: unknown };
  if (typeof v.A !== 'number' || typeof v.B !== 'number') return null;
  return { A: v.A, B: v.B };
}

export function visibleNumber(stat: StatLite | undefined): number | null {
  if (!statVisible(stat) || !stat || typeof stat.value !== 'number' || !Number.isFinite(stat.value)) return null;
  return stat.value;
}

export function factAllowed(f: FactLite): boolean {
  if (!f || f.valid !== true) return false;
  if (typeof f.confidence !== 'number' || !Number.isFinite(f.confidence) || f.confidence < FACT_GATE) return false;
  if (f.id === 'overload') {
    const a = sideCount(f.data?.attackers);
    const d = sideCount(f.data?.defenders);
    // A 5+ v anything overload is a tracking artefact, not a tactical fact.
    if (!a || !d || a > MAX_OVERLOAD_SIDE || d > MAX_OVERLOAD_SIDE) return false;
  }
  return true;
}

export function filterFacts(facts: FactLite[] | undefined): FactLite[] {
  return (facts ?? []).filter(factAllowed);
}

export function sideCount(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v);
  return null;
}

export function statValueOf(stat: StatLite | undefined): StatValue | null {
  return statVisible(stat) && stat ? stat.value : null;
}
