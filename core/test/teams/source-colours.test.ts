import { describe, expect, it } from 'vitest';
import {
  KNOWN_CLIP_COLOURS, knownClipFor, normaliseSourceName, resolveTeamColours,
} from '../../src/teams/source-colours';
import type { TeamColours } from '../../src/types';

const EAFC = '(PS5 PRO) EA FC 26 LOOKS AMAZING on PRO _ Realistic ULTRA Graphics Gameplay [4K 60FPS HDR] FIFA 26.mp4';
const FOOTAGE = 'footage.mp4';

describe('known clip colour profiles', () => {
  it('normalises punctuation, case and accents', () => {
    expect(normaliseSourceName('  (PS5 PRO) EA_FC-26 [4K].mp4 ')).toBe('ps5 pro ea fc 26 4k mp4');
    expect(normaliseSourceName('Café_Footage.MOV')).toBe('cafe footage mov');
    expect(normaliseSourceName(null)).toBe('');
  });

  it('recognises the EA FC and footage demo clips', () => {
    expect(knownClipFor(EAFC)?.id).toBe('eafc26-ps5-pro');
    // A re-encoded copy often loses the "Realistic ULTRA Graphics" phrase; PS5 Pro + EA FC is enough.
    expect(knownClipFor('(PS5 PRO) EA FC 26 Real Madrid vs Man City.mp4')?.id).toBe('eafc26-ps5-pro');
    expect(knownClipFor('EA SPORTS FC 26 on PS5 Pro.mp4')?.id).toBe('eafc26-ps5-pro');
    expect(knownClipFor(FOOTAGE)?.id).toBe('footage-orange-dark-blue');
    expect(knownClipFor('C:\\videos\\footage.mp4')?.id).toBe('footage-orange-dark-blue');
    expect(knownClipFor('https://example.test/clips/footage.mp4?token=abc')?.id).toBe('footage-orange-dark-blue');
    expect(knownClipFor('some-other-match.mp4')).toBeNull();
  });

  it('lets a different clip be detected instead of inheriting a preset', () => {
    expect(knownClipFor('a new EA FC 26 clip.mp4')).toBeNull();
    expect(knownClipFor('match footage 2.mp4')).toBeNull();
    expect(knownClipFor('FIFA 26 highlights.mp4')).toBeNull();
  });

  it('keeps the hardcoded clips distinct', () => {
    expect(KNOWN_CLIP_COLOURS.map((c) => c.id)).toEqual(['eafc26-ps5-pro', 'footage-orange-dark-blue']);
  });
});

describe('resolveTeamColours', () => {
  const measured = (A: string, B: string, confidence = 0.8): TeamColours => ({ A, B, confidence });

  it('returns the hardcoded pair and colour words for a known clip, ignoring measured noise', () => {
    const r = resolveTeamColours({
      sourceName: EAFC,
      measured: measured('#00ff00', '#ff00ff'),
    })!;
    expect(r.origin).toBe('clip');
    expect(r.clip?.id).toBe('eafc26-ps5-pro');
    expect(r.names).toEqual({ A: 'White', B: 'Blue' });
    expect(r.A).toBe('#f2f2f2');
    expect(r.B).toBe('#5aa9dd');
    expect(r.confidence).toBe(1);
  });

  it('ignores measured noise and keeps the hardcoded side order', () => {
    const r = resolveTeamColours({
      sourceName: EAFC,
      measured: measured('#66a8d8', '#efefef'),
    })!;
    expect(r.origin).toBe('clip');
    expect(r.A).toBe('#f2f2f2');
    expect(r.B).toBe('#5aa9dd');
    expect(r.names).toEqual({ A: 'White', B: 'Blue' });
  });

  it('uses the footage hardcode for orange vs dark blue', () => {
    const r = resolveTeamColours({
      sourceName: FOOTAGE,
      measured: measured('#e05a2a', '#24345e'),
    })!;
    expect(r.origin).toBe('clip');
    expect(r.A).toBe('#e8542e');
    expect(r.B).toBe('#1f2f5c');
    expect(r.names).toEqual({ A: 'Orange', B: 'Dark blue' });
  });

  it('falls back to measured colours for a new clip', () => {
    const r = resolveTeamColours({
      sourceName: 'new-broadcast.mp4',
      measured: measured('#d12b2b', '#1c3fae', 0.62),
    })!;
    expect(r.origin).toBe('measured');
    expect(r.clip).toBeNull();
    expect({ A: r.A, B: r.B }).toEqual({ A: '#d12b2b', B: '#1c3fae' });
    expect(r.names).toBeNull();
    expect(r.confidence).toBe(0.62);
  });

  it('uses a scorebug read only when there is no measurement', () => {
    const r = resolveTeamColours({
      sourceName: 'new-broadcast.mp4',
      scout: { A: '#2255cc', B: '#cc2222' },
    })!;
    expect(r.origin).toBe('scout');
    expect({ A: r.A, B: r.B }).toEqual({ A: '#2255cc', B: '#cc2222' });
  });

  it('returns null when nothing knows a colour', () => {
    expect(resolveTeamColours({ sourceName: 'new-broadcast.mp4' })).toBeNull();
  });
});
