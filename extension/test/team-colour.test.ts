import { describe, expect, it } from 'vitest';
import type { TeamColours } from '@tacticlens/core';
import { TeamColourResolver } from '../lib/render/team-colour';
import { HudStore } from '../lib/render/hud-store';

const measured = (A: string, B: string): TeamColours => ({ A, B, confidence: 0.7 });

describe('TeamColourResolver', () => {
  it('resolves the measured kit pair', () => {
    const r = new TeamColourResolver();
    const out = r.resolve(measured('#d12b2b', '#1c3fae'))!;
    expect(out.origin).toBe('measured');
    expect(out.raw).toEqual({ A: '#d12b2b', B: '#1c3fae' });
    expect(out.confidence).toBe(0.7);
  });

  it('falls back to the scorebug read only when there is no measurement', () => {
    const r = new TeamColourResolver();
    const out = r.resolve(null, { A: '#2255cc', B: '#cc2222' })!;
    expect(out.origin).toBe('scout');
    expect(out.raw).toEqual({ A: '#2255cc', B: '#cc2222' });
  });

  it('returns null when nothing knows a colour', () => {
    expect(new TeamColourResolver().resolve(null, null)).toBeNull();
  });
});

describe('HudStore jersey labels', () => {
  it('uses explicit words when given and falls back to derived words afterwards', () => {
    const store = new HudStore();
    store.setKit('#f2f2f2', '#5aa9dd', undefined, undefined, { A: 'White', B: 'Blue' });
    expect(store.m.jersey).toEqual({ A: 'White', B: 'Blue' });
    store.setKit('#ff0000', '#e8d20a');
    expect(store.m.jersey).toEqual({ A: 'Red', B: 'Yellow' });
  });
});
