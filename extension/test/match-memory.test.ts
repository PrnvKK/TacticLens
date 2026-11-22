import { describe, expect, it } from 'vitest';
import { MAX_EVENTS, MAX_MINUTES, MAX_PAYLOAD_CHARS, MAX_SAID, MatchMemory, type MemoryMatch } from '../lib/live/memory';

const LABELS = { A: 'Team Red', B: 'Team Yellow' };

const shown = (value: unknown, updatedAt: number) => ({ value, confidence: 1, updatedAt, gate: 'shown' });
const paused = (value: unknown, updatedAt: number) => ({ value, confidence: 1, updatedAt, gate: 'hidden', paused: true });
const match = (stats: Record<string, unknown>): MemoryMatch => ({ stats: stats as MemoryMatch['stats'] });
const ev = (type: string, t: number, team = 'A', detail: Record<string, number | string> = {}) => ({ type, t, team, confidence: 0.8, detail }) as any;

describe('MatchMemory', () => {
  it('keeps a stat\'s last real value after it turns paused, and reports how long ago it was seen', () => {
    const m = new MatchMemory();
    m.ingest({ t: 100, labels: LABELS, match: match({ possession: shown({ A: 55.4, B: 44.6 }, 100), pressure: shown(3.456, 100) }) });
    // The ball goes out: the engine keeps the value but marks it paused and hidden.
    m.ingest({ t: 108, match: match({ possession: paused({ A: 55.4, B: 44.6 }, 100), pressure: paused(3.456, 100) }) });

    const p = m.toPayload(110);
    expect(p.lastKnownStats.possession).toEqual({ value: { 'Team Red': 55, 'Team Yellow': 45 }, agoS: 10 });
    expect(p.lastKnownStats.pressure).toEqual({ value: 3.46, agoS: 10 });
    expect(p.teams).toEqual(['Team Red', 'Team Yellow']);
    // Nothing paused ever leaks into the payload as a string.
    expect(JSON.stringify(p)).not.toContain('paused');
  });

  it('a newer real value replaces the old one; stale-but-shown values keep their own updatedAt', () => {
    const m = new MatchMemory();
    m.ingest({ t: 50, labels: LABELS, match: match({ freePlayers: shown({ A: 2, B: 3 }, 50) }) });
    // Replay / close-up: the engine hands back the old stat still marked shown, with its old updatedAt.
    m.ingest({ t: 70, match: match({ freePlayers: shown({ A: 2, B: 3 }, 50) }) });
    expect(m.toPayload(72).lastKnownStats.freePlayers!.agoS).toBe(22);
    m.ingest({ t: 75, match: match({ freePlayers: shown({ A: 4, B: 1 }, 75) }) });
    expect(m.toPayload(76).lastKnownStats.freePlayers).toEqual({ value: { 'Team Red': 4, 'Team Yellow': 1 }, agoS: 1 });
  });

  it('ignores hidden, held, malformed and telemetry stats, and tracks who last had the ball', () => {
    const m = new MatchMemory();
    m.ingest({
      t: 10, labels: LABELS,
      match: {
        stats: {
          compactness: { value: { A: 0.1, B: 0.2 }, updatedAt: 10, gate: 'hidden' },
          tempo: { value: { A: 5, B: 6 }, updatedAt: 10, gate: 'held' },
          switches: shown({ A: 'x' }, 10),
          kimiCalls: shown(12, 10),
          detectorHealth: shown(0.9, 10),
          momentum: shown(0.4, 10),
        } as MemoryMatch['stats'],
        possession: { value: { current: 'B' }, gate: 'shown', updatedAt: 10 },
      },
    });
    const p = m.toPayload(12);
    expect(Object.keys(p.lastKnownStats).sort()).toEqual(['holder', 'momentum']);
    expect(p.lastKnownStats.holder).toEqual({ value: 'Team Yellow', agoS: 2 });
    // Momentum is signed for the first team; the payload names both sides.
    expect(p.lastKnownStats.momentum!.value).toEqual({ 'Team Red': 0.4, 'Team Yellow': -0.4 });
  });

  it('adds a per-minute snapshot, filled only with what was seen in that minute', () => {
    const m = new MatchMemory();
    m.ingest({ t: 30, labels: LABELS, match: match({ possession: shown({ A: 60, B: 40 }, 30), passes: shown({ A: 10, B: 8 }, 30), momentum: shown(0.2, 30) }) });
    // Later in minute 0 the numbers move on; the row keeps the latest values of that minute.
    m.ingest({ t: 50, match: match({ possession: shown({ A: 58, B: 42 }, 50), passes: shown({ A: 14, B: 9 }, 50), momentum: shown(0.3, 50) }) });
    // Minute 1: possession is seen again, passes stay paused all minute (so they must not be copied from minute 0).
    m.ingest({ t: 75, match: match({ possession: shown({ A: 52, B: 48 }, 75), passes: paused({ A: 14, B: 9 }, 50), momentum: shown(-0.1, 75) }) });

    const rows = m.toPayload(76).minutes;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ min: 0, possession: [58, 42], passes: [14, 9], momentum: 0.3 });
    expect(rows[1]).toEqual({ min: 1, possession: [52, 48], momentum: -0.1 });
  });

  it('caps the per-minute history at 120 rows', () => {
    const m = new MatchMemory();
    for (let i = 0; i < MAX_MINUTES + 15; i++) m.ingest({ t: i * 60 + 5, match: match({ possession: shown({ A: 50, B: 50 }, i * 60 + 5) }) });
    expect((m as any).mins).toHaveLength(MAX_MINUTES);
    // The payload only carries the last ~10.
    const rows = m.toPayload((MAX_MINUTES + 14) * 60 + 5).minutes;
    expect(rows.length).toBeLessThanOrEqual(10);
    expect(rows[rows.length - 1]!.min).toBe(MAX_MINUTES + 14);
  });

  it('deduplicates rule events across overlapping windows, labels teams and drops stale track ids and passes', () => {
    const m = new MatchMemory();
    const e1 = ev('turnover', 40.04, 'B', { from: 'A', carrierId: 7 });
    const e2 = ev('pass', 41, 'A', { from: 3, to: 5 });
    const e3 = ev('high_press', 44, 'A', { carrierId: 9, seconds: 4.123 });
    // The engine's recent window is re-sent on every tick.
    m.ingest({ t: 45, labels: LABELS, events: [e1, e2, e3] });
    m.ingest({ t: 46, events: [e1, e2, e3] });
    m.ingest({ t: 47, events: [{ ...e1 }, e3, ev('overload', 46.5, 'B')] });

    const ev3 = m.toPayload(50).events;
    expect(ev3.map((e) => e.type)).toEqual(['turnover', 'high_press', 'overload']);
    expect(ev3[0]).toEqual({ type: 'turnover', team: 'Team Yellow', agoS: 10, from: 'Team Red' });
    expect(ev3[1]).toEqual({ type: 'high_press', team: 'Team Red', agoS: 6, seconds: 4.12 });
    expect(JSON.stringify(ev3)).not.toMatch(/carrierId|"to"/);
  });

  it('caps the event log at 200 and the payload at the last 12', () => {
    const m = new MatchMemory();
    for (let i = 0; i < MAX_EVENTS + 20; i++) m.ingest({ t: 1000 + i, events: [ev('turnover', 1000 + i)] });
    expect((m as any).evs).toHaveLength(MAX_EVENTS);
    expect(m.toPayload(1300).events).toHaveLength(12);
  });

  it('starts a new segment on a big backward seek: stats, minutes and events restart, what was said stays', () => {
    const m = new MatchMemory();
    m.ingest({ t: 300, labels: LABELS, match: match({ possession: shown({ A: 70, B: 30 }, 300) }), events: [ev('turnover', 299)] });
    m.addSaid({ id: 'cm1', text: 'Team Red keep the ball.', t: 298, phase: 'settled' });
    expect(m.segment).toBe(0);

    // A small jitter backwards does not count.
    m.ingest({ t: 299, match: match({ possession: shown({ A: 70, B: 30 }, 299) }) });
    expect(m.segment).toBe(0);

    // The viewer drags the video back by three minutes.
    m.ingest({ t: 120, events: [] });
    expect(m.segment).toBe(1);
    const p = m.toPayload(120);
    expect(p.lastKnownStats).toEqual({});
    expect(p.minutes).toEqual([]);
    expect(p.events).toEqual([]);
    expect(p.phases).toBeUndefined();
    // The chat history survives, without a (meaningless) age.
    expect(p.said).toEqual([{ by: 'commentary', text: 'Team Red keep the ball.' }]);

    // The same event time can be recorded again on the second pass (its key was cleared with the segment).
    m.ingest({ t: 301, events: [ev('turnover', 299)] });
    expect(m.toPayload(301).events).toHaveLength(1);
  });

  it('remembers what was said: last six with age, dedupes by id, strips [[ids]], tallies phases, caps at 30', () => {
    const m = new MatchMemory();
    m.ingest({ t: 5, labels: LABELS });
    m.addSaid({ id: 'cm1', text: 'Red press with [[7]] on the ball.', t: 5, phase: 'press' });
    m.addSaid({ id: 'cm1', text: 'duplicate id is ignored', t: 5, phase: 'press' });
    m.addSaid({ id: 'dir1', text: 'Team Yellow drop deep.', t: 9, phase: 'none', by: 'director' });
    m.addSaid({ text: '   ', t: 9 });
    const p = m.toPayload(15);
    expect(p.said).toEqual([
      { by: 'commentary', agoS: 10, text: 'Red press with #7 on the ball.' },
      { by: 'director', agoS: 6, text: 'Team Yellow drop deep.' },
    ]);
    expect(p.phases).toEqual({ press: 1 });

    for (let i = 0; i < MAX_SAID + 10; i++) m.addSaid({ id: `x${i}`, text: `line ${i}`, t: 20 + i, phase: 'settled', by: 'answer' });
    expect((m as any).lines).toHaveLength(MAX_SAID);
    const last = m.toPayload(100).said;
    expect(last).toHaveLength(6);
    expect(last[5]!.text).toBe(`line ${MAX_SAID + 9}`);
    // An evicted id can be said again.
    m.addSaid({ id: 'cm1', text: 'back again', t: 100 });
    expect(m.toPayload(101).said.at(-1)!.text).toBe('back again');
  });

  it('falls back to Team A / Team B without labels, and keeps the payload within about 1.5k tokens when full', () => {
    const bare = new MatchMemory();
    bare.ingest({ t: 5, match: match({ possession: shown({ A: 51, B: 49 }, 5) }) });
    expect(bare.toPayload(5).lastKnownStats.possession!.value).toEqual({ 'Team A': 51, 'Team B': 49 });

    const m = new MatchMemory();
    const keys = ['possession', 'spell', 'passes', 'tempo', 'turnovers', 'pressure', 'timeToPressure', 'numbersNearBall', 'openOptions', 'freePlayers',
      'teamExtent', 'compactness', 'blockGap', 'lineHeight', 'fieldTilt', 'switches', 'sprints', 'ballSpeed', 'momentum'];
    for (let i = 0; i < 130; i++) {
      const t = i * 60 + 20;
      const stats: Record<string, unknown> = {};
      for (const k of keys) stats[k] = shown(k === 'momentum' || k === 'pressure' ? 0.123456 : { A: 12.3456 + i, B: 7.891 + i }, t);
      m.ingest({ t, labels: { A: 'Team Light blue', B: 'Team Yellow' }, match: match(stats), events: [ev('high_press', t + 1, 'A', { seconds: 3.21, carrierId: 4 }), ev('switch_of_play', t + 2, 'B')] });
    }
    for (let i = 0; i < 40; i++) m.addSaid({ id: `s${i}`, text: 'Team Light blue are pressing high and Team Yellow cannot find a way out of their own half.', t: 7800 + i, phase: 'press' });
    const p = m.toPayload(7850);
    expect(JSON.stringify(p).length).toBeLessThanOrEqual(MAX_PAYLOAD_CHARS);
    expect(p.minutes.length).toBeGreaterThanOrEqual(2);
    expect(p.events.length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(p.lastKnownStats)).toHaveLength(keys.length);
  });
});
