// EngineFacts -> compact FactLite, used by the fixture recorder. The extension has the same mapping
// in extension/lib/bridge/state.ts; keep the ids and overload counts in sync.
import type { EngineFacts } from '@tacticlens/core';
import type { FactLite } from './protocol';

const r1 = (v: number): number => Math.round(v * 10) / 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;

export function factsFromEngine(f: EngineFacts): FactLite[] {
  const out: FactLite[] = [];
  const add = (
    id: string,
    fact: { valid: boolean; confidence: number; sinceS: number; targets: number[] },
    data: Record<string, number | string>,
    team?: 'A' | 'B' | null,
  ): void => {
    out.push({
      id,
      valid: fact.valid === true,
      confidence: r2(fact.confidence),
      sinceS: r1(fact.sinceS),
      targets: [...fact.targets].slice(0, 12),
      ...(team ? { team } : {}),
      data,
    });
  };
  add('overload', f.overload, { attackers: f.overload.attackers, defenders: f.overload.defenders }, f.overload.team);
  add('formation_a', f.formation.A, {}, 'A');
  add('formation_b', f.formation.B, {}, 'B');
  add('links', f.links, {}, f.links.team);
  add('passing_lanes', f.passing, {}, f.passing.team);
  add('free_player', f.freePlayer, {}, f.freePlayer.team);
  add('press_trap', f.press, {}, f.press.team);
  add('possession_swing', f.swing, {}, f.swing.team);
  add('key_player', f.keyPlayer, {});
  add('switch_arc', f.switchArc, {}, f.switchArc.team);
  add('counter_run', f.counter, {}, f.counter.team);
  add('space_pocket', f.pocket, {});
  return out;
}
