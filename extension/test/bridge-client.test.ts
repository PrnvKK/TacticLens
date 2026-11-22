import { describe, expect, it, vi } from 'vitest';
import { BridgeClient } from '../lib/bridge/client';
import type { BridgeState } from '../lib/bridge/types';

function state(over: Partial<BridgeState> = {}): BridgeState {
  return {
    t: 12,
    tMedia: 12,
    wallMs: 0,
    clock: '0:12',
    liveness: 'LIVE',
    scene: 'WIDE',
    paused: false,
    playing: true,
    halfTime: false,
    ball: { state: 'visible', coastingS: 0, visibility: 1, xy: [0.5, 0.5] },
    possession: { A: 55, B: 45, current: 'A' },
    stats: { possession: { value: { A: 55, B: 45 }, gate: 'shown', confidence: 0.9 } },
    teamNames: { A: 'Arsenal', B: 'Chelsea' },
    events: [],
    ...over,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('BridgeClient', () => {
  it('posts state asynchronously with the bearer token and throttles it', async () => {
    let now = 1_000;
    const { fetchImpl, calls } = fakeFetch(async () => response({ ok: true }));
    const c = new BridgeClient({
      url: 'http://127.0.0.1:8787', token: 'tok', now: () => now, fetchImpl,
      onCommand: () => ({ accepted: true }),
    });
    c.onState(state());
    await c.flushState();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:8787/state');
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(c.status).toBe('ok');
    now += 400;
    await c.flushState();
    expect(calls).toHaveLength(1);
    now += 700;
    await c.flushState();
    expect(calls).toHaveLength(2);
  });

  it('batches events across throttled state posts instead of dropping them', async () => {
    let now = 1_000;
    const bodies: Array<{ events: Array<{ type: string }> }> = [];
    const { fetchImpl } = fakeFetch(async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)) as { events: Array<{ type: string }> });
      return response({ ok: true });
    });
    const c = new BridgeClient({ url: 'http://x', token: 't', now: () => now, fetchImpl, onCommand: () => ({ accepted: true }) });
    const e = (type: string, t: number) => ({ type, t, team: 'A' as const, confidence: 1, detail: {} });
    c.onState(state({ events: [e('turnover', 1)] }));
    now += 100;
    c.onState(state({ events: [e('high_press', 2)] }));
    await c.flushState();
    expect(bodies[0]?.events.map((x) => x.type)).toEqual(['turnover', 'high_press']);
    now += 1_000;
    await c.flushState();
    expect(bodies[1]?.events).toEqual([]);
  });

  it('backs off after failures and retries only after the delay', async () => {
    let now = 5_000;
    const { fetchImpl, calls } = fakeFetch(async () => response({ error: 'nope' }, 500));
    const c = new BridgeClient({ url: 'http://x', token: 't', now: () => now, fetchImpl, onCommand: () => ({ accepted: true }) });
    c.onState(state());
    await c.flushState();
    expect(calls).toHaveLength(1);
    expect(c.status).toBe('error');
    await c.flushState();
    expect(calls).toHaveLength(1);
    now += 5_000;
    await c.flushState();
    expect(calls).toHaveLength(2);
    expect(c.stats.failures).toBeGreaterThanOrEqual(1);
  });

  it('never throws into the render loop when fetch or capture fails', async () => {
    const c = new BridgeClient({
      url: 'http://x', token: 't',
      fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch,
      captureSnapshot: async () => { throw new Error('tainted'); },
      onCommand: () => { throw new Error('boom'); },
      snapshotEveryMs: 1000,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => c.onState(state())).not.toThrow();
    c.onState(state());
    await expect(c.flushState()).resolves.toBeUndefined();
    await expect(c.pollNow()).resolves.toBeUndefined();
    await expect(c.sendSnapshotNow()).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('captures a snapshot after 30 s of live play and posts it', async () => {
    let now = 0;
    const { fetchImpl, calls } = fakeFetch(async () => response({ ok: true }));
    const c = new BridgeClient({
      url: 'http://x', token: 't', now: () => now, fetchImpl,
      snapshotEveryMs: 3000,
      captureSnapshot: async () => ({ base64: 'abc', width: 1280, height: 720, t: 30 }),
      onCommand: () => ({ accepted: true }),
    });
    for (let i = 0; i < 4; i++) { now += 1000; c.onState(state({ t: i })); }
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.some((c2) => c2.url.endsWith('/snapshot'))).toBe(true);
    const snap = calls.find((c2) => c2.url.endsWith('/snapshot'))!;
    expect(JSON.parse(String(snap.init.body))).toMatchObject({ jpegBase64: 'abc', width: 1280, height: 720 });
  });

  it('polls commands, runs the handler and acks the result', async () => {
    const acks: Array<{ id: string; accepted: boolean; reason?: string }> = [];
    const { fetchImpl, calls } = fakeFetch(async (url) => {
      if (url.endsWith('/commands')) {
        return response({ commands: [
          { id: 'g1', graphic: 'overload', targets: [1, 2], reason: 'test', at: 1 },
          { id: 'g2', graphic: 'bad', targets: [], reason: '', at: 2 },
        ] });
      }
      if (url.endsWith('/commands/ack')) {
        const body = JSON.parse(String((calls.at(-1)?.init.body ?? '{}'))) as { acks: typeof acks };
        acks.push(...body.acks);
        return response({ ok: true });
      }
      return response({ ok: true });
    });
    const c = new BridgeClient({
      url: 'http://x', token: 't', fetchImpl,
      onCommand: (cmd) => cmd.graphic === 'overload' ? { accepted: true } : { accepted: false, reason: 'unknown' },
    });
    await c.pollNow();
    expect(acks).toEqual([
      { id: 'g1', accepted: true },
      { id: 'g2', accepted: false, reason: 'unknown' },
    ]);
    expect(c.status).toBe('ok');
    expect(c.stats.statePosts).toBe(1);
  });

  it('does not accumulate snapshot time while paused or in replay', () => {
    let now = 0;
    const c = new BridgeClient({
      url: 'http://x', token: 't', now: () => now,
      snapshotEveryMs: 2000,
      captureSnapshot: async () => null,
      onCommand: () => ({ accepted: true }),
      fetchImpl: (async () => response({ ok: true })) as typeof fetch,
    });
    for (let i = 0; i < 4; i++) { now += 1000; c.onState(state({ paused: true, playing: false })); }
    expect(c.stats.liveMs).toBe(0);
    for (let i = 0; i < 4; i++) { now += 1000; c.onState(state({ liveness: 'REPLAY', scene: 'REPLAY' })); }
    expect(c.stats.liveMs).toBe(0);
  });
});
