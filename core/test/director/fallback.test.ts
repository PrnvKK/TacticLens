import { describe, expect, it } from 'vitest';
import type { EngineOutput } from '../../src/engine';
import { emptyFacts, type EngineFacts } from '../../src/engine';
import { buildMenu, pickFallback } from '../../src/director';

const output = (f: EngineFacts): EngineOutput => ({ detail: { facts: f } } as unknown as EngineOutput);
const live = new Set([1, 2, 3, 4, 5, 11, 12]);

function facts(): EngineFacts {
  const f = emptyFacts();
  f.passing = { ...f.passing, valid: true, confidence: 0.7, sinceS: 1.2, team: 'A', carrierId: 1, options: [{ id: 5, score: 0.8 }], targets: [1, 5] };
  f.keyPlayer = {
    ...f.keyPlayer, valid: true, confidence: 0.6, sinceS: 3, carrierId: 1, targets: [1],
    candidates: [{ id: 1, team: 'A', score: 3, confidence: 0.6, touches: 2, carries: 0, received: 1 }],
  };
  f.overload = { ...f.overload, valid: true, confidence: 0.8, sinceS: 2, team: 'A', attackers: 3, defenders: 2, near: [1, 2, 11], targets: [1, 2, 11] };
  return f;
}

describe('rules fallback', () => {
  it('picks the key player on the carrier before a heavier shape graphic', () => {
    const menu = buildMenu(output(facts()), 10, live);
    expect(pickFallback(menu, { nowS: 100 })?.id).toBe('key_player');
  });

  it('skips a recently shown item and the previous fallback', () => {
    const menu = buildMenu(output(facts()), 10, live);
    const lastShown = new Map([['key_player', 98]]);
    expect(pickFallback(menu, { nowS: 100, lastShown, avoid: 'key_player' })?.id).toBe('passing_lanes');
  });

  it('returns null when the menu is empty', () => {
    expect(pickFallback(buildMenu(output(emptyFacts()), 10, live), { nowS: 100 })).toBeNull();
  });
});
