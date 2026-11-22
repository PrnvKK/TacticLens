import { describe, expect, it } from 'vitest';
import { genericMentions } from '../components/Hud';
import { HudStore } from '../lib/render/hud-store';

describe('genericMentions (feed layout)', () => {
  const store = new HudStore();
  store.setKit('#ff0000', '#e8d20a'); // Team A = Red, Team B = Yellow
  const m = { ...store.m, teamOf: { 7: 'A' as const, 9: 'B' as const } };

  it('replaces a known-team mention with the jersey colour, no chip', () => {
    expect(genericMentions('Team Yellow win it back through [[7]], halting attack.', m))
      .toBe('Team Yellow win it back through a Team Red player, halting attack.');
  });

  it('uses a generic player for an unknown id', () => {
    expect(genericMentions('Pressure from [[42]] is high.', m)).toBe('Pressure from a player is high.');
  });

  it('capitalises a mention that starts the sentence', () => {
    expect(genericMentions('[[9]] drives forward.', m)).toBe('A Team Yellow player drives forward.');
    expect(genericMentions('Good shape. [[7]] steps in.', m)).toBe('Good shape. A Team Red player steps in.');
    expect(genericMentions('[[42]] goes wide.', m)).toBe('A player goes wide.');
  });

  it('leaves text with no mentions unchanged', () => {
    const plain = 'Team Red keep the ball, nothing to see.';
    expect(genericMentions(plain, m)).toBe(plain);
  });

  it('handles multiple mentions in one line', () => {
    expect(genericMentions('[[7]] passes to [[9]] and [[42]] closes.', m))
      .toBe('A Team Red player passes to a Team Yellow player and a player closes.');
  });
});
