// Proactive update scheduler. Counts live-play seconds (not wall time), gates on scene / liveness /
// pause / ball presence, enforces at most one update per 10 s and handles the agent's SKIP reply.
import type { LiveStateRecord, StoredUpdate } from './protocol';

export const CADENCE_MS = 10_000;
export const MIN_GAP_MS = 10_000;
export const STALE_MS = 5_000;
export const BALL_ABSENT_S = 25;
/** How long the picture may leave live wide play before the live-time accumulator restarts. */
export const NOT_LIVE_GRACE_MS = 4_000;
/** One trigger is in flight until the agent answers with record_update; no answer within this is a stall. */
export const AGENT_REPLY_TIMEOUT_MS = 60_000;
/** Blocks new triggers after each stall: 60 s, 120 s, 240 s, then 300 s for every further stall. */
export const STALL_BACKOFF_MS: readonly number[] = [60_000, 120_000, 240_000, 300_000];
/** A failed hook POST blocks new triggers for at least this long. */
export const FAILED_POST_BACKOFF_MS = 30_000;
/** A record_update answering a trigger older than this is stale and is not sent. */
export const MAX_UPDATE_AGE_MS = 90_000;

export interface TriggerInfo {
  state: LiveStateRecord;
  liveMs: number;
  updateNumber: number;
  includeStatLine: boolean;
  meaningful: boolean;
  triggerId: string;
  triggeredAt: number;
}

export interface UpdateRecord {
  text: string;
  skipped: boolean;
  at: number;
  t: number;
}

export interface SchedulerOpts {
  now?: () => number;
  cadenceMs?: number;
  minGapMs?: number;
  staleMs?: number;
  ballAbsentS?: number;
  /** false = hook POST failed (stall); 'idle' = nothing to say (no stall); anything else = admitted. */
  onTrigger: (info: TriggerInfo) => boolean | 'idle' | void | Promise<boolean | 'idle' | void>;
  onUpdate?: (u: UpdateRecord) => void;
  isMeaningful?: () => boolean;
}

export type TickAction = 'trigger' | 'wait' | 'skip';
export type TickReason =
  | 'no-state' | 'stale' | 'not-live' | 'paused' | 'half-time' | 'ball-absent'
  | 'warmup' | 'rate' | 'triggered' | 'pending' | 'backoff';

export interface TickResult {
  action: TickAction;
  reason: TickReason;
  liveMs: number;
}

export function isLivePlay(s: LiveStateRecord, now: number, staleMs = STALE_MS): boolean {
  if (now - s.receivedAt > staleMs) return false;
  if (s.halfTime) return false;
  if (s.paused || s.playing === false) return false;
  if (s.liveness !== 'LIVE' || s.scene !== 'WIDE') return false;
  return true;
}

export class UpdateScheduler {
  private readonly now: () => number;
  private readonly cadenceMs: number;
  private readonly minGapMs: number;
  private readonly staleMs: number;
  private readonly ballAbsentS: number;
  private readonly onTrigger: SchedulerOpts['onTrigger'];
  private readonly onUpdate: SchedulerOpts['onUpdate'];
  private readonly isMeaningful: () => boolean;
  private lastTickAt: number | null = null;
  private notLiveSince: number | null = null;
  private liveMsAcc = 0;
  private lastTriggerAt = -Infinity;
  private lastSentAt = -Infinity;
  private lastSkipAt = -Infinity;
  private sent = 0;
  private pending: { id: string; at: number } | null = null;
  private lastTrigger: { id: string; at: number } | null = null;
  private stalls = 0;
  private blockedUntil = -Infinity;

  constructor(o: SchedulerOpts) {
    this.now = o.now ?? (() => Date.now());
    this.cadenceMs = o.cadenceMs ?? CADENCE_MS;
    this.minGapMs = o.minGapMs ?? MIN_GAP_MS;
    this.staleMs = o.staleMs ?? STALE_MS;
    this.ballAbsentS = o.ballAbsentS ?? BALL_ABSENT_S;
    this.onTrigger = o.onTrigger;
    this.onUpdate = o.onUpdate;
    this.isMeaningful = o.isMeaningful ?? (() => true);
  }

  get liveMs(): number { return this.liveMsAcc; }
  get sentCount(): number { return this.sent; }
  get lastSent(): number { return this.lastSentAt; }

  reset(): void {
    this.lastTickAt = null;
    this.notLiveSince = null;
    this.liveMsAcc = 0;
    this.lastTriggerAt = -Infinity;
    this.lastSentAt = -Infinity;
    this.lastSkipAt = -Infinity;
    this.sent = 0;
    this.pending = null;
    this.lastTrigger = null;
    this.stalls = 0;
    this.blockedUntil = -Infinity;
  }

  async tick(state: LiveStateRecord | null): Promise<TickResult> {
    const now = this.now();
    const dt = this.lastTickAt === null ? 0 : Math.max(0, Math.min(5_000, now - this.lastTickAt));
    this.lastTickAt = now;
    // One trigger in flight: hold until the agent answers, or count a stall once it has been silent too long.
    if (this.pending) {
      if (now - this.pending.at < AGENT_REPLY_TIMEOUT_MS) return { action: 'wait', reason: 'pending', liveMs: this.liveMsAcc };
      this.pending = null;
      this.stall(now, false);
    }
    if (now < this.blockedUntil) return { action: 'wait', reason: 'backoff', liveMs: this.liveMsAcc };
    // Breaks (close-ups, replays, pauses, ball out) PAUSE the live-play clock; they never reset it.
    // Broadcast footage cuts away every few seconds, so a long unbroken wide-play run may never happen.
    if (!state) return { action: 'skip', reason: 'no-state', liveMs: this.liveMsAcc };
    if (now - state.receivedAt > this.staleMs) return { action: 'skip', reason: 'stale', liveMs: this.liveMsAcc };
    if (state.halfTime) return { action: 'skip', reason: 'half-time', liveMs: this.liveMsAcc };
    if (state.paused || state.playing === false) return { action: 'skip', reason: 'paused', liveMs: this.liveMsAcc };
    if (state.liveness !== 'LIVE' || state.scene !== 'WIDE') {
      if (this.notLiveSince === null) this.notLiveSince = now;
      if (now - this.notLiveSince >= NOT_LIVE_GRACE_MS) return { action: 'skip', reason: 'not-live', liveMs: this.liveMsAcc };
      // Short flicker: keep counting as live play.
    } else {
      this.notLiveSince = null;
    }
    if (state.ball.state === 'absent' && state.ball.coastingS >= this.ballAbsentS) {
      return { action: 'skip', reason: 'ball-absent', liveMs: this.liveMsAcc };
    }

    this.liveMsAcc += dt;
    if (this.liveMsAcc < this.cadenceMs) return { action: 'wait', reason: 'warmup', liveMs: this.liveMsAcc };

    const sinceSent = now - this.lastSentAt;
    const sinceTrigger = now - this.lastTriggerAt;
    if (sinceSent < this.minGapMs || sinceTrigger < this.minGapMs) {
      return { action: 'wait', reason: 'rate', liveMs: this.liveMsAcc };
    }

    this.lastTriggerAt = now;
    const triggerId = `u${this.sent + 1}-${now.toString(36)}`;
    this.lastTrigger = { id: triggerId, at: now };
    this.pending = { id: triggerId, at: now };
    const includeStatLine = this.sent > 0 && (this.sent + 1) % 4 === 0;
    let outcome: boolean | 'idle' = true;
    try {
      const r = await this.onTrigger({
        state,
        liveMs: this.liveMsAcc,
        updateNumber: this.sent + 1,
        includeStatLine,
        meaningful: this.isMeaningful(),
        triggerId,
        triggeredAt: now,
      });
      outcome = r === false ? false : r === 'idle' ? 'idle' : true;
    } catch {
      outcome = false;
    }
    if (outcome !== true) {
      // Not admitted, so nothing is in flight. Only a failed POST is a stall; 'idle' is not.
      const stillPending = this.pending?.id === triggerId;
      if (stillPending) this.pending = null;
      if (outcome === false && stillPending) this.stall(this.now(), true);
      return { action: 'trigger', reason: 'triggered', liveMs: this.liveMsAcc };
    }
    this.liveMsAcc = 0;
    return { action: 'trigger', reason: 'triggered', liveMs: this.liveMsAcc };
  }

  /**
   * The agent (or dry run) reports what it did. A SKIP is never sent and does not break the cadence.
   * A record for a trigger other than the latest, or for a trigger older than MAX_UPDATE_AGE_MS, is stale:
   * it is not counted, not reported to onUpdate and not sent.
   */
  recordUpdate(text: string, skipped = false, t = 0, triggerId?: string): { sent: boolean; update: UpdateRecord; stale?: boolean } {
    const now = this.now();
    const isSkip = skipped || text.trim().toUpperCase() === 'SKIP';
    const update: UpdateRecord = { text: text.trim(), skipped: isSkip, at: now, t };
    if (this.isStale(now, triggerId)) return { sent: false, update, stale: true };
    // A valid answer ends the wait: the next trigger may go out and the stall count starts over.
    this.pending = null;
    this.stalls = 0;
    this.blockedUntil = -Infinity;
    if (isSkip) {
      this.lastSkipAt = now;
      this.liveMsAcc = 0;
    } else {
      this.sent++;
      this.lastSentAt = now;
    }
    this.onUpdate?.(update);
    return { sent: !isSkip, update };
  }

  get lastSkip(): number { return this.lastSkipAt; }

  private isStale(now: number, triggerId?: string): boolean {
    const last = this.lastTrigger;
    if (triggerId !== undefined && triggerId !== last?.id) return true;
    return last !== null && now - last.at > MAX_UPDATE_AGE_MS;
  }

  private stall(now: number, postFailed: boolean): void {
    this.stalls++;
    let backoff = STALL_BACKOFF_MS[Math.min(this.stalls - 1, STALL_BACKOFF_MS.length - 1)]!;
    if (postFailed) backoff = Math.max(backoff, FAILED_POST_BACKOFF_MS);
    this.blockedUntil = now + backoff;
  }
}
