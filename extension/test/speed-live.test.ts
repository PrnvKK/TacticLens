import { afterEach, describe, expect, it } from 'vitest';
import { configureGpuBaseline, type LLMEvent, type PresetId } from '@tacticlens/core';
import { feedStamped } from '../lib/speed/feed';
import { resolveBurstTarget, speedParams } from '../lib/speed/params';
import { driveRace, racePrep, RACE_PROMPT, type RacePort } from '../lib/speed/race-live';
import { toLocalClock } from '../lib/speed/receipt';
import { RaceStore, SpeedStore } from '../lib/speed/store';

const ORIGIN = 1000;                 // page timeOrigin
const stamp = (tRecv: number) => ({ tRecv, tOrigin: 5000 });   // worker timeOrigin
const local = (t: number): number => toLocalClock(t, { tOrigin: 5000 }, ORIGIN);

function done(result: unknown): LLMEvent {
  return { type: 'done', result } as unknown as LLMEvent;
}

function call(store: SpeedStore, id: string, t0: number, opts: { ttft: number; tps: number; tokens: number }): void {
  const tFirst = t0 + opts.ttft;
  store.feed(id, { type: 'start', tRequest: t0 }, {}, t0);
  for (let i = 0; i < opts.tokens; i++) store.feed(id, { type: 'delta', text: 'x' }, {}, tFirst + (i / opts.tps) * 1000);
  store.feed(id, done({
    timing: {
      tRequest: t0, tFirstToken: tFirst, tDone: tFirst + ((opts.tokens - 1) / opts.tps) * 1000,
      tokensOut: opts.tokens, usageReported: true,
    },
  }), {}, tFirst + ((opts.tokens - 1) / opts.tps) * 1000);
}

afterEach(() => configureGpuBaseline(null));

describe('receipt-time wiring', () => {
  it('places worker stamps on the page clock and keeps TTFT separate from TPS', () => {
    let now = 99_999;   // far from the measurement: feed must not use it for the deltas
    const store = new SpeedStore(() => now);
    feedStamped(store, 'c1', { type: 'start', tRequest: 0 }, stamp(0), ORIGIN, { lane: 'director', provider: 'cerebras-kimi' });
    for (const t of [100, 150, 200]) feedStamped(store, 'c1', { type: 'delta', text: 'x' }, stamp(t), ORIGIN);
    feedStamped(store, 'c1', done({
      timing: { tRequest: 0, tFirstToken: 100, tDone: 205, tokensOut: 21, usageReported: true },
    }), stamp(205), ORIGIN);
    const c = store.snapshot().calls[0]!;
    expect(c.id).toBe('c1');
    expect(c.lane).toBe('director');
    expect(c.ttftMs).toBe(100);                    // local first token 4100 - local request 4000
    expect(c.tps).toBeCloseTo(200, 6);             // (21 - 1) / 0.1 s
    expect(c.tokens).toBe(21);                     // usage wins over the 3 deltas
    now = 100_000;
    expect(store.snapshot().lastTtftMs).toBe(100);
  });

  it('ignores an out-of-order final delta instead of shrinking the decode window', () => {
    const store = new SpeedStore(() => 5000);
    store.feed('c2', { type: 'start', tRequest: 100 }, {}, 100);
    for (const t of [200, 230, 220]) store.feed('c2', { type: 'delta', text: 'x' }, {}, t);
    store.feed('c2', done({
      timing: { tRequest: 100, tFirstToken: 200, tDone: 230, tokensOut: 4, usageReported: true },
    }), {}, 230);
    const c = store.snapshot().calls[0]!;
    expect(c.ttftMs).toBe(100);
    expect(c.tps).toBeCloseTo(3 / 0.03, 6);        // last token stays at 230, not 220
  });

  it('puts hidden reasoning tokens inside the decode window (Kimi streams them before the answer)', () => {
    const store = new SpeedStore(() => 5000);
    store.feed('r1', { type: 'start', tRequest: 100 }, {}, 100);
    for (const t of [200, 250, 300]) store.feed('r1', { type: 'reasoning', text: 'thinking' }, {}, t);
    for (const t of [400, 450, 500]) store.feed('r1', { type: 'delta', text: 'x' }, {}, t);
    store.feed('r1', done({
      timing: { tRequest: 100, tFirstToken: 400, tDone: 505, tokensOut: 60, usageReported: true },
    }), {}, 505);
    const c = store.snapshot().calls[0]!;
    expect(c.ttftMs).toBe(100);                    // 200 - 100: first generated token, not the first visible one
    expect(c.tps).toBeCloseTo(59 / 0.3, 6);        // 60 output tokens over 200..500 ms
    expect(c.tokens).toBe(60);
  });

  it('a reordered start does not discard tokens and keeps the earlier request stamp', () => {
    const store = new SpeedStore(() => 5000);
    store.feed('c3', { type: 'delta', text: 'x' }, {}, 4200);
    store.feed('c3', { type: 'delta', text: 'x' }, {}, 4300);
    store.feed('c3', { type: 'start', tRequest: 4000 }, {}, 4300);
    const live = store.snapshot(4300);
    expect(live.active).toBe(1);
    expect(store.tracker.meter('c3')!.tokens).toBe(2);
    store.feed('c3', done({
      timing: { tRequest: 4000, tFirstToken: 4200, tDone: 4300, tokensOut: 2, usageReported: true },
    }), {}, 4300);
    const c = store.snapshot(4300).calls[0]!;
    expect(c.ttftMs).toBe(200);
    expect(c.tps).toBeCloseTo(10, 6);
  });
});

describe('session peak', () => {
  it('remembers the TTFT of the call that set the peak, and p50 TTFT', () => {
    const store = new SpeedStore(() => 60_000);
    call(store, 'slow', 0, { ttft: 900, tps: 1000, tokens: 40 });
    call(store, 'fast', 20_000, { ttft: 250, tps: 3000, tokens: 40 });
    const s = store.snapshot();
    expect(s.peakTps).toBeCloseTo(3000, 0);
    expect(s.peakTtftMs).toBe(250);
    expect(s.ttftP50Ms).toBe(250);                 // nearest-rank p50 of [900, 250]
  });
});

describe('speed URL switches', () => {
  it('maps speed views, keeps the legacy mode and the record/autorace flags', () => {
    expect(speedParams('').view).toBe('compact');
    expect(speedParams('?speed=wall').view).toBe('wall');
    expect(speedParams('?speed=race').view).toBe('race');
    expect(speedParams('?speed=burst').view).toBe('burst');
    expect(speedParams('?mock=1&mode=race').view).toBe('race');
    expect(speedParams('?speed=race&autorace=1&record=1')).toMatchObject({ view: 'race', autorace: true, record: true, mock: false });
    expect(speedParams('?speed=burst&peak=3210').peak).toBe(3210);
    expect(speedParams('?speed=burst&peak=oops').peak).toBeNull();
  });
});

describe('intro burst target', () => {
  it('uses a real session peak or a real provided value, never a default', () => {
    expect(resolveBurstTarget(null, 0)).toBeNull();
    expect(resolveBurstTarget(null, 3280)).toBe(3280);
    expect(resolveBurstTarget(2100, 3280)).toBe(2100);
    expect(resolveBurstTarget(Number.NaN, 0)).toBeNull();
  });
});

describe('race preparation', () => {
  it('reports the GPU baseline as not configured when its key is missing', () => {
    const prep = racePrep({ 'cerebras-kimi': true }, 'moonshotai-kimi-k3.1-pro');
    expect(prep.a.configured).toBe(true);
    expect(prep.b.configured).toBe(false);
    expect(prep.ready).toBe(false);
    expect(prep.note).toBe('GPU baseline not configured');
  });

  it('blocks when the Cerebras side has no key or no model id', () => {
    expect(racePrep({}).note).toBe('Cerebras key not configured');
    expect(racePrep({ 'cerebras-kimi': true }, '').note).toBe('Cerebras key not configured');
  });

  it('labels the GPU lane from the configured provider, not a constant', () => {
    configureGpuBaseline({ provider: 'openrouter', model: 'moonshotai/kimi-k3.1-pro' });
    const prep = racePrep({ 'cerebras-kimi': true, 'gpu-baseline': true }, 'moonshotai-kimi-k3.1-pro');
    expect(prep.ready).toBe(true);
    expect(prep.a.label).toBe('CEREBRAS KIMI');
    expect(prep.b.label).toBe('OPENROUTER');
    expect(prep.b.sub).toBe('moonshotai/kimi-k3.1-pro');
  });
});

describe('driveRace', () => {
  function prep() {
    configureGpuBaseline({ provider: 'openrouter', model: 'moonshotai/kimi-k3.1-pro' });
    return racePrep({ 'cerebras-kimi': true, 'gpu-baseline': true } as Partial<Record<PresetId, boolean>>, 'moonshotai-kimi-k3.1-pro');
  }

  function port(requests: string[]): { port: RacePort; emit: (side: 'a' | 'b', e: LLMEvent, s?: { tRecv: number; tOrigin: number }) => void } {
    let emit!: (side: 'a' | 'b', e: LLMEvent, s?: { tRecv: number; tOrigin: number }) => void;
    const p: RacePort = {
      start(_a, _b, req, onEvent) {
        const first = req.messages[0];
        requests.push(typeof first?.content === 'string' ? first.content : JSON.stringify(first?.content));
        emit = onEvent;
        return { done: new Promise(() => undefined), cancel: () => undefined };
      },
    };
    return { port: p, emit: (side, e, s) => emit(side, e, s) };
  }

  it('feeds both lanes with receipt times and uses usage completion tokens', () => {
    const requests: string[] = [];
    const { port: p, emit } = port(requests);
    const race = new RaceStore(() => 5000);
    const h = driveRace(race, p, prep(), { localOrigin: ORIGIN });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toBe(RACE_PROMPT);

    emit('a', { type: 'start', tRequest: 0 }, stamp(0));
    for (const t of [100, 150, 200]) emit('a', { type: 'delta', text: 'ab' }, stamp(t));
    emit('a', done({
      ok: true, aborted: false, status: 200, text: 'ab', parsed: undefined, parseOk: false,
      timing: { provider: 'gpu-baseline:openrouter', tRequest: 0, tFirstToken: 100, tDone: 205, tokensOut: 41, usageReported: true },
    }), stamp(205));

    const v = race.view(5000);
    expect(v.a.text).toBe('ababab');
    expect(v.a.tokens).toBe(41);
    expect(v.a.ttftMs).toBe(100);
    expect(v.a.tps).toBeCloseTo(400, 6);          // (41-1) / 0.1 s
    expect(v.a.elapsedMs).toBe(205);
    expect(v.a.done).toBe(true);
    expect(v.b.tokens).toBe(0);                   // no numbers for the lane that produced none
    expect(v.b.ttftMs).toBeNull();
    h.cancel();
  });

  it('surfaces a failed lane instead of showing zeros as a result', () => {
    const { port: p, emit } = port([]);
    const race = new RaceStore(() => 5000);
    driveRace(race, p, prep(), { localOrigin: ORIGIN });
    emit('b', { type: 'error', error: 'HTTP 401 invalid key', status: 401 }, stamp(10));
    const v = race.view(5000);
    expect(v.b.error).toBe('HTTP 401 invalid key');
    expect(v.b.done).toBe(true);
  });
});
