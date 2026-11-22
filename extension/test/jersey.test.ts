import { describe, expect, it } from 'vitest';
import { colourName, jerseyNames } from '../lib/render/tokens';
import { jerseyText } from '../components/Hud';
import { HudStore } from '../lib/render/hud-store';

describe('jersey colour words', () => {
  it('names common kit colours', () => {
    expect(colourName('#ff0000')).toBe('Red');
    expect(colourName('#e8d20a')).toBe('Yellow');
    expect(colourName('#1c9a3a')).toBe('Green');
    expect(colourName('#2255cc')).toBe('Blue');
    expect(colourName('#ffffff')).toBe('White');
    expect(colourName('#101010')).toBe('Black');
    expect(colourName('#ff8a1a')).toBe('Orange');
    expect(colourName('#7a1020')).toBe('Maroon');
    expect(colourName('#8ec5ff')).toBe('Light blue');
  });

  it('tells two same-hue kits apart', () => {
    expect(colourName('#4a7dff')).toBe(colourName('#2a4fcf'));   // both plain "Blue"
    const n = jerseyNames('#4a7dff', '#2a4fcf');
    expect(n.A).not.toBe(n.B);
    expect(n.A.startsWith('Light')).toBe(true);
    expect(n.B.startsWith('Dark')).toBe(true);
  });

  it('never gives two white or two black kits the same label', () => {
    expect(colourName('#f0f4fa')).toBe('White');                 // cool-white floodlight, not Light blue
    expect(jerseyNames('#f8f8f8', '#f2f2f2')).toEqual({ A: 'White', B: 'Grey' });
    expect(jerseyNames('#f2f2f2', '#f8f8f8')).toEqual({ A: 'Grey', B: 'White' });
    expect(jerseyNames('#161616', '#0c0c0c')).toEqual({ A: 'Charcoal', B: 'Black' });
  });
});

describe('jerseyText', () => {
  const store = new HudStore();
  store.setKit('#ff0000', '#e8d20a');
  const m = { ...store.m, names: { A: 'Harbor FC', B: 'Redstone' } };

  it('replaces club names, Team A/B and possessives with the jersey colour', () => {
    expect(jerseyText('Harbor FC have the ball; Redstone press.', m)).toBe('Team Red have the ball; Team Yellow press.');
    expect(jerseyText('Team A are camped in Team B\'s half.', m)).toBe('Team Red are camped in Team Yellow\'s half.');
    expect(jerseyText("Redstone's line is high", m)).toBe("Team Yellow's line is high");
  });

  it('does not double up when the text already says Team <colour>', () => {
    const blue = { ...store.m, names: { A: 'Red', B: 'Yellow' } };
    expect(jerseyText('Team Red keep it.', blue)).toBe('Team Red keep it.');
  });
});
