import { describe, expect, it } from 'vitest';
import {
  QUEUE_MAX_RETRIES, QueueRetryMeter, queueRetryDelayMs, withQueueRetry,
} from '../../src/llm/retry';

interface FakeResult { ok?: boolean; errorKind?: 'queue_full' | 'rate_limited' }
const queue: FakeResult = { errorKind: 'queue_full' };
const rate: FakeResult = { errorKind: 'rate_limited' };
const ok: FakeResult = { ok: true };
const classify = (r: FakeResult) => (r.errorKind ? { kind: r.errorKind } : null);

describe('queue retry schedule', () => {
  it('uses jittered 100-300, 300-600, 600-1200 ms windows', () => {
    expect([queueRetryDelayMs(1, () => 0), queueRetryDelayMs(2, () => 0), queueRetryDelayMs(3, () => 0)]).toEqual([100, 300, 600]);
    expect([queueRetryDelayMs(1, () => 1), queueRetryDelayMs(2, () => 1), queueRetryDelayMs(3, () => 1)]).toEqual([300, 600, 1200]);
    for (let r = 1; r <= 3; r++) {
      const v = queueRetryDelayMs(r, () => 0.37);
      expect(v).toBeGreaterThan(0);
    }
    expect(QUEUE_MAX_RETRIES).toBe(3);
  });
});

describe('withQueueRetry', () => {
  it('retries the same queue_full request immediately and records recovery', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const meter = new QueueRetryMeter();
    const r = await withQueueRetry(
      async () => (calls++ < 2 ? queue : ok),
      classify,
      { meter, random: () => 0.5, sleep: async (ms) => { sleeps.push(ms); } },
    );
    expect(r).toEqual(ok);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([200, 450]);
    expect(meter.queueFull).toBe(2);
    expect(meter.retries).toBe(2);
    expect(meter.retrySuccess).toBe(1);
    expect(meter.retrySuccessPct()).toBe(50);
    expect(meter.congestionPct()).toBe(67);
    expect(meter.congested()).toBe(true);
  });

  it('stops after the retry budget and reports no recovery', async () => {
    let calls = 0;
    const meter = new QueueRetryMeter();
    const r = await withQueueRetry(async () => { calls++; return queue; }, classify, {
      meter, maxRetries: 1, sleep: async () => undefined,
    });
    expect(r).toEqual(queue);
    expect(calls).toBe(2);
    expect(meter.retries).toBe(1);
    expect(meter.retrySuccess).toBe(0);
    expect(meter.retrySuccessPct()).toBe(0);
  });

  it('never retries a real rate limit', async () => {
    let calls = 0;
    const meter = new QueueRetryMeter();
    const r = await withQueueRetry(async () => { calls++; return rate; }, classify, {
      meter, sleep: async () => undefined,
    });
    expect(r).toEqual(rate);
    expect(calls).toBe(1);
    expect(meter.rateLimited).toBe(1);
    expect(meter.retries).toBe(0);
  });

  it('drops a retry that becomes stale while the delay is pending (newest-wins)', async () => {
    let release!: () => void;
    const sleep = new Promise<void>((res) => { release = res; });
    let calls = 0;
    let stale = false;
    const meter = new QueueRetryMeter();
    const p = withQueueRetry(async () => { calls++; return queue; }, classify, {
      meter, sleep: () => sleep, shouldRetry: () => !stale,
    });
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toBe(1);            // retry scheduled but not sent yet
    stale = true;
    release();
    const r = await p;
    expect(r).toEqual(queue);
    expect(calls).toBe(1);            // the stale retry was dropped
    expect(meter.retries).toBe(0);
    expect(meter.retriesDropped).toBe(1);
  });

  it('congestion is the queue_full share of the last 20 attempts', () => {
    const m = new QueueRetryMeter();
    for (let i = 0; i < 20; i++) m.noteAttempt('queue_full');
    expect(m.congestionPct()).toBe(100);
    expect(m.congested()).toBe(true);
    for (let i = 0; i < 10; i++) m.noteAttempt(null);
    expect(m.congestionPct()).toBe(50);
    expect(m.congested()).toBe(false);
    for (let i = 0; i < 10; i++) m.noteAttempt(null);
    expect(m.congestionPct()).toBe(0);
    expect(m.congested()).toBe(false);
  });
});
