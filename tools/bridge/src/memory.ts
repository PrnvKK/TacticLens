// Rolling match memory: latest compact state, deduplicated event log, per-minute stat snapshots,
// stored snapshot references and the analyst's own previous updates.
import { labelTeams, parseTeamLabels, type TeamLabels } from './labels';
import { stripMediaTalk } from './media';
import type {
  BridgeState, EventLite, LiveStateRecord, MinuteSnapshot, SnapshotRef, StatLite, StoredUpdate,
} from './protocol';
import { statVisible, visiblePair } from './visibility';

const MAX_EVENTS = 600;
const MAX_MINUTES = 120;
const MAX_UPDATES = 30;
const MAX_SNAPSHOTS = 8;

function teamPair(stat: StatLite | undefined): { A: number; B: number } | null {
  if (!stat || !stat.value || typeof stat.value !== 'object' || Array.isArray(stat.value)) return null;
  const v = stat.value as { A?: unknown; B?: unknown };
  if (typeof v.A !== 'number' || typeof v.B !== 'number') return null;
  return { A: v.A, B: v.B };
}

function plainNumber(stat: StatLite | undefined): number | null {
  if (!stat || typeof stat.value !== 'number' || !Number.isFinite(stat.value)) return null;
  return stat.value;
}

export function minuteSnapshotOf(s: BridgeState): MinuteSnapshot {
  return {
    minute: Math.floor(Math.max(0, s.t) / 60),
    t: s.t,
    // Only shown, confident, analyst-legal stats enter match memory.
    possession: statVisible(s.stats.possession) ? s.possession : null,
    passes: visiblePair(s.stats.passes),
    turnovers: visiblePair(s.stats.turnovers),
  };
}

/** A compact fingerprint of the tactical picture; used to decide whether an update is worth sending. */
export function fingerprintOf(s: BridgeState): string {
  const p = s.possession;
  const momentum = plainNumber(s.stats.momentum);
  const lh = teamPair(s.stats.lineHeight);
  const tilt = teamPair(s.stats.fieldTilt);
  const ballThird = !s.ball.xy ? 'none' : s.ball.xy[0] < 1 / 3 ? 'left' : s.ball.xy[0] > 2 / 3 ? 'right' : 'mid';
  return [
    Math.round(p.A / 5), p.current, s.liveness, s.scene, s.ball.state, ballThird,
    momentum === null ? '-' : momentum.toFixed(1),
    lh ? `${lh.A.toFixed(2)}/${lh.B.toFixed(2)}` : '-',
    tilt ? `${Math.round(tilt.A / 5)}/${Math.round(tilt.B / 5)}` : '-',
    s.score ? `${s.score[0]}-${s.score[1]}` : '-',
  ].join('|');
}

export class MatchMemory {
  latest: LiveStateRecord | null = null;
  readonly events: EventLite[] = [];
  readonly minutes: MinuteSnapshot[] = [];
  readonly updates: StoredUpdate[] = [];
  readonly snapshots: SnapshotRef[] = [];
  /** Latest known jersey-colour labels ("Team Red"); null until the extension sends valid ones, then sticky. */
  teamLabels: TeamLabels | null = null;
  /** Latest final line from the Theatre side chat, with the video time it described. */
  commentary: { text: string; t: number; at: number } | null = null;
  private eventKeys = new Set<string>();
  private lastMinute = -1;
  private lastT = -Infinity;
  private updateSeq = 0;
  private fingerprintAtLastUpdate: string | null = null;

  ingest(s: BridgeState, receivedAt: number): LiveStateRecord {
    // A backward seek starts a new match segment: keep history but open a fresh minute bucket.
    if (s.t < this.lastT - 2) this.lastMinute = -1;
    this.lastT = s.t;
    const labels = parseTeamLabels(s.teamLabels);
    if (labels) this.teamLabels = labels;
    // The stored record always carries the validated, latest-known labels (never raw wire input).
    const rec: LiveStateRecord = { ...s, receivedAt };
    if (this.teamLabels) rec.teamLabels = this.teamLabels; else delete rec.teamLabels;
    this.latest = rec;
    if (s.commentary && typeof s.commentary.text === 'string' && s.commentary.text.trim() && typeof s.commentary.t === 'number') {
      this.commentary = { text: s.commentary.text.trim(), t: s.commentary.t, at: receivedAt };
    }
    for (const e of s.events ?? []) this.addEvent(e);

    const minute = Math.floor(Math.max(0, s.t) / 60);
    const last = this.minutes[this.minutes.length - 1];
    if (minute !== this.lastMinute || (last && s.t - last.t >= 55)) {
      this.lastMinute = minute;
      this.minutes.push(minuteSnapshotOf(s));
      while (this.minutes.length > MAX_MINUTES) this.minutes.shift();
    }
    return rec;
  }

  private addEvent(e: EventLite): void {
    const key = `${e.t.toFixed(1)}|${e.type}|${e.team}`;
    if (this.eventKeys.has(key)) return;
    this.eventKeys.add(key);
    this.events.push(e);
    while (this.events.length > MAX_EVENTS) {
      const old = this.events.shift();
      if (old) this.eventKeys.delete(`${old.t.toFixed(1)}|${old.type}|${old.team}`);
    }
  }

  eventsSince(t: number, limit = 40): EventLite[] {
    return this.events.filter((e) => e.t > t).slice(-limit);
  }

  addUpdate(text: string, skipped = false): StoredUpdate {
    // Final sanitizers: no media/machinery talk, and Team A/Team B wording becomes the jersey labels.
    // Text that is empty after cleaning cannot be sent, so it is stored as a skip.
    const clean = labelTeams(stripMediaTalk(text.trim()), this.teamLabels);
    const isSkip = skipped || clean === '';
    const u: StoredUpdate = {
      id: ++this.updateSeq,
      at: Date.now(),
      t: this.latest?.t ?? 0,
      text: clean,
      skipped: isSkip,
    };
    this.updates.push(u);
    while (this.updates.length > MAX_UPDATES) this.updates.shift();
    if (!isSkip) this.fingerprintAtLastUpdate = this.latest ? fingerprintOf(this.latest) : null;
    return u;
  }

  addSnapshot(ref: SnapshotRef): void {
    this.snapshots.push(ref);
    while (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
  }

  get snapshot(): SnapshotRef | null {
    return this.snapshots.length ? this.snapshots[this.snapshots.length - 1]! : null;
  }

  /** True when the tactical picture differs from the one at the last sent update. */
  meaningful(): boolean {
    if (!this.latest) return false;
    if (this.fingerprintAtLastUpdate === null) return true;
    return fingerprintOf(this.latest) !== this.fingerprintAtLastUpdate;
  }

  sentCount(): number {
    return this.updates.filter((u) => !u.skipped).length;
  }
}

/**
 * One compact category only: possession, else passes, else turnovers. With labels the pair is anchored to
 * the teams ("Possession Team Red 57-43 Team Yellow"); without them the plain "Possession 57-43" is kept.
 */
export function formatStatLine(s: BridgeState, labels: TeamLabels | null = parseTeamLabels(s.teamLabels)): string {
  const line = (name: string, a: number, b: number): string =>
    labels ? `${name} ${labels.A} ${a}-${b} ${labels.B}` : `${name} ${a}-${b}`;
  const p = visiblePair(s.stats.possession);
  if (p) return line('Possession', Math.round(p.A), Math.round(p.B));
  const passes = visiblePair(s.stats.passes);
  if (passes) return line('Passes', passes.A, passes.B);
  const turnovers = visiblePair(s.stats.turnovers);
  if (turnovers) return line('Turnovers', turnovers.A, turnovers.B);
  return '';
}
