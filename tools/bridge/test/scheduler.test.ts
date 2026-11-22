import { describe, expect, it } from 'vitest';
import {
  AGENT_REPLY_TIMEOUT_MS, BALL_ABSENT_S, CADENCE_MS, MAX_UPDATE_AGE_MS, MIN_GAP_MS, UpdateScheduler, isLivePlay,
  type TickResult, type TriggerInfo, type UpdateRecord,
} from '../src/scheduler';
import { liveState } from './fixtures';

function clocked(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('UpdateScheduler', () => {
  it('waits for 10 s of live play and then triggers once', async () => {
    const c = clocked();
    const triggers: TriggerInfo[] = [];
    const s = new UpdateScheduler({ now: c.now, onTrigger: (i) => { triggers.push(i); } });
    let last = c.now();
    for (let elapsed = 0; elapsed < CADENCE_MS; elapsed += 1_000) {
      c.advance(1_000);
      last = c.now();
      const r = await s.tick(liveState(elapsed / 1000, c.now()));
      expect(r.action).toBe('wait');
    }
    c.advance(1_000);
    const r = await s.tick(liveState((c.now() - last) / 1000, c.now()));
    expect(r.action).toBe('trigger');
    expect(triggers).toHaveLength(1);
  });

  it('pauses (never resets) the live-play clock during replay, pause, half-time and ball absence', async () => {
    const c = clocked();
    let calls = 0;
    // Use a cadence longer than the whole test so this case isolates the break behaviour.
    const s = new UpdateScheduler({ now: c.now, cadenceMs: 45_000, onTrigger: () => { calls++; } });
    const run = async (over: Parameters<typeof liveState>[2], seconds: number): Promise<void> => {
      for (let i = 0; i < seconds; i++) {
        c.advance(1_000);
        await s.tick(liveState(i, c.now(), over));
      }
    };
    await run({}, 20);
    const beforeBreaks = s.liveMs;
    await run({ liveness: 'REPLAY', scene: 'REPLAY' }, 40);
    await run({ paused: true, playing: false }, 40);
    await run({ halfTime: true }, 40);
    await run({ ball: { state: 'absent', coastingS: BALL_ABSENT_S + 1, visibility: 0, xy: null } }, 40);
    expect(calls).toBe(0);
    // Breaks add at most the short not-live grace, and keep what was already counted.
    expect(s.liveMs).toBeGreaterThanOrEqual(beforeBreaks);
    expect(s.liveMs).toBeLessThan(beforeBreaks + 6_000);
    await run({}, 60);
    expect(calls).toBe(1);
  });

  it('enforces at most one update per 10 s across triggers', async () => {
    const c = clocked();
    let calls = 0;
    const s = new UpdateScheduler({ now: c.now, onTrigger: () => { calls++; } });
    const feed = async (seconds: number, from = 0): Promise<void> => {
      for (let i = 0; i < seconds; i++) {
        c.advance(1_000);
        await s.tick(liveState(from + i, c.now()));
      }
    };
    await feed(11);
    expect(calls).toBe(1);
    s.recordUpdate('Arsenal have taken control of midfield.', false, 11);
    await feed(9, 11);
    expect(calls).toBe(1);
    await feed(2, 20);
    expect(calls).toBe(2);
    expect(MIN_GAP_MS).toBe(10_000);
  });

  it('treats a SKIP reply as not sent', () => {
    const c = clocked();
    const updates: Array<{ skipped: boolean }> = [];
    const s = new UpdateScheduler({ now: c.now, onTrigger: () => undefined, onUpdate: (u) => updates.push(u) });
    const r = s.recordUpdate('SKIP');
    expect(r.sent).toBe(false);
    expect(updates[0]?.skipped).toBe(true);
    expect(s.sentCount).toBe(0);
    expect(s.lastSent).toBe(-Infinity);
  });

  it('returns wait while the state is stale and skips with no state', async () => {
    const c = clocked();
    let calls = 0;
    const s = new UpdateScheduler({ now: c.now, onTrigger: () => { calls++; } });
    expect((await s.tick(null)).reason).toBe('no-state');
    c.advance(10_000);
    const stale = await s.tick(liveState(10, c.now() - 10_000));
    expect(stale.action).toBe('skip');
    expect(stale.reason).toBe('stale');
    expect(isLivePlay(liveState(10, c.now()), c.now())).toBe(true);
    expect(calls).toBe(0);
  });

  it('does not advance cadence while paused', async () => {
    const c = clocked();
    const s = new UpdateScheduler({ now: c.now, onTrigger: () => undefined });
    for (let i = 0; i < 20; i++) { c.advance(1_000); await s.tick(liveState(i, c.now(), { paused: true, playing: false })); }
    expect(s.liveMs).toBe(0);
  });
});

/** Ticks once per second until `done` holds; returns the last tick. */
async function tickUntil(
  s: UpdateScheduler, c: { now: () => number; advance: (ms: number) => void },
  done: (r: TickResult) => boolean, maxS = 1_000,
): Promise<TickResult> {
  for (let i = 0; i < maxS; i++) {
    c.advance(1_000);
    const r = await s.tick(liveState(c.now() / 1000, c.now()));
    if (done(r)) return r;
  }
  throw new Error('condition not reached');
}

describe('UpdateScheduler: one trigger in flight, stalls and staleness', () => {
  const fast = (c: { now: () => number }, over: Partial<ConstructorParameters<typeof UpdateScheduler>[0]> = {}) => ({
    now: c.now, cadenceMs: 1_000, minGapMs: 1_000, onTrigger: () => undefined, ...over,
  });

  it('holds a second trigger while the first is pending', async () => {
    const c = clocked();
    const triggers: TriggerInfo[] = [];
    const s = new UpdateScheduler({ ...fast(c), onTrigger: (i) => { triggers.push(i); } });
    await tickUntil(s, c, () => triggers.length === 1);
    let r: TickResult | undefined;
    for (let i = 0; i < 40; i++) {
      c.advance(1_000);
      r = await s.tick(liveState(c.now() / 1000, c.now()));
    }
    expect(r?.reason).toBe('pending');
    expect(triggers).toHaveLength(1);
    s.recordUpdate('Team Red are pressing high.', false, 0, triggers[0]!.triggerId);
    await tickUntil(s, c, () => triggers.length === 2, 5);
    expect(triggers).toHaveLength(2);
  });

  it('counts a silent agent as a stall and backs off 60, 120, 240, 300, 300 s', async () => {
    const c = clocked();
    const triggerAt: number[] = [];
    const s = new UpdateScheduler({ ...fast(c), onTrigger: () => { triggerAt.push(c.now()); } });
    const expected = [60_000, 120_000, 240_000, 300_000, 300_000];
    for (let k = 0; k < expected.length; k++) {
      await tickUntil(s, c, () => triggerAt.length === k + 1);
      const timeout = await tickUntil(s, c, (r) => r.reason === 'backoff', AGENT_REPLY_TIMEOUT_MS / 1000 + 5);
      expect(timeout.action).toBe('wait');
      const stalledAt = c.now();
      expect(stalledAt - triggerAt[k]!).toBeGreaterThanOrEqual(AGENT_REPLY_TIMEOUT_MS);
      expect(stalledAt - triggerAt[k]!).toBeLessThan(AGENT_REPLY_TIMEOUT_MS + 2_000);
      await tickUntil(s, c, () => triggerAt.length === k + 2, expected[k]! / 1000 + 10);
      const gap = c.now() - stalledAt;
      expect(gap).toBeGreaterThanOrEqual(expected[k]!);
      expect(gap).toBeLessThan(expected[k]! + 2_000);
    }
  });

  it('a failed hook POST is a stall with at least 30 s of backoff and no pending hold', async () => {
    const c = clocked();
    const triggerAt: number[] = [];
    const s = new UpdateScheduler({ ...fast(c), onTrigger: () => { triggerAt.push(c.now()); return false; } });
    await tickUntil(s, c, () => triggerAt.length === 1);
    const next = await s.tick(liveState(c.now() / 1000, c.now()));
    expect(next.reason).toBe('backoff');
    await tickUntil(s, c, () => triggerAt.length === 2);
    expect(c.now() - triggerAt[0]!).toBeGreaterThanOrEqual(30_000);
  });

  it('an idle trigger neither holds nor stalls', async () => {
    const c = clocked();
    let calls = 0;
    const s = new UpdateScheduler({ ...fast(c), onTrigger: () => { calls++; return 'idle'; } });
    await tickUntil(s, c, () => calls === 1);
    await tickUntil(s, c, () => calls === 2, 10);
    expect(calls).toBe(2);
  });

  it('a valid record_update clears the pending trigger and resets the stall count', async () => {
    const c = clocked();
    const triggerAt: number[] = [];
    const s = new UpdateScheduler({ ...fast(c), onTrigger: () => { triggerAt.push(c.now()); } });
    await tickUntil(s, c, () => triggerAt.length === 1);
    await tickUntil(s, c, (r) => r.reason === 'backoff', 70);
    await tickUntil(s, c, () => triggerAt.length === 2);
    s.recordUpdate('Team Yellow are being pinned back.', false, 0, undefined);
    await tickUntil(s, c, () => triggerAt.length === 3, 5);
    expect(c.now() - triggerAt[1]!).toBeLessThan(5_000);
    // Stall count was reset, so the next silence is again the first 60 s backoff, not 120 s.
    await tickUntil(s, c, (r) => r.reason === 'backoff', 70);
    const stalledAt = c.now();
    await tickUntil(s, c, () => triggerAt.length === 4, 70);
    expect(triggerAt[3]! - stalledAt).toBeLessThan(63_000);
  });

  it('a SKIP reply also clears the pending trigger and resets the stall count', async () => {
    const c = clocked();
    const triggerAt: number[] = [];
    const s = new UpdateScheduler({ ...fast(c), onTrigger: () => { triggerAt.push(c.now()); } });
    await tickUntil(s, c, () => triggerAt.length === 1);
    await tickUntil(s, c, (r) => r.reason === 'backoff', 70);
    await tickUntil(s, c, () => triggerAt.length === 2);
    s.recordUpdate('SKIP', true, 0, undefined);
    await tickUntil(s, c, () => triggerAt.length === 3, 5);
    expect(c.now() - triggerAt[1]!).toBeLessThan(5_000);
  });

  it('rejects a record whose triggerId is not the latest trigger', async () => {
    const c = clocked();
    const infos: TriggerInfo[] = [];
    const updates: UpdateRecord[] = [];
    const s = new UpdateScheduler({ ...fast(c), onTrigger: (i) => { infos.push(i); }, onUpdate: (u) => updates.push(u) });
    await tickUntil(s, c, () => infos.length === 1);
    const bad = s.recordUpdate('Arsenal are pinning them back.', false, 0, 'u0-old');
    expect(bad.stale).toBe(true);
    expect(bad.sent).toBe(false);
    expect(updates).toHaveLength(0);
    expect(s.sentCount).toBe(0);
    const good = s.recordUpdate('Arsenal are pinning them back.', false, 0, infos[0]!.triggerId);
    expect(good.stale).toBeUndefined();
    expect(good.sent).toBe(true);
    expect(updates).toHaveLength(1);
  });

  it('rejects a record older than MAX_UPDATE_AGE_MS and accepts one just inside it', async () => {
    const c = clocked();
    const infos: TriggerInfo[] = [];
    const s = new UpdateScheduler({ ...fast(c), onTrigger: (i) => { infos.push(i); } });
    await tickUntil(s, c, () => infos.length === 1);
    c.advance(MAX_UPDATE_AGE_MS + 1_000);
    const late = s.recordUpdate('Late words.', false, 0, infos[0]!.triggerId);
    expect(late.stale).toBe(true);
    expect(s.sentCount).toBe(0);

    const c2 = clocked();
    const infos2: TriggerInfo[] = [];
    const s2 = new UpdateScheduler({ ...fast(c2), onTrigger: (i) => { infos2.push(i); } });
    await tickUntil(s2, c2, () => infos2.length === 1);
    c2.advance(MAX_UPDATE_AGE_MS - 1_000);
    expect(s2.recordUpdate('Timely words.', false, 0, infos2[0]!.triggerId).sent).toBe(true);
  });

  it('keeps the dry-run path unchanged when no triggerId is given and no trigger is known', () => {
    const c = clocked();
    const s = new UpdateScheduler({ now: c.now, onTrigger: () => undefined });
    c.advance(10 * MAX_UPDATE_AGE_MS);
    const r = s.recordUpdate('Arsenal have taken control of midfield.', false, 3);
    expect(r.sent).toBe(true);
    expect(r.stale).toBeUndefined();
    expect(s.sentCount).toBe(1);
  });

  it('exposes a triggerId and triggeredAt on every trigger', async () => {
    const c = clocked();
    const infos: TriggerInfo[] = [];
    const s = new UpdateScheduler({ ...fast(c), onTrigger: (i) => { infos.push(i); } });
    await tickUntil(s, c, () => infos.length === 1);
    expect(infos[0]!.triggerId).toMatch(/^u1-[0-9a-z]+$/);
    expect(infos[0]!.triggeredAt).toBe(c.now());
  });
});
