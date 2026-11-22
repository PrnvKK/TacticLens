// Page-side long-term match memory for the Kimi side chat (pure TypeScript, no DOM).
//
// Why this exists: the instantaneous snapshot packs every ball-dependent stat as the string "paused" whenever the ball is out
// or the picture is frozen, so a question asked at that moment would get "I can't tell". This memory is fed ~1x/second while
// the video plays and remembers, for every stat, the latest REAL value and when it was seen; it also keeps per-minute stat rows,
// a deduplicated rule-event log and the lines Kimi has already said. `toPayload()` turns it into a compact JSON block (about
// 1.5k tokens at most) that the ask lane sends next to the snapshot.
//
// Mirrors the bridge server's memory (events log, per-minute snapshots, analyst updates) but is not imported from it.
// All times are VIDEO time in seconds, so a paused video does not age the memory.
import type { Event } from '@tacticlens/core';

export interface TeamLabels { A: string; B: string }

/** The slice of a Stat the memory reads (a core `Stat<StatValue>` satisfies it). */
interface StatLike { value?: unknown; updatedAt?: number; gate?: string; paused?: boolean }
/** The slice of a MatchState the memory reads: `stats` and the possession holder. */
export interface MemoryMatch {
  stats?: Partial<Record<string, StatLike>> | null;
  possession?: { value?: { current?: string } | null; gate?: string; paused?: boolean; updatedAt?: number } | null;
}

export interface MemoryInput {
  /** Video time of the frame the stats belong to. */
  t: number;
  match?: MemoryMatch | null;
  /** Rule events; the engine's recent window is fine to re-send every call (they are deduplicated). */
  events?: readonly Event[];
  /** Team names to speak with, e.g. { A: 'Team Red', B: 'Team Yellow' } (jersey colours). Kept until replaced. */
  labels?: TeamLabels | null;
}

export type SaidBy = 'commentary' | 'director' | 'answer';
export interface SaidInput { text: string; t: number; phase?: string; by?: SaidBy; id?: string }

type PairValue = { A: number; B: number };
type Known = { value: number | string | PairValue; seenT: number };

export type PayloadValue = number | string | Record<string, number>;
export interface MinuteRow { min: number; [k: string]: number | [number, number] }
export interface MemoryEventOut { type: string; team?: string; agoS: number; [k: string]: string | number | undefined }
export interface MemorySaidOut { by: SaidBy; agoS?: number; text: string }
export interface MemoryPayload {
  /** Order of every [first, second] pair in `minutes` (and of the signed `momentum` there: positive favours teams[0]). */
  teams: [string, string];
  lastKnownStats: Record<string, { value: PayloadValue; agoS: number }>;
  minutes: MinuteRow[];
  events: MemoryEventOut[];
  said: MemorySaidOut[];
  phases?: Record<string, number>;
}

export const MAX_MINUTES = 120;
export const MAX_EVENTS = 200;
export const MAX_SAID = 30;
/** A backward jump bigger than this starts a new segment (the engine resets on a seek back as well). */
export const SEEK_BACK_S = 2;
/** Rough ceiling of the serialised memory block: about 1.5k tokens at ~3 characters per token. */
export const MAX_PAYLOAD_CHARS = 4500;

/** Engine/telemetry stats that say nothing about the match. */
const META = new Set(['kimiCalls', 'kimiSpeed', 'detectorHealth']);
/** Stats that are whole numbers. */
const INT_KEYS = new Set(['possession', 'passes', 'turnovers', 'freePlayers', 'numbersNearBall', 'openOptions', 'switches', 'sprints']);
/** Stats kept per video minute. */
const MINUTE_KEYS = ['possession', 'passes', 'turnovers', 'tempo', 'pressure', 'freePlayers', 'compactness', 'momentum'] as const;
const RESERVED = new Set(['type', 'team', 'agoS']);

const isPair = (v: unknown): v is PairValue =>
  !!v && typeof v === 'object' && Number.isFinite((v as PairValue).A) && Number.isFinite((v as PairValue).B)
  && typeof (v as PairValue).A === 'number' && typeof (v as PairValue).B === 'number';

/** Value of a stat, or null when it is not a number, a string or an A/B pair of numbers. */
function clean(v: unknown): Known['value'] | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v;
  return isPair(v) ? { A: v.A, B: v.B } : null;
}

/** Video time a stat was really computed at: its own `updatedAt` (stale values keep the old one), else `t`. */
function seenOf(s: { updatedAt?: number }, t: number): number {
  const u = s.updatedAt;
  return typeof u === 'number' && Number.isFinite(u) && u > 0 && u <= t + 0.5 ? u : t;
}

function rnd(key: string, v: number): number {
  if (INT_KEYS.has(key)) return Math.round(v);
  const a = Math.abs(v);
  const k = a >= 100 ? 1 : a >= 10 ? 10 : 100;
  return Math.round(v * k) / k;
}

interface MinuteBucket { minute: number; vals: Record<string, Known['value']> }
interface StoredEvent { t: number; type: string; team: string; detail: Record<string, number | string> }
interface StoredSaid { id?: string; t: number; seg: number; text: string; phase?: string; by: SaidBy }

const evKey = (e: { t: number; type: string; team: string }): string => `${e.t.toFixed(1)}|${e.type}|${e.team}`;

export class MatchMemory {
  private known = new Map<string, Known>();
  private mins: MinuteBucket[] = [];
  private evs: StoredEvent[] = [];
  private evKeys = new Set<string>();
  private lines: StoredSaid[] = [];
  private lineIds = new Set<string>();
  private tally = new Map<string, number>();
  private labels: TeamLabels | null = null;
  private lastT = -Infinity;
  private seg = 0;

  /** Number of backward seeks seen so far (0 = the first pass through the video). */
  get segment(): number { return this.seg; }

  /** Feed one observation (call about once a second while the video plays, and once at ask time). */
  ingest(inp: MemoryInput): void {
    const t = inp.t;
    if (!Number.isFinite(t)) return;
    if (inp.labels) this.labels = inp.labels;
    if (t < this.lastT - SEEK_BACK_S) this.newSegment();
    this.lastT = t;
    this.takeStats(t, inp.match);
    for (const e of inp.events ?? []) this.addEvent(e);
    this.takeMinute(t);
  }

  /** Remember a line Kimi said (commentary, director or an answer). Lines with a known id are stored once. */
  addSaid(s: SaidInput): void {
    const text = s.text.replace(/\[\[(\d+)\]\]/g, '#$1').replace(/\s+/g, ' ').trim().slice(0, 220);
    if (!text) return;
    if (s.id) {
      if (this.lineIds.has(s.id)) return;
      this.lineIds.add(s.id);
    }
    this.lines.push({ ...(s.id ? { id: s.id } : {}), t: s.t, seg: this.seg, text, ...(s.phase ? { phase: s.phase } : {}), by: s.by ?? 'commentary' });
    while (this.lines.length > MAX_SAID) {
      const old = this.lines.shift();
      if (old?.id) this.lineIds.delete(old.id);
    }
    if (s.phase && s.phase !== 'none') this.tally.set(s.phase, (this.tally.get(s.phase) ?? 0) + 1);
  }

  /** The last real value of one stat and how long ago it was seen, or null when it was never seen. */
  lastKnown(key: string, nowT: number): { value: PayloadValue; agoS: number } | null {
    const k = this.known.get(key);
    return k ? { value: this.outValue(key, k.value), agoS: this.ago(nowT, k.seenT) } : null;
  }

  /** Compact JSON-able block for the model; trimmed to roughly `maxChars` (about 1.5k tokens by default). */
  toPayload(nowT: number, opts: { maxChars?: number } = {}): MemoryPayload {
    const max = opts.maxChars ?? MAX_PAYLOAD_CHARS;
    const [a, b] = this.names();
    const lastKnownStats: MemoryPayload['lastKnownStats'] = {};
    for (const [k, v] of this.known) lastKnownStats[k] = { value: this.outValue(k, v.value), agoS: this.ago(nowT, v.seenT) };
    const phases = Object.fromEntries(this.tally);
    const build = (nMin: number, nEv: number, nSaid: number): MemoryPayload => ({
      teams: [a, b],
      lastKnownStats,
      minutes: this.mins.slice(-nMin).map((m) => this.minuteOut(m)),
      events: this.evs.slice().sort((x, y) => x.t - y.t).slice(-nEv).map((e) => this.eventOut(e, nowT)),
      said: this.lines.slice(-nSaid).map((l) => ({
        by: l.by, ...(l.seg === this.seg ? { agoS: this.ago(nowT, l.t) } : {}), text: l.text,
      })),
      ...(Object.keys(phases).length ? { phases } : {}),
    });
    let nMin = 10, nEv = 12, nSaid = 6;
    let p = build(nMin, nEv, nSaid);
    while (JSON.stringify(p).length > max && (nMin > 2 || nEv > 4 || nSaid > 2)) {
      if (nMin > 2) nMin--; else if (nEv > 4) nEv--; else nSaid--;
      p = build(nMin, nEv, nSaid);
    }
    return p;
  }

  // ---------- intake ----------

  /** A big backward seek (or a loop) starts a new segment: the engine restarts its counters, so stats, minutes and events
   *  from the old pass would describe a different part of the video. What was said stays (the conversation continues). */
  private newSegment(): void {
    this.seg++;
    this.known.clear();
    this.mins.length = 0;
    this.evs.length = 0;
    this.evKeys.clear();
    this.tally.clear();
  }

  private takeStats(t: number, m: MemoryMatch | null | undefined): void {
    if (!m) return;
    for (const [k, s] of Object.entries(m.stats ?? {})) {
      if (!s || META.has(k) || s.paused || s.gate !== 'shown') continue;
      const v = clean(s.value);
      if (v !== null) this.remember(k, v, seenOf(s, t));
    }
    const p = m.possession;
    const cur = p?.value?.current;
    if (p && !p.paused && p.gate === 'shown' && (cur === 'A' || cur === 'B')) this.remember('holder', cur, seenOf(p, t));
  }

  private remember(key: string, value: Known['value'], seenT: number): void {
    const prev = this.known.get(key);
    if (prev && prev.seenT > seenT) return;
    this.known.set(key, { value, seenT });
  }

  private takeMinute(t: number): void {
    const minute = Math.floor(Math.max(0, t) / 60);
    const vals: MinuteBucket['vals'] = {};
    for (const k of MINUTE_KEYS) {
      const kn = this.known.get(k);
      // Only what was actually seen during this minute: an older value would put last minute's number in this row.
      if (kn && kn.seenT >= minute * 60) vals[k] = kn.value;
    }
    if (!Object.keys(vals).length) return;
    const have = this.mins.find((x) => x.minute === minute);
    if (have) { have.vals = vals; return; }
    this.mins.push({ minute, vals });
    this.mins.sort((x, y) => x.minute - y.minute);
    while (this.mins.length > MAX_MINUTES) this.mins.shift();
  }

  private addEvent(e: Event): void {
    // Individual passes are counted by the passes stat; logging each one would drown the events that matter.
    if (e.type === 'pass' || !Number.isFinite(e.t)) return;
    const key = evKey(e);
    if (this.evKeys.has(key)) return;
    this.evKeys.add(key);
    const detail: StoredEvent['detail'] = {};
    for (const [k, v] of Object.entries(e.detail ?? {})) {
      // Track ids (carrierId, pass from/to) are stale within seconds; the model may only point at ids in the live data.
      if (typeof v === 'number' && (/id$/i.test(k) || k === 'from' || k === 'to')) continue;
      detail[k] = v;
    }
    this.evs.push({ t: e.t, type: e.type, team: e.team, detail });
    while (this.evs.length > MAX_EVENTS) {
      const old = this.evs.shift();
      if (old) this.evKeys.delete(evKey(old));
    }
  }

  // ---------- output ----------

  private names(): [string, string] {
    const a = this.labels?.A || 'Team A';
    let b = this.labels?.B || 'Team B';
    if (a === b) b = `${b} 2`;
    return [a, b];
  }

  private ago(nowT: number, t: number): number { return Math.max(0, Math.round(nowT - t)); }

  private teamName(v: string): string {
    const [a, b] = this.names();
    return v === 'A' ? a : v === 'B' ? b : v;
  }

  private outValue(key: string, v: Known['value']): PayloadValue {
    const [a, b] = this.names();
    if (isPair(v)) return { [a]: rnd(key, v.A), [b]: rnd(key, v.B) };
    if (typeof v === 'number') return key === 'momentum' ? { [a]: rnd(key, v), [b]: rnd(key, -v) } : rnd(key, v);
    return key === 'holder' ? this.teamName(v) : v;
  }

  private minuteOut(m: MinuteBucket): MinuteRow {
    const row: MinuteRow = { min: m.minute };
    for (const [k, v] of Object.entries(m.vals)) {
      if (isPair(v)) row[k] = [rnd(k, v.A), rnd(k, v.B)];
      else if (typeof v === 'number') row[k] = rnd(k, v);
    }
    return row;
  }

  private eventOut(e: StoredEvent, nowT: number): MemoryEventOut {
    const out: MemoryEventOut = { type: e.type, ...(e.team === 'A' || e.team === 'B' ? { team: this.teamName(e.team) } : {}), agoS: this.ago(nowT, e.t) };
    let n = 0;
    for (const [k, v] of Object.entries(e.detail)) {
      if (RESERVED.has(k) || n >= 3) continue;
      out[k] = typeof v === 'number' ? Math.round(v * 100) / 100 : this.teamName(v);
      n++;
    }
    return out;
  }
}
