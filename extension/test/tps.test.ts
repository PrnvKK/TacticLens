import { describe, expect, it } from 'vitest';
import { CallMeter, SpeedTracker, officialTps, percentile, feedLLMEvent } from '../lib/speed/tps';
import { RaceStore } from '../lib/speed/store';

describe('officialTps', () => {
  it('uses (n-1)/(tLast-tFirst) and excludes TTFT', () => {
    // 101 tokens, first at 1000 ms, last at 1500 ms: 100 / 0.5 s = 200
    expect(officialTps(101, 1000, 1500)).toBeCloseTo(200, 9);
  });
  it('is 0 for fewer than 2 tokens or zero duration', () => {
    expect(officialTps(1, 100, 200)).toBe(0);
    expect(officialTps(50, 100, 100)).toBe(0);
    expect(officialTps(50, null, 100)).toBe(0);
  });
});

describe('CallMeter', () => {
  it('ignores the request->first-token wait', () => {
    const slow = new CallMeter('a', 0);
    const fast = new CallMeter('b', 0);
    for (let i = 0; i < 11; i++) { slow.delta(5000 + i * 10); fast.delta(100 + i * 10); }
    expect(slow.tps).toBeCloseTo(fast.tps, 9);
    expect(slow.tps).toBeCloseTo(100, 6);
    expect(slow.ttftMs).toBe(5000);
  });
  it('prefers usage.completion_tokens over the delta count', () => {
    const m = new CallMeter('a', 0);
    m.delta(0); m.delta(100); // 2 deltas (chunks carrying several tokens each)
    expect(m.tps).toBeCloseTo(10, 9); // (2-1)/0.1
    m.setUsage(21);
    expect(m.tps).toBeCloseTo(200, 9); // (21-1)/0.1
    expect(m.tokens).toBe(21);
  });
  it('falls back to deltas when usage is absent', () => {
    const m = new CallMeter('a', 0);
    m.delta(0, 5); m.delta(50, 5);
    expect(m.tokens).toBe(10);
    expect(m.tps).toBeCloseTo(9 / 0.05, 9);
  });
});

describe('SpeedTracker', () => {
  function run(tr: SpeedTracker, id: string, t0: number, tps: number, n: number): void {
    tr.begin(id, t0);
    const tFirst = t0 + 100;
    for (let i = 0; i < n; i++) tr.delta(id, tFirst + (i / tps) * 1000);
    tr.usage(id, n);
    tr.end(id, tFirst + ((n - 1) / tps) * 1000);
  }
  it('aggregates concurrent calls into total tokens/s', () => {
    const tr = new SpeedTracker();
    // two calls streaming 2000 tok/s each, inside the same 1 s window
    tr.begin('a', 0); tr.begin('b', 0);
    for (let i = 0; i < 2000; i++) { tr.delta('a', i * 0.5 + 0.5); tr.delta('b', i * 0.5 + 0.5); }
    expect(tr.aggregateTps(1000)).toBeCloseTo(4000, -1);
    expect(tr.aggregateTps(1000)).toBeGreaterThan(3990);
    expect(tr.aggregateTps(5000)).toBe(0);
  });
  it('tracks rolling p50 and session peak', () => {
    const tr = new SpeedTracker();
    [1000, 2000, 3000, 1500, 2500].forEach((tps, i) => run(tr, `c${i}`, i * 1000, tps, 50));
    const s = tr.snapshot(5000);
    expect(s.p50Tps).toBeCloseTo(2000, 0);
    expect(s.peakTps).toBeCloseTo(3000, 0);
    expect(s.decisionsTotal).toBe(5);
    expect(s.calls[0]!.id).toBe('c4');
    expect(s.tokensTotal).toBe(250);
  });
  it('does not let tiny calls set the peak', () => {
    const tr = new SpeedTracker();
    run(tr, 'tiny', 0, 90000, 3);
    run(tr, 'ok', 1000, 1800, 40);
    expect(tr.snapshot(3000).peakTps).toBeCloseTo(1800, 0);
  });
  it('counts decisions per second over the window', () => {
    const tr = new SpeedTracker({ decisionWindowMs: 2000 });
    for (let i = 0; i < 8; i++) run(tr, `d${i}`, i * 200, 2000, 20);
    expect(tr.snapshot(2000).decisionsPerS).toBeCloseTo(4, 0);
  });
  it('headline holds the last finished call when idle', () => {
    const tr = new SpeedTracker();
    run(tr, 'x', 0, 1234, 30);
    expect(tr.snapshot(100000).headlineTps).toBeCloseTo(1234, 0);
  });
  it('reconciles chunk estimates with usage tokens for the all-calls rate', () => {
    const tr = new SpeedTracker();
    tr.begin('a', 0);
    // Ten chunks estimated at ten tokens each; usage reports the true count (40).
    for (let i = 0; i < 10; i++) tr.delta('a', 100 + i * 10, 10);
    tr.usage('a', 40);
    expect(tr.aggregateTps(200)).toBeCloseTo(40, 6);
  });
});

describe('feedLLMEvent', () => {
  it('builds a call from start/delta/done events', () => {
    const tr = new SpeedTracker();
    feedLLMEvent(tr, 'k', { type: 'start', tRequest: 0 }, 0);
    for (let i = 0; i < 21; i++) feedLLMEvent(tr, 'k', { type: 'delta', text: 'x' }, 100 + i * 5);
    feedLLMEvent(tr, 'k', { type: 'done', result: { timing: { tFirstToken: 100, tDone: 205, tokensOut: 21, usageReported: true } } }, 205);
    const c = tr.snapshot(300).calls[0]!;
    expect(c.tps).toBeCloseTo(200, 6);
    expect(c.ttftMs).toBe(100);
  });
  it('drops errored calls without counting a decision', () => {
    const tr = new SpeedTracker();
    feedLLMEvent(tr, 'k', { type: 'start', tRequest: 0 }, 0);
    feedLLMEvent(tr, 'k', { type: 'error' }, 5);
    expect(tr.snapshot(10).decisionsTotal).toBe(0);
  });
});

describe('percentile', () => {
  it('nearest rank', () => { expect(percentile([1, 2, 3, 4], 50)).toBe(2); expect(percentile([], 50)).toBe(0); });
});

describe('RaceStore', () => {
  it('reports final speedup as the wall-clock ratio', () => {
    let t = 0;
    const r = new RaceStore(() => t);
    r.begin(0);
    r.delta('a', 'ab', 1, 100); r.delta('a', 'cd', 200, 200); r.end('a', 200);
    r.delta('b', 'ab', 1, 900); r.delta('b', 'cd', 200, 2900); r.end('b', 2900);
    t = 3000;
    const v = r.view();
    expect(v.final).toBe(true);
    expect(v.speedup).toBeCloseTo(2900 / 200, 6);
    expect(v.a.text).toBe('abcd');
  });
});
