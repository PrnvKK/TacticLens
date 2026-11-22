import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KimiLine } from '@tacticlens/core';
import { ASK_TIMEOUT_MS, FEED_MAX, HudStore, STAT_LINGER_MS, STAT_MIN_GAP_MS } from '../lib/render/hud-store';

const FREE = { key: 'freePlayers', label: 'Free players', hint: 'x', value: { A: 2, B: 1 }, paused: false, ball: false };

function line(id: string, text: string, totalMs = 0, lane: KimiLine['lane'] = 'watch'): KimiLine {
  return {
    id, text, lane, phase: 'none', mentions: [], snapshotT: 0,
    stamp: { provider: 'x', lane, ttftMs: 0, totalMs, tokensIn: 0, tokensOut: 0, tokPerS: 0, framesSent: 0 },
  } as KimiLine;
}

describe('HudStore side feed', () => {
  let store: HudStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new HudStore();
  });

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  it('appends a streamed line once and replaces it in place by id', () => {
    store.message({ kind: 'line', line: line('k1', 'Blue press') });
    expect(store.m.feed).toHaveLength(1);
    expect(store.m.feed[0]).toMatchObject({ id: 'k1', kind: 'kimi', text: 'Blue press', final: false });

    store.message({ kind: 'line', line: line('k1', 'Blue presses high up the pitch', 420) });
    expect(store.m.feed).toHaveLength(1);
    expect(store.m.feed[0]).toMatchObject({ id: 'k1', text: 'Blue presses high up the pitch', final: true });
  });

  it('strips a half-streamed mention from the feed text', () => {
    store.message({ kind: 'line', line: line('k2', 'Blue press [[1') });
    expect(store.m.feed).toHaveLength(1);
    expect(store.m.feed[0]!.text.trimEnd()).toBe('Blue press');
  });

  it('caps the feed at FEED_MAX and drops the oldest bubbles', () => {
    for (let i = 0; i < FEED_MAX + 3; i++) store.message({ kind: 'line', line: line(`l${i}`, `line ${i}`) });
    expect(store.m.feed).toHaveLength(FEED_MAX);
    expect(store.m.feed[0]!.id).toBe('l3');
    expect(store.m.feed[FEED_MAX - 1]!.id).toBe(`l${FEED_MAX + 2}`);
  });

  it('submitAsk adds a you bubble and marks the ask pending, a non-empty ask line resolves it', () => {
    store.message({ kind: 'typing', on: true });
    store.submitAsk('Who is free?');
    const you = store.m.feed.find((f) => f.kind === 'you');
    expect(you).toMatchObject({ kind: 'you', text: 'Who is free?' });
    expect(store.m.askPending).toBe(true);
    expect(store.m.askQuestion).toBe('Who is free?');

    store.message({ kind: 'line', line: line('a1', 'Red has two free players.', 300, 'ask') });
    expect(store.m.askPending).toBe(false);
    expect(store.m.typing).toBe(false);
  });

  it('an unanswered ask gets a timeout note after ASK_TIMEOUT_MS', () => {
    store.submitAsk('Who is free?');
    vi.advanceTimersByTime(ASK_TIMEOUT_MS - 1);
    expect(store.m.askPending).toBe(true);
    vi.advanceTimersByTime(1);
    expect(store.m.askPending).toBe(false);
    const note = store.m.feed.find((f) => f.id === 'ask-timeout');
    expect(note).toMatchObject({ kind: 'sys' });
  });

  it('feed_note adds a sys bubble, clears the pending ask, and replaces by id', () => {
    store.submitAsk('Who is free?');
    store.message({ kind: 'feed_note', id: 'ask-error', text: 'boom' });
    expect(store.m.askPending).toBe(false);
    expect(store.m.feed.filter((f) => f.id === 'ask-error')).toEqual([
      expect.objectContaining({ kind: 'sys', text: 'boom' }),
    ]);

    store.message({ kind: 'feed_note', id: 'ask-error', text: 'boom again' });
    const matches = store.m.feed.filter((f) => f.id === 'ask-error');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe('boom again');
  });

  it('typing on sets the typing bubble, and a non-empty line clears it', () => {
    store.message({ kind: 'typing', on: true });
    expect(store.m.typing).toBe(true);
    store.message({ kind: 'line', line: line('t1', 'Red is pressing.') });
    expect(store.m.typing).toBe(false);
  });

  it('late marks the matching feed bubble', () => {
    store.message({ kind: 'line', line: line('late1', 'Blue shape is stretched.') });
    store.message({ kind: 'late', lineId: 'late1', lateS: 2 });
    expect(store.m.feed.find((f) => f.id === 'late1')!.late).toBe(2);
  });

  it('hud_reset clears the feed, typing, pending ask and stat cards', () => {
    store.message({ kind: 'line', line: line('r1', 'Blue press') });
    store.message({ kind: 'typing', on: true });
    store.submitAsk('Who is free?');
    // Stat cards need stats, so inject a tile and pop it directly.
    (store as any).m = { ...store.m, state: 'LIVE', tiles: [FREE] };
    (store as any).popTiles();
    expect(store.m.tilesOn).toBe(true);

    store.message({ kind: 'hud_reset' });
    expect(store.m.feed).toHaveLength(0);
    expect(store.m.typing).toBe(false);
    expect(store.m.askPending).toBe(false);
    expect(store.m.tilesOn).toBe(false);
  });

  it('stat cards linger for STAT_LINGER_MS and do nothing when there are no tiles', () => {
    store.setLayout('full', false);
    (store as any).m = { ...store.m, state: 'LIVE', tiles: [FREE] };
    (store as any).popTiles();
    expect(store.m.tilesOn).toBe(true);
    vi.advanceTimersByTime(STAT_LINGER_MS - 1);
    expect(store.m.tilesOn).toBe(true);
    vi.advanceTimersByTime(2);
    expect(store.m.tilesOn).toBe(false);

    (store as any).m = { ...store.m, tiles: [] };
    (store as any).popTiles();
    expect(store.m.tilesOn).toBe(false);
  });

  it('stat cards stay for STAT_LINGER_MS even if the tiles or the state change mid-linger', () => {
    (store as any).m = { ...store.m, state: 'LIVE', tiles: [FREE] };
    (store as any).popTiles();
    vi.advanceTimersByTime(1000);
    (store as any).m = { ...store.m, tiles: [], state: 'CLOSE_UP' };
    vi.advanceTimersByTime(STAT_LINGER_MS - 1000 - 1);
    expect(store.m.tilesOn).toBe(true);
    expect(store.m.shownTiles).toEqual([FREE]);
    vi.advanceTimersByTime(1);
    expect(store.m.tilesOn).toBe(false);
    expect(store.m.shownTiles).toEqual([FREE]);
  });

  it('a second pop during the linger does not extend or restart it', () => {
    (store as any).m = { ...store.m, state: 'LIVE', tiles: [FREE] };
    (store as any).popTiles();
    vi.advanceTimersByTime(3000);
    (store as any).popTiles();
    vi.advanceTimersByTime(STAT_LINGER_MS - 3000 - 1);
    expect(store.m.tilesOn).toBe(true);
    vi.advanceTimersByTime(1);
    expect(store.m.tilesOn).toBe(false);
  });

  it('does not pop in CLOSE_UP', () => {
    (store as any).m = { ...store.m, state: 'CLOSE_UP', tiles: [FREE] };
    (store as any).popTiles();
    expect(store.m.tilesOn).toBe(false);
    expect(store.m.shownTiles).toEqual([]);
  });

  it('a Kimi tiles message within STAT_MIN_GAP_MS of the cards hiding does not pop them', () => {
    (store as any).m = { ...store.m, state: 'LIVE' };
    (store as any).statsSnap = {
      pressure: { value: { A: 1, B: 1 }, gate: 'full', paused: false },
      freePlayers: { value: { A: 2, B: 1 }, gate: 'full', paused: false },
    };
    store.message({ kind: 'tiles', keys: ['pressure'] });
    expect(store.m.tilesOn).toBe(true);
    vi.advanceTimersByTime(STAT_LINGER_MS);
    expect(store.m.tilesOn).toBe(false);

    vi.advanceTimersByTime(1000);
    store.message({ kind: 'tiles', keys: ['freePlayers'] });
    expect(store.m.tilesOn).toBe(false);
    expect(store.m.tiles.map((t) => t.key)).toEqual(['freePlayers']);

    vi.advanceTimersByTime(STAT_MIN_GAP_MS - 1000);
    store.message({ kind: 'tiles', keys: ['freePlayers'] });
    expect(store.m.tilesOn).toBe(true);
    expect(store.m.shownTiles.map((t) => t.key)).toEqual(['freePlayers']);
  });
});
