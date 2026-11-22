import { describe, expect, it } from 'vitest';
import type { EngineOutput } from '../../src/engine';
import { emptyFacts, type EngineFacts } from '../../src/engine';
import { buildMenu, menuIds } from '../../src/director';

const output = (f: EngineFacts): EngineOutput => ({ detail: { facts: f } } as unknown as EngineOutput);
const live = new Set([1, 2, 3, 4, 5, 6, 7, 8, 11, 12]);

function populated(): EngineFacts {
  const f = emptyFacts();
  f.overload = { ...f.overload, valid: true, confidence: 0.82, sinceS: 3.4, team: 'A', attackers: 4, defenders: 2, near: [1, 2, 3, 4, 11, 12], targets: [1, 2, 3, 4, 11, 12] };
  f.formation.A = { ...f.formation.A, valid: true, confidence: 0.7, sinceS: 4, targets: [1, 2, 3, 4, 31, 32], lines: 3, outfielders: 8, label: '4-3-3' };
  f.links = { ...f.links, valid: true, confidence: 0.6, sinceS: 2, team: 'A', pairs: [{ attacker: 1, defender: 11, distM: 2.1 }, { attacker: 2, defender: 12, distM: 3.2 }], targets: [1, 11, 2, 12] };
  f.passing = { ...f.passing, valid: true, confidence: 0.7, sinceS: 1.2, team: 'A', carrierId: 1, options: [{ id: 5, score: 0.8 }, { id: 6, score: 0.5 }], targets: [1, 5, 6] };
  f.freePlayer = { ...f.freePlayer, valid: true, confidence: 0.7, sinceS: 1.2, team: 'A', carrierId: 1, freeId: 5, spaceM: 6.4, targets: [1, 5] };
  f.press = { ...f.press, valid: true, confidence: 0.8, sinceS: 1.5, team: 'A', carrierId: 1, pressers: 2, targets: [1, 11, 12] };
  f.keyPlayer = {
    ...f.keyPlayer, valid: true, confidence: 0.78, sinceS: 40, carrierId: 2, targets: [2],
    candidates: [{ id: 2, team: 'A', score: 7, confidence: 0.78, touches: 3, carries: 1, received: 2 }],
  };
  f.swing = { ...f.swing, valid: true, confidence: 0.6, sinceS: 6, team: 'B', deltaPct: -11, windowS: 30 };
  f.switchArc = { ...f.switchArc, valid: true, confidence: 0.7, sinceS: 1, team: 'A', carrierId: 1, targetId: 6, targets: [1, 6] };
  f.counter = { ...f.counter, valid: true, confidence: 0.7, sinceS: 0.8, team: 'B', runnerId: 7, targets: [7] };
  f.pocket = { ...f.pocket, valid: true, confidence: 0.5, sinceS: 2, targets: [5, 12], gapM: 18 };
  return f;
}

describe('graphics menu', () => {
  it('is empty when no fact is valid', () => {
    expect(menuIds(buildMenu(output(emptyFacts()), 10, live))).toEqual([]);
  });

  it('maps every valid fact to a stable graphic id, kind and live targets', () => {
    const menu = buildMenu(output(populated()), 10, live);
    expect(menu.t).toBe(10);
    expect(menuIds(menu)).toEqual([
      'overload', 'formation_a', 'marking_links', 'passing_lanes', 'free_player', 'press_trap', 'spotlight',
      'key_player', 'possession_swing', 'switch_arc', 'counter_run', 'space_pocket',
    ]);
    const overload = menu.items.find((i) => i.id === 'overload')!;
    expect(overload.kind).toBe('overload');
    expect(overload.targets).toEqual([1, 2, 3, 4, 11, 12]);
    expect(overload.data.attackers).toBe(4);
    expect(overload.label).toBe('4 v 2 overload');
    expect(menu.items.find((i) => i.id === 'formation_a')!.kind).toBe('line');
    expect(menu.items.find((i) => i.id === 'key_player')!.kind).toBe('tag');
    expect(menu.items.find((i) => i.id === 'spotlight')!.targets).toEqual([2]);
  });

  it('drops dead targets and drops a player fact that has no live target left', () => {
    const f = populated();
    const onlyDead = buildMenu(output(f), 10, new Set([1, 2, 3, 4, 5, 6]));
    expect(onlyDead.items.find((i) => i.id === 'overload')!.targets).toEqual([1, 2, 3, 4]);
    expect(onlyDead.items.some((i) => i.id === 'marking_links')).toBe(false);   // 11/12 are gone
    const noLive = buildMenu(output(f), 10, new Set([1]));
    expect(noLive.items.some((i) => i.id === 'spotlight')).toBe(false);
    expect(noLive.items.some((i) => i.id === 'possession_swing')).toBe(true);     // no player targets needed
  });

  it('keys the key player to the live carrier without needing every top candidate', () => {
    const f = populated();
    f.keyPlayer = {
      ...f.keyPlayer, valid: true, carrierId: 2,
      targets: [2, 98, 99],
      candidates: [
        { id: 2, team: 'A', score: 3, confidence: 0.6, touches: 1, carries: 0, received: 1 },
        { id: 98, team: 'A', score: 9, confidence: 0.9, touches: 3, carries: 2, received: 0 },
        { id: 99, team: 'A', score: 8, confidence: 0.9, touches: 2, carries: 2, received: 0 },
      ],
    };
    const menu = buildMenu(output(f), 10, live);
    expect(menu.items.find((i) => i.id === 'key_player')!.targets).toEqual([2]);
    expect(menu.items.find((i) => i.id === 'spotlight')!.targets).toEqual([2]);
  });

  it('excludes invalid facts even when their data is populated', () => {
    const f = populated();
    f.press = { ...f.press, valid: false };
    f.keyPlayer = { ...f.keyPlayer, valid: false };
    const ids = menuIds(buildMenu(output(f), 10, live));
    expect(ids).not.toContain('press_trap');
    expect(ids).not.toContain('spotlight');
    expect(ids).not.toContain('key_player');
  });
});
