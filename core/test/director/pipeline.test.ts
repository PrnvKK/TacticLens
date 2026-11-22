import { describe, expect, it } from 'vitest';
import type { MatchState } from '../../src/types';
import type { EngineOutput } from '../../src/engine';
import { emptyFacts } from '../../src/engine';
import { BudgetGovernor, SpeedMeter } from '../../src/llm/budget';
import { PromptBuilder } from '../../src/llm/cache/builder';
import { KIMI_PROMPT_SPEC } from '../../src/director/kimiPrompt';
import { DirectorPipeline, type PipelineCaller } from '../../src/director/pipeline';
import { WatchLane } from '../../src/director/watch';
import type { DirectorCallResult, DirectorContext } from '../../src/director/director';
import type { FreshState } from '../../src/director/pipeline';
import type { GraphicsMenu } from '../../src/director/types';
import { resolveProvider, streamChat } from '../../src/llm';
import type { CallTiming } from '../../src/llm/timing';

function facts() {
  const f = emptyFacts();
  f.overload = { ...f.overload, valid: true, confidence: 0.82, sinceS: 4, team: 'A', attackers: 3, defenders: 2, near: [1, 2, 3, 11, 12], targets: [1, 2, 3, 11, 12] };
  return f;
}
const match = { possession: { value: { A: 57, B: 43, current: 'A' } }, scout: null, liveness: 'LIVE' } as unknown as MatchState;
const output = (): EngineOutput => ({ match, events: [], detail: { facts: facts() } } as unknown as EngineOutput);
const ctx = (): DirectorContext => ({
  nowS: 100, t: 100, playbackRate: 1, liveness: 'LIVE', scene: 'WIDE', ballState: 'visible', ballXY: [0.31, 0.6],
  match, out: output(), events: [], liveIds: [1, 2, 3, 11, 12], onScreen: null, sinceLastGraphicS: 12, calm: { ready: true, reason: 'calm ready' },
});
const show = { action: 'show', graphic: 'overload', targets: [1, 2, 3], caption: 'three on two', say: '', duration_s: 5, confidence: 0.8 };
const none = { action: 'none', graphic: 'none', targets: [], caption: '', say: '', duration_s: 5, confidence: 0.5 };

function timing(over: Partial<CallTiming> = {}): CallTiming {
  return { provider: 't', lane: 'director', tRequest: 0, tFirstByte: 1, tFirstToken: 2, tDone: 3, ttftMs: 600, totalMs: 900, tokensIn: 3000, tokensOut: 100, cachedTokens: 2048, tokPerS: 100, framesSent: 0, usageReported: true, ...over };
}

describe('DirectorPipeline newest-wins', () => {
  function wallClock() { let t = 0; return { now: () => t, adv: (ms: number) => { t += ms; } }; }
  async function flush(n = 8) { for (let i = 0; i < n; i++) await Promise.resolve(); }
  function rig(opts: {
    budget?: BudgetGovernor; maxInFlight?: number;
    queueRetry?: { maxRetries?: number; sleep?: (ms: number) => Promise<void>; random?: () => number };
    clock?: { now: () => number; adv: (ms: number) => void };
  } = {}) {
    let wall = 0;
    const clock = opts.clock ?? { now: () => wall, adv: (ms: number) => { wall += ms; } };
    const calls: { resolve: (r: DirectorCallResult) => void; emit: (v: unknown) => void; signal: { aborted: boolean } }[] = [];
    const caller: PipelineCaller = (_req, onEvent, ctl) => new Promise<DirectorCallResult>((resolve) => {
      calls.push({ resolve, signal: ctl.signal, emit: (v) => onEvent({ type: 'json', value: v }) });
    });
    const outcomes: { seq: number; action: string; accepted: boolean; reason?: string }[] = [];
    const discards: { seq: number; reason: string }[] = [];
    const speed = new SpeedMeter(clock.now);
    const p = new DirectorPipeline(caller, {
      builder: new PromptBuilder(KIMI_PROMPT_SPEC, { model: 'm' }), now: clock.now, speed, staleS: 30,
      maxInFlight: opts.maxInFlight ?? 4, budget: opts.budget, queueRetry: opts.queueRetry,
      onOutcome: (o, m) => outcomes.push({ seq: m.seq, action: o.log.action, accepted: o.accepted, reason: o.reason }),
      onDiscard: (seq, reason) => discards.push({ seq, reason }),
    });
    return { p, calls, outcomes, discards, adv: clock.adv, speed, flush };
  }

  it('can omit the API response schema for the live budget (prompt schema still cached)', () => {
    const seen: import('../../src/llm/providers').LLMRequest[] = [];
    const p = new DirectorPipeline((req) => { seen.push(req); return new Promise<DirectorCallResult>(() => undefined); }, {
      builder: new PromptBuilder(KIMI_PROMPT_SPEC, { model: 'm' }), strictSchema: false, maxInFlight: 2,
    });
    p.pump(ctx());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.schema).toBeNull();
    expect(String(seen[0]!.messages[0]!.content)).toContain('OUTPUT SCHEMAS');
    p.cancelAll();
  });

  it('launches a call every ~330 ms with up to 4 in flight and never more', () => {
    const r = rig();
    expect(r.p.pump(ctx())).toBe(1);
    expect(r.p.pump(ctx())).toBeNull();            // too soon
    r.adv(330);
    expect(r.p.pump(ctx())).toBe(2);
    r.adv(330); expect(r.p.pump(ctx())).toBe(3);
    r.adv(330); expect(r.p.pump(ctx())).toBe(4);
    r.adv(330); expect(r.p.pump(ctx())).toBeNull(); // cap of 4 in flight
    expect(r.p.inFlight).toBe(4);
  });

  it('applies the newest-started result and discards older ones that arrive later', async () => {
    const r = rig();
    for (let i = 0; i < 3; i++) { r.p.pump(ctx()); r.adv(330); }
    // Results arrive out of order: 3rd, then 1st, then 2nd.
    r.calls[2]!.emit(none);
    r.calls[0]!.emit(show);
    r.calls[1]!.emit(show);
    expect(r.outcomes.map((o) => o.seq)).toEqual([3]);
    expect(r.discards.map((d) => `${d.seq}:${d.reason}`)).toEqual(['1:superseded', '2:superseded']);
    expect(r.p.stats.applied).toBe(1);
    expect(r.p.stats.discarded).toBe(2);
    // Older calls keep running (the server bills them and only a finished response reports real usage).
    expect(r.calls.every((c) => !c.signal.aborted)).toBe(true);
  });

  it('applies a result when the JSON closes, before the call (usage) finishes; the final result is not applied twice', async () => {
    const r = rig();
    r.p.pump(ctx());
    r.calls[0]!.emit(show);
    expect(r.outcomes).toHaveLength(1);
    expect(r.outcomes[0]).toMatchObject({ action: 'show', accepted: true });
    r.calls[0]!.resolve({ status: 'ok', parsed: show, timing: timing() });
    await Promise.resolve();
    expect(r.outcomes).toHaveLength(1);
    expect(r.p.shown.get('overload')).toBeDefined();
  });

  it('newer-started result that arrives first wins even if an older result is valid', async () => {
    const r = rig();
    r.p.pump(ctx()); r.adv(330); r.p.pump(ctx());
    r.calls[1]!.resolve({ status: 'ok', parsed: none, timing: timing() });
    await Promise.resolve(); await Promise.resolve();
    r.calls[0]!.resolve({ status: 'ok', parsed: show, timing: timing() });
    await Promise.resolve(); await Promise.resolve();
    expect(r.outcomes.map((o) => `${o.seq}:${o.action}`)).toEqual(['2:none']);
    expect(r.p.shown.size).toBe(0);
  });

  it('every applied result still goes through the validator and the calm gate', () => {
    const r = rig();
    r.p.pump(ctx());
    r.calls[0]!.emit({ ...show, graphic: 'spotlight' });   // not in the menu
    expect(r.outcomes[0]!.accepted).toBe(false);
    expect(r.outcomes[0]!.reason).toMatch(/not in menu/);
    r.adv(330);
    const busy = rig();
    busy.p.pump({ ...ctx(), calm: { ready: false, reason: 'busy' } });
    busy.calls[0]!.emit(show);
    expect(busy.outcomes[0]!.reason).toMatch(/calm/);
  });

  it('uses fresh state at arrival: a graphic shown meanwhile blocks a second show', () => {
    const outcomes: { reason?: string; accepted: boolean }[] = [];
    const h: { cb?: (v: unknown) => void } = {};
    const caller: PipelineCaller = (_r, onEvent) => { h.cb = (v) => onEvent({ type: 'json', value: v }); return new Promise(() => undefined); };
    const p = new DirectorPipeline(caller, {
      builder: new PromptBuilder(KIMI_PROMPT_SPEC, { model: 'm' }), staleS: 30,
      fresh: () => ({ liveIds: [1, 2, 3, 11, 12], onScreen: { id: 'overload', sinceS: 1 }, calm: { ready: true, reason: '' }, playbackRate: 1 }),
      onOutcome: (o) => outcomes.push({ reason: o.reason, accepted: o.accepted }),
    });
    expect(p.pump(ctx())).toBe(1);
    h.cb!(show);
    expect(outcomes[0]).toMatchObject({ accepted: false });
    expect(outcomes[0]!.reason).toMatch(/already on screen/);
  });

  it('a 429 backs the director lane off through the budget governor and nothing is queued', async () => {
    const c = wallClock();
    const budget = new BudgetGovernor({ now: c.now, random: () => 0.5 });
    const r = rig({ budget, clock: c });
    expect(r.p.pump(ctx())).toBe(1);
    r.calls[0]!.resolve({ status: 'error', error: 'HTTP 429 slow down', statusCode: 429, errorKind: 'rate_limited' });
    await r.flush();
    expect(r.p.stats.rate429).toBe(1);
    expect(budget.backoffLeftMs('director')).toBeGreaterThan(0);
    expect(r.p.pump(ctx())).toBeNull();
    expect(r.p.pump(ctx(), true)).toBeNull();
  });

  it('queue_full retries the same call and never backs the lane off', async () => {
    const c = wallClock();
    const budget = new BudgetGovernor({ now: c.now, random: () => 0.5 });
    const r = rig({ budget, clock: c, queueRetry: { sleep: async () => undefined } });
    expect(r.p.pump(ctx())).toBe(1);
    r.calls[0]!.resolve({ status: 'error', error: 'HTTP 429 queue_exceeded', statusCode: 429, errorKind: 'queue_full', errorCode: 'queue_exceeded' });
    await r.flush();
    expect(r.calls).toHaveLength(2);                  // the same logical call was retried
    expect(r.p.stats.queueRetries).toBe(1);
    r.calls[1]!.resolve({ status: 'ok', parsed: none, timing: timing() });
    await r.flush();
    expect(r.p.stats.rate429).toBe(0);
    expect(r.p.stats.queueFull).toBe(0);
    expect(budget.backoffLeftMs('director')).toBe(0);
    expect(r.outcomes.map((o) => o.seq)).toEqual([1]);
  });

  it('a queue_full that exhausts retries is not a lane backoff either', async () => {
    const c = wallClock();
    const budget = new BudgetGovernor({ now: c.now, random: () => 0.5, baseDirectorHz: 3 });
    const r = rig({ budget, clock: c, queueRetry: { maxRetries: 0 } });
    expect(r.p.pump(ctx())).toBe(1);
    r.calls[0]!.resolve({ status: 'error', error: 'HTTP 429 queue_exceeded', errorKind: 'queue_full' });
    await r.flush();
    expect(r.p.stats.queueFull).toBe(1);
    expect(r.p.stats.rate429).toBe(0);
    expect(budget.backoffLeftMs('director')).toBe(0);
    r.adv(340);
    expect(r.p.pump(ctx())).toBe(2);
  });

  it('drops a retry when a newer call started while it was waiting', async () => {
    const c = wallClock();
    let release!: () => void;
    const sleep = new Promise<void>((res) => { release = res; });
    const budget = new BudgetGovernor({ now: c.now, random: () => 0.5, baseDirectorHz: 3 });
    const r = rig({ budget, clock: c, queueRetry: { sleep: () => sleep } });
    expect(r.p.pump(ctx())).toBe(1);
    r.adv(340);
    expect(r.p.pump(ctx())).toBe(2);                   // newer call starts
    r.calls[0]!.resolve({ status: 'error', error: 'HTTP 429 queue_exceeded', errorKind: 'queue_full' });
    await r.flush();
    release();                                          // the retry is now due, but stale
    await r.flush();
    expect(r.calls).toHaveLength(2);                    // no third (retried) call was launched
    expect(r.p.stats.queueRetries).toBe(0);
    expect(r.speed.queue.retriesDropped).toBe(1);
    expect(r.speed.queue.retries).toBe(0);
    expect(budget.backoffLeftMs('director')).toBe(0);
  });

  it('raises in-flight to the budget cap while the shared queue is congested', async () => {
    const c = wallClock();
    const r = rig({ clock: c });
    r.p.pump(ctx()); c.adv(1000);
    r.calls[0]!.resolve({ status: 'ok', parsed: none, timing: timing() });
    await r.flush();
    c.adv(400);
    r.p.pump(ctx()); c.adv(1000);
    r.calls[1]!.resolve({ status: 'ok', parsed: none, timing: timing() });
    await r.flush();
    expect(r.p.latency.count).toBe(2);
    expect(r.p.maxInFlightNow).toBe(4);
    for (let i = 0; i < 11; i++) r.speed.queue.noteAttempt('queue_full');
    expect(r.speed.queue.congested()).toBe(true);
    expect(r.p.maxInFlightNow).toBe(8);
  });

  it('feeds real usage into the budget governor', async () => {
    const budget = new BudgetGovernor({});
    const r = rig({ budget });
    r.p.pump(ctx());
    r.calls[0]!.resolve({ status: 'ok', parsed: none, timing: timing() });
    await r.flush();
    const s = budget.snapshot();
    expect(s.requestsPerMin).toBe(1);
    expect(s.cachedPct).toBe(Math.round((2048 / 3000) * 100));
    expect(s.uncachedPerMin).toBe(952 + 100);
  });
});

describe('adaptive latency (works at 1 s and 20 s)', () => {
  interface Call { resolve: (r: DirectorCallResult) => void; emit: (v: unknown) => void }
  function adaptiveRig(opts: { fresh?: () => FreshState | null } = {}) {
    let wall = 0;
    const calls: Call[] = [];
    const outcomes: { seq: number; action: string; accepted: boolean; reason?: string }[] = [];
    const caller: PipelineCaller = (_req, onEvent, ctl) => new Promise<DirectorCallResult>((resolve) => {
      calls.push({ resolve, emit: (v) => onEvent({ type: 'json', value: v }) });
    });
    const p = new DirectorPipeline(caller, {
      builder: new PromptBuilder(KIMI_PROMPT_SPEC, { model: 'm' }), now: () => wall, maxInFlight: 4, maxInFlightCap: 8,
      fresh: opts.fresh,
      onOutcome: (o, m) => outcomes.push({ seq: m.seq, action: o.log.action, accepted: o.accepted, reason: o.reason }),
    });
    const adv = (ms: number) => { wall += ms; };
    async function deliver(v: unknown): Promise<void> {
      const c = calls[calls.length - 1]!;
      c.emit(v);
      c.resolve({ status: 'ok', parsed: v, timing: timing() });
      await Promise.resolve(); await Promise.resolve();
    }
    async function feed(latencies: number[]): Promise<void> {
      for (const ms of latencies) {
        expect(p.pump(ctx())).not.toBeNull();
        adv(ms);
        await deliver(none);
      }
    }
    return { p, calls, outcomes, adv, deliver, feed };
  }

  it('derives stale = clamp(1.5 x p90, 3, 30), interval and in-flight from real latency', async () => {
    const fast = adaptiveRig();
    await fast.feed([1000, 1000, 1000, 1000, 1000]);
    expect(fast.p.latency.p50()).toBe(1000);
    expect(fast.p.staleLimitS).toBe(3);
    expect(fast.p.maxInFlightNow).toBe(4);
    expect(fast.p.launchIntervalMs).toBe(330);
    expect(fast.p.pump(ctx())).toBe(6);
    fast.adv(4000);                 // 4 s > 3 s stale limit
    await fast.deliver(none);
    expect(fast.outcomes[fast.outcomes.length - 1]).toMatchObject({ accepted: false, reason: expect.stringMatching(/stale/) });
    expect(fast.p.stats.stale).toBe(1);

    const slow = adaptiveRig();
    await slow.feed([20_000, 20_000, 20_000, 20_000, 20_000]);
    expect(slow.p.latency.p50()).toBe(20_000);
    expect(slow.p.staleLimitS).toBe(30);
    expect(slow.p.maxInFlightNow).toBe(8);
    expect(slow.p.launchIntervalMs).toBe(2500);
    expect(slow.p.pump(ctx())).toBe(6);
    slow.adv(10_000);               // 10 s is still inside the 30 s stale limit
    await slow.deliver(none);
    expect(slow.outcomes[slow.outcomes.length - 1]).toMatchObject({ accepted: true });

    expect(slow.p.pump(ctx())).toBe(7);
    slow.adv(31_000);               // older than 30 s: the moment has passed
    await slow.deliver(none);
    expect(slow.outcomes[slow.outcomes.length - 1]).toMatchObject({ accepted: false, reason: expect.stringMatching(/stale/) });
  });

  it('re-validates on arrival against the current menu, live tracks and calm gate', async () => {
    const baseMenu: GraphicsMenu = {
      t: 100,
      items: [{
        id: 'overload', label: '3 v 2 overload', kind: 'overload', targets: [1, 2, 3, 11, 12], team: 'A',
        fact: { valid: true, confidence: 0.8, sinceS: 3, targets: [1, 2, 3, 11, 12] },
        data: { attackers: 3, defenders: 2 },
      }],
    };
    const fresh = (over: Partial<FreshState> = {}): FreshState => ({
      liveIds: [1, 2, 3, 11, 12], onScreen: null, calm: { ready: true, reason: '' }, playbackRate: 1, menu: baseMenu, ...over,
    });

    const invalid = adaptiveRig({ fresh: () => fresh({ menu: { ...baseMenu, items: [{ ...baseMenu.items[0]!, fact: { ...baseMenu.items[0]!.fact, valid: false } }] } }) });
    invalid.p.pump(ctx());
    await invalid.deliver(show);
    expect(invalid.outcomes[0]).toMatchObject({ accepted: false, reason: expect.stringMatching(/no longer valid/) });

    const dead = adaptiveRig({ fresh: () => fresh({ liveIds: [1, 2] }) });
    dead.p.pump(ctx());
    await dead.deliver(show);
    expect(dead.outcomes[0]).toMatchObject({ accepted: false, reason: expect.stringMatching(/not live/) });

    const busy = adaptiveRig({ fresh: () => fresh({ calm: { ready: false, reason: 'pan 400px/s' } }) });
    busy.p.pump(ctx());
    await busy.deliver(show);
    expect(busy.outcomes[0]).toMatchObject({ accepted: false, reason: expect.stringMatching(/calm/) });
  });
});

describe('watch lane 429 policy', () => {
  it('never backs off on queue_full, still backs off on rate_limited', async () => {
    let wall = 0;
    const builder = new PromptBuilder(KIMI_PROMPT_SPEC, { model: 'm' });
    const speed = new SpeedMeter(() => wall);
    const queueBudget = new BudgetGovernor({ now: () => wall, random: () => 0.5, baseDirectorHz: 3 });
    const queueWatch = new WatchLane(
      async () => ({ status: 'error', error: 'HTTP 429 queue_exceeded', errorKind: 'queue_full' }),
      { builder, budget: queueBudget, speed, queueRetry: { maxRetries: 0 } },
    );
    expect(await queueWatch.tick('data:image/jpeg;base64,AAAA', { t: 100, ids: [1, 2, 3] })).toBe(true);
    expect(queueWatch.stats.queueFull).toBe(1);
    expect(queueBudget.backoffLeftMs('watch')).toBe(0);

    const rateBudget = new BudgetGovernor({ now: () => wall, random: () => 0.5, baseDirectorHz: 3 });
    const rateWatch = new WatchLane(
      async () => ({ status: 'error', error: 'HTTP 429 slow down', errorKind: 'rate_limited' }),
      { builder, budget: rateBudget, speed },
    );
    await rateWatch.tick('data:image/jpeg;base64,AAAA', { t: 100, ids: [1, 2, 3] });
    expect(rateBudget.backoffLeftMs('watch')).toBeGreaterThan(0);
  });
});

describe('mock end to end (offline, simulated cache and latency)', () => {
  it('runs the director pipeline and the watch lane through the real client with a simulated prefix cache', async () => {
    const provider = resolveProvider('mock', '');
    const profile = { ttftMs: 40, warmTtftMs: 15, tokPerS: 20000, jitter: 0 };
    const builder = new PromptBuilder(KIMI_PROMPT_SPEC, { model: 'mock' });
    const budget = new BudgetGovernor({ baseDirectorHz: 30, baseWatchHz: 30 });
    const speed = new SpeedMeter();
    const caller: PipelineCaller = async (req, onEvent) => {
      const r = await streamChat({ provider, request: req, mockProfile: profile, onEvent });
      return { status: r.ok ? 'ok' : 'error', parsed: r.parsed, timing: r.timing, error: r.error };
    };
    const watch = new WatchLane(async (req, onEvent) => {
      const r = await streamChat({ provider, request: req, mockProfile: profile, onEvent });
      return { status: r.ok ? 'ok' : 'error', parsed: r.parsed, timing: r.timing, error: r.error };
    }, { builder, budget, speed });
    const outcomes: { accepted: boolean; action: string }[] = [];
    const pipe = new DirectorPipeline(caller, {
      builder, budget, speed, intervalMs: 1, staleS: 30, seen: () => watch.seen(), onOutcome: (o) => outcomes.push({ accepted: o.accepted, action: o.log.action }),
    });
    expect(await watch.tick('data:image/jpeg;base64,AAAA', { t: 100, ids: [1, 2, 3] })).toBe(true);
    expect(watch.seen()).toMatch(/pressure/);
    const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(() => r(), ms); });
    for (let i = 0; i < 12; i++) { pipe.pump(ctx()); await sleep(12); }
    await sleep(200);
    expect(outcomes.length).toBeGreaterThan(3);
    expect(outcomes.every((o) => ['show', 'none', 'keep', 'hide'].includes(o.action))).toBe(true);
    expect(pipe.stats.schemaInvalid).toBe(0);
    const snap = budget.snapshot();
    expect(snap.requestsPerMin).toBeGreaterThan(3);
    expect(snap.cachedPct).toBeGreaterThan(0);          // the simulated prefix cache hit
    expect(speed.decisionsPerS()).toBeGreaterThan(0);
    // The tail carried the watch observation and recent decisions, not the stable prefix.
    expect(watch.stats.ok).toBe(1);
  });
});
