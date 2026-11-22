import { describe, expect, it } from 'vitest';
import { BudgetGovernor, SpeedMeter, speedSnapshot } from '../../src/llm/budget';

function clock() { let t = 1_000_000; return { now: () => t, adv: (ms: number) => { t += ms; } }; }
const LIM = { uncachedPerMin: 100_000, totalPerMin: 1_000_000, requestsPerMin: 1000 };

describe('BudgetGovernor window', () => {
  it('sums real usage over a rolling 60 s window and keeps both uncached numbers', () => {
    const c = clock();
    const b = new BudgetGovernor({ now: c.now, limits: LIM });
    b.record({ lane: 'director', prompt: 3000, cached: 2048, completion: 300 });
    b.record({ lane: 'watch', prompt: 3500, cached: 2048, completion: 200 });
    const s = b.snapshot();
    expect(s.requestsPerMin).toBe(2);
    expect(s.uncachedPromptPerMin).toBe(952 + 1452);
    expect(s.uncachedPerMin).toBe(952 + 1452 + 500);
    expect(s.totalPerMin).toBe(3300 + 3700);
    expect(s.cachedPct).toBe(Math.round((4096 / 6500) * 100));
    c.adv(61_000);
    expect(b.snapshot().requestsPerMin).toBe(0);
  });
});

describe('degrade ladder', () => {
  function feed(b: BudgetGovernor, c: ReturnType<typeof clock>, seconds: number, perSecond: number, uncachedEach: number) {
    for (let s = 0; s < seconds; s++) {
      for (let i = 0; i < perSecond; i++) b.record({ lane: 'director', prompt: uncachedEach + 2048, cached: 2048, completion: 0 });
      c.adv(1000);
    }
  }
  it('starts at full rate: watch 0.4 Hz (one frame per 2.5 s), director 1 Hz', () => {
    const b = new BudgetGovernor({ now: () => 0 });
    const r = b.rates();
    expect(r.watchIntervalMs).toBe(2500);
    expect(Math.round(r.directorIntervalMs)).toBe(1000);
    expect(r.analystEnabled).toBe(true);
  });
  it('climbs watch 1/2 -> 1/4 -> off -> director 2/3 -> 1/3 -> analyst off while over target', () => {
    const c = clock();
    const b = new BudgetGovernor({ now: c.now, limits: LIM });
    const seen: string[] = [];
    // 5 calls/s of 5k uncached = 1.5M uncached/min: far over the 85k target at any level.
    for (let s = 0; s < 80; s++) {
      for (let i = 0; i < 5; i++) b.record({ lane: 'director', prompt: 7048, cached: 2048, completion: 0 });
      c.adv(1000);
      const n = b.rates().levelName;
      if (seen[seen.length - 1] !== n) seen.push(n);
    }
    expect(seen).toEqual(['full', 'watch 1/2 rate', 'watch 1/4 rate', 'watch off', 'director 2/3 rate', 'director 1/3 rate', 'analyst off']);
    const r = b.rates();
    expect(r.watchIntervalMs).toBeNull();
    expect(Math.round(r.directorIntervalMs)).toBe(3000);
    expect(r.analystEnabled).toBe(false);
  });
  it('does not climb on healthy traffic (mostly cached)', () => {
    const c = clock();
    const b = new BudgetGovernor({ now: c.now, limits: LIM });
    feed(b, c, 90, 4, 300);   // 4 req/s x 300 uncached = 72k/min < 85k target
    expect(b.currentLevel).toBe(0);
  });
  it('recovers with hysteresis: steps down only after the load is well under target and the dwell passed', () => {
    const c = clock();
    const b = new BudgetGovernor({ now: c.now, limits: LIM });
    feed(b, c, 30, 5, 5000);
    const peak = b.currentLevel;
    expect(peak).toBeGreaterThan(0);
    // Load between 70% and 100% of target: hold, neither up nor down.
    c.adv(70_000);
    feed(b, c, 30, 1, 5000 * 0.7 * 85 / 60 * 1.1 / 1);   // ~ 0.77 of target
    const held = b.currentLevel;
    expect(held).toBeLessThanOrEqual(peak);
    // Quiet: it steps down one level at a time, never below 0.
    const levels: number[] = [];
    for (let s = 0; s < 120; s++) { c.adv(1000); b.evaluate(); levels.push(b.currentLevel); }
    expect(levels[levels.length - 1]).toBe(0);
    for (let i = 1; i < levels.length; i++) expect(levels[i - 1]! - levels[i]!).toBeLessThanOrEqual(1);
  });
  it('event-triggered launches ignore the ladder cadence, ordinary ones are refused when too fast', () => {
    const c = clock();
    const b = new BudgetGovernor({ now: c.now, limits: LIM, baseDirectorHz: 3 });
    expect(b.tryLaunch('director')).toBe(true);
    expect(b.tryLaunch('director')).toBe(false);
    expect(b.tryLaunch('director', { event: true })).toBe(true);
    c.adv(340);
    expect(b.tryLaunch('director')).toBe(true);
  });
});

describe('429 backoff', () => {
  it('backs the lane off with jitter, never queues, and recovers', () => {
    const c = clock();
    const b = new BudgetGovernor({ now: c.now, random: () => 0.5, backoffBaseMs: 500 });
    const w1 = b.note429('director');
    expect(w1).toBe(500 * 0.75);
    expect(b.tryLaunch('director')).toBe(false);
    expect(b.tryLaunch('director', { event: true })).toBe(false);
    expect(b.tryLaunch('watch')).toBe(true);     // other lanes are independent
    c.adv(w1 + 1);
    expect(b.tryLaunch('director')).toBe(true);
    const w2 = b.note429('director');
    expect(w2).toBe(1000 * 0.75);                // exponential
    expect(b.note429('director', 5000)).toBe(5000); // retry-after wins
    b.noteOk('director');
    expect(b.note429('director')).toBe(500 * 0.75);
    expect(b.snapshot().errors429).toBe(4);
  });
});

describe('adaptive concurrency and hard ceilings', () => {
  it('counts queue retries as requests without touching the lane backoff', () => {
    const c = clock();
    const b = new BudgetGovernor({ now: c.now, limits: { uncachedPerMin: 1_000_000, totalPerMin: 10_000_000, requestsPerMin: 100 }, random: () => 0.5 });
    for (let i = 0; i < 85; i++) b.noteRetry('director');
    expect(b.backoffLeftMs('director')).toBe(0);      // no lane backoff
    expect(b.snapshot().errors429).toBe(0);
    expect(b.tryLaunch('director')).toBe(false);      // the 85% request ceiling includes them
  });

  it('raises in-flight with latency but never above the uncached/request targets', () => {
    const c = clock();
    const b = new BudgetGovernor({ now: c.now, limits: LIM, targetFrac: 0.85 });
    for (let i = 0; i < 5; i++) b.record({ lane: 'director', prompt: 2800, cached: 2000, completion: 0 });
    expect(b.avgUncached('director')).toBe(800);
    expect(b.concurrencyLimit('director', 20_000)).toBe(8);
    expect(b.concurrencyLimit('director', 3_000)).toBe(5);
    expect(b.concurrencyLimit('director', 1_000)).toBe(1);
    const cap = b.concurrencyLimit('director', 20_000);
    const perMin = cap / (20_000 / 60_000);           // starts/min sustained by that concurrency
    expect(perMin * b.avgUncached('director')).toBeLessThanOrEqual(b.targets().uncachedPerMin);
  });

  it('defaults to the admin-updated Cerebras limits with 15% headroom', () => {
    const b = new BudgetGovernor();
    expect(b.targets().uncachedPerMin).toBe(42_500);
    expect(b.targets().totalPerMin).toBe(425_000);
    expect(b.targets().requestsPerMin).toBe(850);
  });

  it('refuses a launch that would cross the request ceiling', () => {
    const c = clock();
    const b = new BudgetGovernor({ now: c.now, limits: { uncachedPerMin: 1_000_000, totalPerMin: 10_000_000, requestsPerMin: 100 }, baseDirectorHz: 3, targetFrac: 0.85 });
    for (let i = 0; i < 85; i++) { c.adv(340); expect(b.tryLaunch('director')).toBe(true); }
    expect(b.tryLaunch('director')).toBe(false);
    expect(b.tryLaunch('watch')).toBe(false);
  });

  it('refuses a launch when real uncached usage plus in-flight calls would cross 85k/min', () => {
    const c = clock();
    const b = new BudgetGovernor({ now: c.now, limits: { uncachedPerMin: 1000, totalPerMin: 1_000_000, requestsPerMin: 1000 } });
    b.record({ lane: 'director', prompt: 700, cached: 0, completion: 0 });
    expect(b.tryLaunch('director')).toBe(false);
  });
});

describe('SpeedMeter kimiState', () => {
  it('goes thinking -> live -> slow -> thinking as decisions arrive and stop', () => {
    const c = clock();
    const m = new SpeedMeter(c.now);
    expect(m.kimiState()).toBe('thinking');
    m.decision();
    expect(m.kimiState()).toBe('live');
    m.ttft(3500);
    expect(m.kimiState()).toBe('slow');
    c.adv(2100);
    expect(m.kimiState()).toBe('thinking');
    expect(m.sinceDecisionMs()).toBe(2100);
    m.decision();
    expect(m.kimiState()).toBe('slow');
    c.adv(500);
    expect(m.kimiState()).toBe('slow');
  });

  it('reports congested when queue_full is over 50% of the last 20 attempts', () => {
    const m = new SpeedMeter(() => 0);
    for (let i = 0; i < 11; i++) m.queue.noteAttempt('queue_full');
    for (let i = 0; i < 9; i++) m.queue.noteAttempt('rate_limited');
    expect(m.kimiState()).toBe('congested');
    const snap = speedSnapshot(new BudgetGovernor({ now: () => 0 }), m);
    expect(snap.queueFull).toBe(11);
    expect(snap.rateLimited).toBe(9);
    expect(snap.queueCongestionPct).toBe(55);
    expect(snap.retrySuccessPct).toBe(0);
    expect(snap.kimiState).toBe('congested');
    // 50% exactly is not "over 50%".
    const half = new SpeedMeter(() => 0);
    for (let i = 0; i < 10; i++) half.queue.noteAttempt('queue_full');
    for (let i = 0; i < 10; i++) half.queue.noteAttempt('rate_limited');
    expect(half.kimiState()).not.toBe('congested');
  });
});

describe('SpeedMeter', () => {
  it('reports decisions per second and p50 ttft over rolling windows', () => {
    const c = clock();
    const m = new SpeedMeter(c.now);
    for (let i = 0; i < 15; i++) { m.decision(); c.adv(333); }
    expect(m.decisionsPerS()).toBeGreaterThanOrEqual(2.8);
    expect(m.decisionsPerS()).toBeLessThanOrEqual(3.2);
    [600, 700, 650, 2000, 640].forEach((x) => m.ttft(x));
    expect(m.ttftP50()).toBe(650);
  });
});
