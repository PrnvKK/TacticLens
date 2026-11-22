import { describe, expect, it } from 'vitest';
import { resolveTeamColours } from '../../src/teams/source-colours';
import type { TeamColours } from '../../src/types';

describe('resolveTeamColours', () => {
  const measured = (A: string, B: string, confidence = 0.8): TeamColours => ({ A, B, confidence });

  it('uses the measured kit colours for any source', () => {
    const r = resolveTeamColours({ measured: measured('#d12b2b', '#1c3fae', 0.62) })!;
    expect(r.origin).toBe('measured');
    expect({ A: r.A, B: r.B }).toEqual({ A: '#d12b2b', B: '#1c3fae' });
    expect(r.confidence).toBe(0.62);
    expect(r.measured).toEqual({ A: '#d12b2b', B: '#1c3fae' });
  });

  it('prefers measured colours over a scorebug read', () => {
    const r = resolveTeamColours({
      measured: measured('#e05a2a', '#24345e'),
      scout: { A: '#2255cc', B: '#cc2222' },
    })!;
    expect(r.origin).toBe('measured');
    expect({ A: r.A, B: r.B }).toEqual({ A: '#e05a2a', B: '#24345e' });
  });

  it('uses a scorebug read only when there is no measurement', () => {
    const r = resolveTeamColours({
      measured: null,
      scout: { A: '#2255cc', B: '#cc2222' },
    })!;
    expect(r.origin).toBe('scout');
    expect(r.confidence).toBe(1);
    expect({ A: r.A, B: r.B }).toEqual({ A: '#2255cc', B: '#cc2222' });
  });

  it('ignores a malformed measured pair and falls back to the scorebug read', () => {
    const r = resolveTeamColours({
      measured: measured('red', '#1c3fae'),
      scout: { A: '#2255cc', B: '#cc2222' },
    })!;
    expect(r.origin).toBe('scout');
  });

  it('returns null when nothing knows a colour', () => {
    expect(resolveTeamColours({})).toBeNull();
    expect(resolveTeamColours({ measured: null, scout: null })).toBeNull();
  });
});
