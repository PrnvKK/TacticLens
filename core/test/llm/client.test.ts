import { describe, expect, it } from 'vitest';
import { streamChat, type FetchLike, type LLMEvent, type ReaderLike } from '../../src/llm/client';
import { createMockFetch } from '../../src/llm/mock';
import { buildBody, imageDataUrlPart, resolveProvider } from '../../src/llm/providers';
import { OUTPUT_SCHEMA, OUTPUT_SCHEMA_NAME, isTacticLine } from '../../src/llm/prompts';
import { race } from '../../src/llm/race';
import { LaneRunner } from '../../src/llm/lanes';
import { Governor } from '../../src/llm/governor';

const req = {
  lane: 'reflex' as const,
  schema: { name: OUTPUT_SCHEMA_NAME, schema: OUTPUT_SCHEMA },
  messages: [
    { role: 'system' as const, content: 'x' },
    { role: 'user' as const, content: [{ type: 'text' as const, text: '{"tracks":{"7":{"team":"A"},"12":{"team":"B"},"3":{"team":"A"}}}' }, imageDataUrlPart('AAAA')] },
  ],
};
const fast = { ttftMs: 5, tokPerS: 20000, jitter: 0 };

describe('request body', () => {
  const p = resolveProvider('cerebras-kimi', 'k', { model: 'moonshotai-kimi-k3.1-pro-trial' });
  it('always sets reasoning_effort (default low) and strict json_schema', () => {
    const b: any = buildBody(p, req);
    expect(b.reasoning_effort).toBe('low');
    expect(b.response_format.json_schema.strict).toBe(true);
    expect(b.max_completion_tokens).toBeGreaterThan(0);
    expect(b.stream).toBe(true);
    expect((buildBody(p, { ...req, reasoningEffort: 'high' }) as any).reasoning_effort).toBe('high');
    for (const id of ['cerebras-kimi', 'gpu-baseline', 'mock'] as const) {
      expect((buildBody(resolveProvider(id, ''), req) as any).reasoning_effort).toBeTruthy();
    }
    expect((buildBody({ ...p, extra: { reasoning_effort: null } }, req) as any).reasoning_effort).toBe('low');
  });
  it('carries images as base64 data-URL parts', () => {
    const b: any = buildBody(p, req);
    expect(b.messages[1].content[1].image_url.url).toBe('data:image/jpeg;base64,AAAA');
  });
});

describe('mock provider through the real client', () => {
  it('streams schema-valid JSON, say renders before done, timings recorded', async () => {
    const events: LLMEvent[] = [];
    const r = await streamChat({ provider: resolveProvider('mock', ''), request: req, mockProfile: { ttftMs: 5, tokPerS: 600, jitter: 0 }, onEvent: (e) => events.push(e) });
    expect(r.ok).toBe(true);
    expect(r.parseOk).toBe(true);
    expect(isTacticLine(r.parsed)).toBe(true);
    const t = r.timing;
    expect(t.tFirstByte).not.toBeNull();
    expect(t.tFirstToken! >= t.tFirstByte!).toBe(true);
    expect(t.tDone! >= t.tFirstToken!).toBe(true);
    expect(t.usageReported).toBe(true);
    expect(t.tokensOut).toBeGreaterThan(20);
    expect(t.tokPerS).toBeGreaterThan(0);
    expect(t.framesSent).toBe(1);
    const says = events.filter((e) => e.type === 'say') as Extract<LLMEvent, { type: 'say' }>[];
    expect(says.length).toBeGreaterThan(0);
    expect(says[says.length - 1].complete).toBe(true);
    // say completes before the stream is done: some delta events come after the last say
    const lastSay = events.lastIndexOf(says[says.length - 1]);
    expect(events.slice(lastSay).some((e) => e.type === 'delta')).toBe(true);
    // mentions use ids from the request
    expect(JSON.stringify(r.parsed)).toMatch(/\b(7|12|3)\b/);
  });
  it('gpu-like is slower than cerebras-like', async () => {
    const a = await streamChat({ provider: resolveProvider('mock', ''), request: req, mockProfile: { ttftMs: 5, tokPerS: 20000, jitter: 0 } });
    const b = await streamChat({ provider: resolveProvider('mock', ''), request: req, mockProfile: { ttftMs: 120, tokPerS: 2000, jitter: 0 } });
    expect(b.timing.totalMs).toBeGreaterThan(a.timing.totalMs);
    expect(b.timing.ttftMs).toBeGreaterThan(a.timing.ttftMs);
  });
  it('abort cancels cleanly', async () => {
    const ac = new AbortController();
    const p = streamChat({ provider: resolveProvider('mock', ''), request: req, mockProfile: { ttftMs: 50, tokPerS: 100, jitter: 0 }, signal: ac.signal });
    setTimeout(() => ac.abort(), 80);
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.ok).toBe(false);
  });
  it('starts TTFT at the first reasoning token, not the first visible content', async () => {
    // Deterministic clock: every read advances 100 ms. The reasoning chunk is read second, the
    // content third. TTFT must therefore be 200 ms, not 300 ms.
    let t = 0;
    const enc = { encode: (s: string): Uint8Array => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff)) };
    const body = [
      { choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { reasoning: 'thinking about the press' } }] },
      { choices: [{ delta: { content: '{"say":"go"}' } }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 9, total_tokens: 19 } },
    ].map((j) => `data: ${JSON.stringify(j)}\n\n`).concat('data: [DONE]\n\n');
    let i = 0;
    const reader: ReaderLike = {
      async read() { t += 100; if (i >= body.length) return { done: true }; return { done: false, value: enc.encode(body[i++]!) }; },
      async cancel() { /* no-op */ },
    };
    const fetchImpl: FetchLike = async () => ({
      ok: true, status: 200, headers: { get: () => null },
      body: { getReader: () => reader }, text: async () => '',
    });
    const events: LLMEvent[] = [];
    const r = await streamChat({
      provider: resolveProvider('cerebras-kimi', 'k', { model: 'moonshotai-kimi-k3.1-pro-trial' }),
      request: req, fetchImpl, now: () => t, onEvent: (e) => events.push(e),
    });
    expect(r.ok).toBe(true);
    expect(r.timing.tFirstToken).toBe(200);
    expect(r.timing.ttftMs).toBe(200);
    const firstToken = events.findIndex((e) => e.type === 'first_token');
    const firstDelta = events.findIndex((e) => e.type === 'delta');
    expect(firstToken).toBeGreaterThanOrEqual(0);
    expect(firstToken).toBeLessThan(firstDelta);
    expect(r.timing.tokensOut).toBe(9);
  });
  it('http error surfaces status and retry-after', async () => {
    const f = async () => ({ ok: false, status: 429, headers: { get: (n: string) => (n === 'retry-after' ? '2' : null) }, body: null, text: async () => 'slow down' });
    const r = await streamChat({ provider: resolveProvider('cerebras-kimi', 'k', { model: 'moonshotai-kimi-k3.1-pro-trial' }), request: req, fetchImpl: f });
    expect(r.status).toBe(429);
    expect(r.retryAfterMs).toBe(2000);
  });
});

describe('race + lanes', () => {
  it('reports both timings for the same request', async () => {
    const res = await race(
      { provider: { ...resolveProvider('mock', ''), name: 'fast' }, mockProfile: fast },
      { provider: { ...resolveProvider('mock', ''), name: 'slow' }, mockProfile: { ttftMs: 150, tokPerS: 3000, jitter: 0 } },
      req,
    );
    expect(res.firstTokenWinner).toBe('a');
    expect(res.ttftDeltaMs!).toBeGreaterThan(50);
    expect(res.a.timing.provider).toBe('fast');
    expect(res.b.parseOk).toBe(true);
  });
  it('LaneRunner replaces in-flight same-lane call and records timings', async () => {
    const stamps: number[] = [];
    const lr = new LaneRunner(new Governor(), { onTiming: (t) => stamps.push(t.ttftMs) });
    const slow = lr.run(resolveProvider('mock', ''), req, { mockProfile: { ttftMs: 300, tokPerS: 100, jitter: 0 } });
    await new Promise<void>((r) => setTimeout(() => r(), 20));
    const quick = await lr.run(resolveProvider('mock', ''), req, { mockProfile: fast });
    expect(quick.status).toBe('ok');
    expect((await slow).status).toBe('aborted');
    expect(stamps).toHaveLength(1);
    expect(lr.tracker.stats()[0].calls).toBe(1);
  });
  it('refuses frames to a provider without image support', async () => {
    const lr = new LaneRunner();
    const noImages = { ...resolveProvider('cerebras-kimi', 'k', { model: 'moonshotai-kimi-k3.1-pro-trial' }), supportsImages: false };
    const o = await lr.run(noImages, req, {});
    expect(o).toEqual({ status: 'skipped', reason: 'no_images' });
  });
});
