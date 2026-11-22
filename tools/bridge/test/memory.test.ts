import { describe, expect, it } from 'vitest';
import { MatchMemory, fingerprintOf, formatStatLine, minuteSnapshotOf } from '../src/memory';
import { states } from './fixtures';

describe('MatchMemory', () => {
  it('ingests recorded states, dedupes events and rolls up per-minute stats', () => {
    const m = new MatchMemory();
    for (const s of states) m.ingest(s, 1_000);
    expect(m.latest?.possession.A).toBeCloseTo(56.57, 1);
    expect(m.events.length).toBeGreaterThan(20);
    expect(m.minutes.length).toBeGreaterThanOrEqual(2);
    const keys = new Set(m.events.map((e) => `${e.t}|${e.type}|${e.team}`));
    expect(keys.size).toBe(m.events.length);
    for (const minute of m.minutes) {
      if (minute.possession) expect(minute.possession.A + minute.possession.B).toBe(100);
    }
  });

  it('re-ingesting the same event does not duplicate it', () => {
    const m = new MatchMemory();
    const ev = { type: 'turnover', t: 12.3, team: 'A' as const, confidence: 0.9, detail: { x: 1 } };
    m.ingest({ ...states[0]!, events: [ev] }, 1);
    m.ingest({ ...states[1]!, events: [ev] }, 2);
    expect(m.events).toHaveLength(1);
  });

  it('eventsSince filters by video time', () => {
    const m = new MatchMemory();
    for (const s of states) m.ingest(s, 1_000);
    const all = m.eventsSince(0, 1000);
    const late = m.eventsSince(50, 1000);
    expect(late.length).toBeLessThan(all.length);
    expect(late.every((e) => e.t > 50)).toBe(true);
  });

  it('meaningful() is false right after an update and true after the picture changes', () => {
    const m = new MatchMemory();
    m.ingest(states[0]!, 1);
    expect(m.meaningful()).toBe(true);
    m.addUpdate('Arsenal are settling on the ball.');
    expect(m.meaningful()).toBe(false);
    const later = states[Math.floor(states.length / 2)]!;
    m.ingest(later, 2);
    expect(fingerprintOf(m.latest!)).not.toBe(fingerprintOf(states[0]!));
    expect(m.meaningful()).toBe(true);
  });

  it('keeps the latest Theatre commentary line for the fast ping', () => {
    const m = new MatchMemory();
    m.ingest({ ...states[0]!, commentary: { text: ' Team Blue are pinning Team Orange back. ', t: 12.3 } }, 1_000);
    expect(m.commentary).toEqual({ text: 'Team Blue are pinning Team Orange back.', t: 12.3, at: 1_000 });
    m.ingest({ ...states[1]!, commentary: { text: 'Team Orange have space on the right.', t: 15.1 } }, 2_000);
    expect(m.commentary).toMatchObject({ text: 'Team Orange have space on the right.', t: 15.1, at: 2_000 });
  });

  it('snapshot refs keep only the latest few and expose the newest', () => {
    const m = new MatchMemory();
    for (let i = 0; i < 10; i++) {
      m.addSnapshot({ id: `s${i}`, path: `p${i}`, t: i, width: 1280, height: 720, bytes: 3, receivedAt: i });
    }
    expect(m.snapshots).toHaveLength(8);
    expect(m.snapshot?.id).toBe('s9');
  });

  it('formats one stat category, never a multi-stat line', () => {
    const line = formatStatLine(states[states.length - 1]!);
    expect(line).toBe('Possession 57-43');
    expect(line).not.toContain('passes');
    expect(line).not.toContain('turnovers');
  });

  it('builds a minute snapshot with only gated analyst stats', () => {
    const min = minuteSnapshotOf(states[states.length - 1]!);
    expect(min.minute).toBe(1);
    expect(min.passes).toEqual({ A: 18, B: 12 });
    expect(min).not.toHaveProperty('momentum');
    expect(min).not.toHaveProperty('lineHeight');
  });
});
