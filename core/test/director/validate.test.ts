import { describe, expect, it } from 'vitest';
import type { DirectorDecision, GraphicsMenu } from '../../src/director';
import { labelFromCaption, validateDecision, type ValidateOptions } from '../../src/director';

const menu: GraphicsMenu = {
  t: 10,
  items: [{
    id: 'overload', label: '3 v 2 overload', kind: 'overload', targets: [1, 2, 3, 4, 5], team: 'A',
    fact: { valid: true, confidence: 0.8, sinceS: 3, targets: [1, 2, 3, 4, 5] },
    data: { attackers: 3, defenders: 2 },
  }],
};

const dec = (o: Partial<DirectorDecision> = {}): DirectorDecision => ({
  action: 'show', graphic: 'overload', targets: [1, 2, 3], caption: 'three against two', say: 'The left side is open.',
  duration_s: 5, confidence: 0.8, ...o,
});

const base = (o: Partial<ValidateOptions> = {}): ValidateOptions => ({
  decision: dec(),
  menu,
  liveIds: new Set([1, 2, 3, 4, 5, 6, 7, 11, 12]),
  ageS: 0.2,
  nowS: 100,
  onScreen: null,
  calm: { ready: true, reason: '' },
  lastShown: new Map(),
  ...o,
});

describe('director validator', () => {
  it('accepts a valid show and clamps the duration', () => {
    const r = validateDecision(base({ decision: dec({ duration_s: 99, confidence: 2 }) }));
    expect(r.ok).toBe(true);
    expect(r.decision!.duration_s).toBe(10);
    expect(r.decision!.confidence).toBe(1);
    expect(r.decision!.targets).toEqual([1, 2, 3]);
    expect(validateDecision(base({ decision: dec({ duration_s: 1 }) })).decision!.duration_s).toBe(3);
  });

  it('rejects a graphic that is not in the menu', () => {
    const r = validateDecision(base({ decision: dec({ graphic: 'formation_b' }) }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not in menu');
  });

  it('rejects dead targets and live ids that are not part of the fact', () => {
    expect(validateDecision(base({ decision: dec({ targets: [1, 99] }) })).reason).toMatch(/not live/);
    expect(validateDecision(base({ decision: dec({ targets: [1, 7] }) })).reason).toMatch(/not in overload fact/);
  });

  it('rejects a stale decision, a busy calm gate, an occupied screen and a repeat', () => {
    expect(validateDecision(base({ ageS: 3.2 })).reason).toMatch(/stale/);
    expect(validateDecision(base({ ageS: 3.2, decision: dec({ action: 'none', graphic: 'none', targets: [] }) })).reason).toMatch(/stale/);
    expect(validateDecision(base({ calm: { ready: false, reason: 'pan 400px/s' } })).reason).toMatch(/calm/);
    expect(validateDecision(base({ onScreen: { id: 'overload', sinceS: 2 } })).reason).toMatch(/already on screen/);
    expect(validateDecision(base({ lastShown: new Map([['overload', 95]]) })).reason).toMatch(/repeat/);
    expect(validateDecision(base({ lastShown: new Map([['overload', 70]]) })).ok).toBe(true);
  });

  it('handles hide, keep and none against what is on screen', () => {
    expect(validateDecision(base({ decision: dec({ action: 'hide' }) })).reason).toMatch(/nothing on screen/);
    expect(validateDecision(base({ decision: dec({ action: 'keep' }) })).reason).toMatch(/nothing on screen/);
    const screen = { id: 'overload' as const, sinceS: 2 };
    expect(validateDecision(base({ decision: dec({ action: 'hide', graphic: 'none' }), onScreen: screen })).ok).toBe(true);
    expect(validateDecision(base({ decision: dec({ action: 'keep', duration_s: 6 }), onScreen: screen })).decision!.duration_s).toBe(6);
    expect(validateDecision(base({ decision: dec({ action: 'none', graphic: 'none', targets: [] }) })).ok).toBe(true);
  });

  it('enforces the schema and the caption/say word budget', () => {
    expect(validateDecision(base({ decision: { graphic: 'overload' } })).reason).toMatch(/schema/);
    expect(validateDecision(base({ decision: dec({ action: 'dance' as DirectorDecision['action'] }) })).reason).toMatch(/schema/);
    const caption = Array.from({ length: 14 }, (_, i) => `w${i}`).join(' ');
    const say = Array.from({ length: 24 }, (_, i) => `s${i}`).join(' ');
    const r = validateDecision(base({ decision: dec({ caption, say }) }));
    expect(r.ok).toBe(true);
    expect(r.decision!.caption.split(' ')).toHaveLength(10);
    expect(r.decision!.say.split(' ')).toHaveLength(20);
  });

  it('makes an intent label short and free of digits', () => {
    expect(labelFromCaption('3 v 2 on the left', 'overload')).toBe('v on the left');
    expect(labelFromCaption('', 'free player')).toBe('free player');
  });

  it('lets a key player tag through a busy calm gate', () => {
    const kp: GraphicsMenu = { t: 10, items: [{
      id: 'key_player', label: 'key player', kind: 'tag', targets: [1], team: 'A',
      fact: { valid: true, confidence: 0.7, sinceS: 3, targets: [1] }, data: { carrier: 1 },
    }] };
    const r = validateDecision(base({
      menu: kp, decision: dec({ graphic: 'key_player', targets: [1] }), calm: { ready: false, reason: 'players 400px/s' },
    }));
    expect(r.ok).toBe(true);
    // A heavier graphic still waits.
    const overloadBusy = validateDecision(base({ calm: { ready: false, reason: 'players 400px/s' } }));
    expect(overloadBusy.reason).toMatch(/calm/);
  });

  it('keeps the carrier first and the marking pairs paired', () => {
    const lanes: GraphicsMenu = { t: 10, items: [{
      id: 'passing_lanes', label: 'passing lanes', kind: 'lanes', targets: [1, 5, 6], team: 'A',
      fact: { valid: true, confidence: 0.7, sinceS: 2, targets: [1, 5, 6] }, data: { carrier: 1 },
    }] };
    expect(validateDecision(base({ menu: lanes, decision: dec({ graphic: 'passing_lanes', targets: [5, 6] }) })).reason).toMatch(/anchor/);
    expect(validateDecision(base({ menu: lanes, decision: dec({ graphic: 'passing_lanes', targets: [1, 5] }) })).ok).toBe(true);

    const links: GraphicsMenu = { t: 10, items: [{
      id: 'marking_links', label: 'marking links', kind: 'links', targets: [1, 11, 2, 12], team: 'A',
      fact: { valid: true, confidence: 0.7, sinceS: 2, targets: [1, 11, 2, 12], pairs: [{ attacker: 1, defender: 11 }, { attacker: 2, defender: 12 }] } as never,
      data: { pairs: 2 },
    }] };
    expect(validateDecision(base({ menu: links, decision: dec({ graphic: 'marking_links', targets: [1, 2] }) })).reason).toMatch(/anchor/);
    expect(validateDecision(base({ menu: links, decision: dec({ graphic: 'marking_links', targets: [1, 11] }) })).ok).toBe(true);
  });
});
