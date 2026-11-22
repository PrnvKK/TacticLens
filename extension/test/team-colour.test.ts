import { describe, expect, it } from 'vitest';
import type { TeamColours } from '@tacticlens/core';
import { TeamColourResolver } from '../lib/render/team-colour';
import { HudStore } from '../lib/render/hud-store';

const EAFC = '(PS5 PRO) EA FC 26 LOOKS AMAZING on PRO _ Realistic ULTRA Graphics Gameplay [4K 60FPS HDR] FIFA 26.mp4';
const measured = (A: string, B: string): TeamColours => ({ A, B, confidence: 0.7 });

describe('TeamColourResolver', () => {
  it('pins the EA FC clip to white vs blue', () => {
    const r = new TeamColourResolver(EAFC);
    const out = r.resolve(measured('#22aa33', '#aa22cc'))!;
    expect(out.origin).toBe('clip');
    expect(out.raw).toEqual({ A: '#f2f2f2', B: '#5aa9dd' });
    expect(out.names).toEqual({ A: 'White', B: 'Blue' });
  });

  it('pins footage.mp4 to orange vs dark blue', () => {
    const r = new TeamColourResolver('C:/videos/footage.mp4');
    const out = r.resolve(measured('#e05a2a', '#24345e'))!;
    expect(out.origin).toBe('clip');
    expect(out.raw).toEqual({ A: '#e8542e', B: '#1f2f5c' });
    expect(out.names).toEqual({ A: 'Orange', B: 'Dark blue' });
  });

  it('leaves a new clip on measured colours', () => {
    const r = new TeamColourResolver('a-new-match.mp4');
    const out = r.resolve(measured('#d12b2b', '#1c3fae'))!;
    expect(out.origin).toBe('measured');
    expect(out.raw).toEqual({ A: '#d12b2b', B: '#1c3fae' });
    expect(out.names).toBeNull();
  });
});

describe('HudStore jersey labels', () => {
  it('uses explicit clip words and falls back to derived words afterwards', () => {
    const store = new HudStore();
    store.setKit('#f2f2f2', '#5aa9dd', undefined, undefined, { A: 'White', B: 'Blue' });
    expect(store.m.jersey).toEqual({ A: 'White', B: 'Blue' });
    store.setKit('#ff0000', '#e8d20a');
    expect(store.m.jersey).toEqual({ A: 'Red', B: 'Yellow' });
  });
});
