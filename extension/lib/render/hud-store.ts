// HUD model: everything the DOM layer draws, with the anti-flicker rules applied here
// (minimum on-time for Kimi lines, <= 2 stat updates/s, possession change held 1 s, one toast, 3 rail tiles).
import type {
  Event, Gate, KimiLine, MatchState, OverlaySnapshot, Prediction, QualityLevel, StatKey, StatValue, Team, DirectorLogEntry, KimiSpeedSnapshot,
} from '@tacticlens/core';
import { RULES, abbreviate, contrastInk, jerseyNames, shade } from './tokens';
import { stripMediaTalk } from '../live/media-talk';
import type { ReplayStep, Summary, Tier, UiMessage, ViewState } from './ui-types';

/** `hint` is the one-line plain-English meaning shown under the number (feed layout), so a glance explains the stat. */
export const TILE_DEFS: Partial<Record<StatKey, { label: string; unit?: string; ball: boolean; hint: string }>> = {
  pressure: { label: 'Pressure on ball', unit: 'opp', ball: true, hint: 'Opponents closing the ball carrier' },
  openOptions: { label: 'Open options', ball: true, hint: 'Passes the carrier can make right now' },
  compactness: { label: 'Compactness', ball: false, hint: 'How tight the team shape is' },
  freePlayers: { label: 'Free players', ball: false, hint: 'Unmarked teammates' },
  numbersNearBall: { label: 'Near the ball', ball: true, hint: 'Players within reach of the ball' },
  tempo: { label: 'Pass tempo', unit: '/min', ball: true, hint: 'Passes per minute' },
  passes: { label: 'Passes', ball: true, hint: 'Completed in this spell' },
  switches: { label: 'Switches', ball: true, hint: 'Long balls to the other side' },
  turnovers: { label: 'Turnovers', ball: true, hint: 'Times possession changed hands' },
  lineHeight: { label: 'Line height', ball: false, hint: 'How high the defence is sitting' },
  momentum: { label: 'Momentum', ball: true, hint: 'Who is on top right now' },
  fieldTilt: { label: 'Field tilt', unit: '%', ball: true, hint: 'Share of play in the opponent half' },
  blockGap: { label: 'Block gap', unit: 'm', ball: false, hint: 'Distance between the two teams' },
  teamExtent: { label: 'Block length', unit: 'm', ball: false, hint: 'How stretched the team is' },
  sprints: { label: 'Sprints', ball: false, hint: 'High-speed runs this match' },
  ballSpeed: { label: 'Ball speed', ball: true, hint: 'How fast the ball is moving' },
};
const ROTATION: StatKey[] = [
  'pressure', 'openOptions', 'compactness', 'freePlayers', 'numbersNearBall', 'tempo', 'passes', 'switches', 'turnovers', 'lineHeight',
  'momentum', 'fieldTilt', 'blockGap', 'teamExtent', 'sprints', 'ballSpeed',
];

export interface TileView { key: StatKey; label: string; unit?: string; hint: string; value: StatValue; paused: boolean; ball: boolean }
/** One bubble in the rolling side chat: a Kimi line (streamed in place by id) or the viewer's own question. */
export interface FeedItem {
  id: string; kind: 'kimi' | 'you' | 'sys'; text: string; lane: KimiLine['lane']; phase: KimiLine['phase'];
  final: boolean; late: number | null; at: number;
}
/** Bubbles kept in the side chat; older ones scroll away. */
export const FEED_MAX = 6;
/** Key stats pop up for this long (minimum), then fade slowly (the fade is CSS, ~2.8 s), and come back each cycle. */
export const STAT_LINGER_MS = 5000;
export const STAT_CYCLE_MS = 14000;
/** A Kimi `tiles` message only pops the cards at once if they have been hidden at least this long; otherwise the next cycle shows them. */
export const STAT_MIN_GAP_MS = 6000;
/** View states in which the stat cards never pop (checked when they pop, not while they linger). */
const STAT_HIDDEN_STATES: ViewState[] = ['OFF', 'CALIBRATING', 'CLOSE_UP', 'COMMENTARY', 'UNSUPPORTED'];
/** An ask with no answer after this long gets a note instead of an endless typing bubble. */
export const ASK_TIMEOUT_MS = 30000;
export interface LineView {
  id: string; text: string; lane: KimiLine['lane']; phase: KimiLine['phase'];
  mentions: number[]; final: boolean; ttftMs: number; totalMs: number; tokPerS: number; provider: string;
  eventToGraphicMs?: number; late: number | null; shownAt: number;
}
export interface PredView {
  id: string; kind: Prediction['kind']; side?: 'left' | 'right'; windowS: number; durMs: number;
  status: Prediction['status']; calledBeforeS: number | null; key: number; targetId?: number;
}
export interface RaceView {
  label: string; onTime: number; other: number; otherLabel: string; fairness: string;
  thinking: boolean; thinkingSince: number;
}
export interface HudModel {
  state: ViewState;
  ballOut: boolean;
  tier: Tier;
  showcase: boolean;
  pillSide: 'left' | 'right';
  hz: number | null; device: string; level: QualityLevel; eye: boolean; showPerf: boolean; dropped: number; perfDetail: string;
  renderMs: number; fps: number;
  names: { A: string; B: string };
  kit: { A: string; B: string };
  /** Jersey colour words ("Red", "Yellow"): how the chat and Kimi refer to the teams ("Team Red"). */
  jersey: { A: string; B: string };
  kitEdge: { A: string; B: string };
  kitInk: { A: string; B: string };
  kitDeep: { A: string; B: string };
  abbr: { A: string; B: string };
  kimiMark: boolean;
  score: [number, number] | null;
  clock: string | null;
  poss: { A: number; B: number; gate: Gate; paused: boolean; have: boolean };
  tiles: TileView[];
  /** The stat cards on screen: a copy latched when they pop, kept until the next pop so the fade-out has content. */
  shownTiles: TileView[];
  line: LineView | null;
  /** Rolling commentary history, oldest first, newest last (the side chat). */
  feed: FeedItem[];
  /** A Kimi call is in flight (typing bubble), and a viewer question is waiting for its answer. */
  typing: boolean;
  askPending: boolean;
  /** Key stat cards are currently popped up (they linger, then fade, then return each cycle). */
  tilesOn: boolean;
  replayCard: ReplayStep[] | null;
  pulse: number[];
  callsPerMin: number;
  p50: number;
  toast: { key: number; label: string; sub?: string } | null;
  prediction: PredView | null;
  scoreboard: { hits: number; total: number };
  race: RaceView | null;
  askQuestion: string | null;
  summary: Summary | null;
  teamOf: Record<number, Team>;
  /** Last director decisions for ?perf=1 (action, graphic, latency, accepted/rejected reason). */
  director: DirectorLogEntry[];
  /** Live Kimi speed counter (decisions/s, TTFT p50, cache hit, degrade level). null until the first call lands. */
  speed: KimiSpeedSnapshot | null;
  version: number;
}

const TOAST: Partial<Record<Event['type'], string>> = {
  turnover: 'TURNOVER', switch_of_play: 'SWITCH', high_press: 'PRESS', counter_attack: 'COUNTER', overload: 'OVERLOAD', momentum_flip: 'MOMENTUM',
  pass: 'PASS', spell: 'SPELL', line_height_change: 'LINE HEIGHT', formation_change: 'FORMATION',
};

type Listener = () => void;

export class HudStore {
  m: HudModel;
  private subs = new Set<Listener>();
  private tileOffset = 0;
  private kimiTiles: StatKey[] | null = null;
  private lastStat = new Map<StatKey, { at: number; v: StatValue; paused: boolean }>();
  /** Wall-clock ms when the stat cards last hid (-Infinity: never), for the STAT_MIN_GAP_MS rule. */
  private lastStatHide = -Infinity;
  private statsSnap: MatchState['stats'] | null = null;
  private possCand: { v: number; since: number } | null = null;
  private pending: KimiLine | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  /** Label -> wall ms of the last toast; a pass happens every few seconds, so it gets its own throttle. */
  private lastToastAt = new Map<string, number>();
  private predTimer: ReturnType<typeof setTimeout> | null = null;
  private calls: { at: number; ms: number }[] = [];
  private rotTimer: ReturnType<typeof setInterval> | null = null;
  private rate = 1;
  private seqKey = 0;
  /** True once measured/scout colours have been applied; stops setSnapshot re-deriving a kit. */
  private kitSet = false;
  /** Explicit jersey words from a known clip profile; null means derive them from the display kit. */
  private jerseyOverride: { A: string; B: string } | null = null;
  /** Gallery: keep toasts and prediction results on screen instead of timing them out. */
  hold = false;
  onMention: ((ids: number[]) => void) | null = null;
  onAsk: ((q: string) => void) | null = null;

  constructor() {
    this.m = {
      state: 'OFF', ballOut: false, tier: 'full', showcase: false, pillSide: 'right',
      hz: null, device: '', level: 3, eye: false, showPerf: false, dropped: 0, perfDetail: '', renderMs: 0, fps: 0,
      names: { A: 'Blue', B: 'Red' }, kit: { A: '#3d8bff', B: '#ff4d4f' }, jersey: jerseyNames('#3d8bff', '#ff4d4f'),
      kitEdge: { A: '#123a6b', B: '#5c1719' },
      kitInk: { A: '#ffffff', B: '#ffffff' }, kitDeep: { A: '#123a6b', B: '#5c1719' },
      abbr: { A: 'BLU', B: 'RED' }, kimiMark: false, score: null, clock: null,
      poss: { A: 50, B: 50, gate: 'hidden', paused: false, have: false },
      tiles: [], shownTiles: [], line: null, feed: [], typing: false, askPending: false, tilesOn: false, replayCard: null, pulse: [], callsPerMin: 0, p50: 0, toast: null, prediction: null,
      scoreboard: { hits: 0, total: 0 }, race: null, askQuestion: null, summary: null, teamOf: {}, director: [], speed: null, version: 0,
    };
    // Every cycle: advance the rotation (unless Kimi chose the tiles) and pop the stat cards up again.
    this.rotTimer = setInterval(() => {
      if (!this.kimiTiles) { this.tileOffset++; this.rebuildTiles(); this.emit(); }
      this.popTiles();
    }, STAT_CYCLE_MS);
  }

  dispose(): void {
    if (this.rotTimer) clearInterval(this.rotTimer);
    for (const t of [this.pendingTimer, this.toastTimer, this.predTimer, this.statHide, this.askTimer]) if (t) clearTimeout(t);
    this.subs.clear();
  }

  /**
   * Pop the stat cards: latch the current tiles, show them for STAT_LINGER_MS, then drop `tilesOn` (the CSS fades them slowly).
   * Never extends a running linger; state gating applies here, at pop time only.
   */
  private popTiles(): void {
    if (this.m.tilesOn) return;
    if (!this.m.tiles.length) return;
    if (STAT_HIDDEN_STATES.includes(this.m.state)) return;
    this.m = { ...this.m, shownTiles: [...this.m.tiles], tilesOn: true };
    this.emit();
    this.statHide = setTimeout(() => {
      this.statHide = null;
      this.lastStatHide = Date.now();
      this.m = { ...this.m, tilesOn: false };
      this.emit();
    }, STAT_LINGER_MS);
  }
  /** A Kimi `tiles` message pops at once only if the cards have been hidden long enough; otherwise the next cycle shows them. */
  private popTilesIfGapElapsed(): void {
    if (Date.now() - this.lastStatHide >= STAT_MIN_GAP_MS) this.popTiles();
  }
  private statHide: ReturnType<typeof setTimeout> | null = null;
  private statsPopped = false;
  private askTimer: ReturnType<typeof setTimeout> | null = null;

  /** A viewer question got its answer (or an error): stop waiting. */
  private endAsk(): void {
    if (this.askTimer) clearTimeout(this.askTimer);
    this.askTimer = null;
    if (this.m.askPending || this.m.typing) this.m = { ...this.m, askPending: false, typing: false };
  }

  /** Muted system bubble in the chat; same id replaces. */
  private note(id: string, text: string): void {
    const item: FeedItem = { id, kind: 'sys', text, lane: 'director', phase: 'none', final: true, late: null, at: performance.now() / 1000 };
    const rest = this.m.feed.filter((f) => f.id !== id);
    this.m = { ...this.m, feed: [...rest, item].slice(-FEED_MAX) };
    this.endAsk();
    this.emit();
  }

  subscribe(fn: Listener): () => void { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  private emit(): void { this.m = { ...this.m, version: this.m.version + 1 }; for (const f of this.subs) f(); }

  // ---------- layout / mode ----------
  setLayout(tier: Tier, showcase: boolean): void {
    if (tier === this.m.tier && showcase === this.m.showcase) return;
    this.m = { ...this.m, tier, showcase };
    this.rebuildTiles();
    this.emit();
  }
  setPerfVisible(v: boolean): void { this.m = { ...this.m, showPerf: v }; this.emit(); }
  /** Replace the ?perf=1 detail line (detector detail + calm state), 2 Hz from the controller. */
  setPerfDetail(detail: string): void {
    if (detail === this.m.perfDetail) return;
    this.m = { ...this.m, perfDetail: detail };
    this.emit();
  }
  /** Apply the renderer's display kit (real measured colours, already clamped for grass). */
  setKit(a: string, b: string, edgeA = shade(a, -0.55), edgeB = shade(b, -0.55), names?: { A: string; B: string } | null): void {
    const kit = { A: a, B: b };
    this.kitSet = true;
    this.jerseyOverride = names ?? null;
    this.m = {
      ...this.m, kit, jersey: this.jerseyOverride ?? jerseyNames(a, b), kitEdge: { A: edgeA, B: edgeB },
      kitInk: { A: contrastInk(a), B: contrastInk(b) },
      kitDeep: { A: shade(a, -0.58), B: shade(b, -0.58) },
    };
  }
  setPillSide(side: 'left' | 'right'): void { this.m = { ...this.m, pillSide: side }; this.emit(); }
  /** Live render stats from the stage (4 Hz). Shown only when ?perf=1. */
  setRenderStats(ms: number, fps: number): void {
    if (!this.m.showPerf) return;
    if (Math.abs(ms - this.m.renderMs) < 0.03 && Math.abs(fps - this.m.fps) < 0.5) return;
    this.m = { ...this.m, renderMs: ms, fps };
    this.emit();
  }

  setState(state: ViewState, ballOut: boolean): void {
    if (state === this.m.state && ballOut === this.m.ballOut) return;
    this.m = { ...this.m, state, ballOut, replayCard: state === 'REPLAY' ? this.m.replayCard : null,
      askQuestion: state === 'ASK' ? this.m.askQuestion : null };
    this.emit();
  }

  // ---------- snapshot ----------
  setSnapshot(s: OverlaySnapshot, now = performance.now() / 1000): void {
    this.rate = s.playbackRate || 1;
    const mt = s.match;
    const teamOf: Record<number, Team> = {};
    for (const t of s.tracks) teamOf[t.id] = t.team;
    // names / kit / scout. Kit colours normally arrive through setKit() (measured or display-mapped);
    // a scorebug read is only a fallback before the controller has supplied them.
    const sc = mt.scout;
    const names = sc ? sc.names : mt.teamNames;
    const kit = this.kitSet ? this.m.kit : sc ? sc.kitColours : this.m.kit;
    const kitEdge = this.kitSet ? this.m.kitEdge : { A: shade(kit.A, -0.55), B: shade(kit.B, -0.55) };
    const kitInk = { A: contrastInk(kit.A), B: contrastInk(kit.B) };
    const kitDeep = { A: shade(kit.A, -0.58), B: shade(kit.B, -0.58) };
    const abbr = { A: abbreviate(names.A), B: abbreviate(names.B) };
    // possession with 1 s hold on whole-point changes
    const p = mt.possession;
    let poss = this.m.poss;
    if (p.gate !== 'hidden') {
      const sum = p.value.A + p.value.B;
      const a = sum > 0 ? Math.round((p.value.A / sum) * 100) : 50;
      if (!poss.have) poss = { A: a, B: 100 - a, gate: p.gate, paused: !!p.paused, have: true };
      else {
        if (a === poss.A) this.possCand = null;
        else if (!this.possCand || this.possCand.v !== a) this.possCand = { v: a, since: now };
        else if (now - this.possCand.since >= RULES.possessionHold) { poss = { ...poss, A: a, B: 100 - a }; this.possCand = null; }
        poss = { ...poss, gate: p.gate, paused: !!p.paused };
      }
    } else poss = { ...poss, gate: 'hidden' };
    this.statsSnap = mt.stats;
    this.m = {
      ...this.m, names, kit, jersey: this.jerseyOverride ?? jerseyNames(kit.A, kit.B), kitEdge, kitInk, kitDeep, abbr, kimiMark: !!sc && sc.source === 'kimi', score: sc?.score ?? null, clock: sc?.clock ?? null, poss, teamOf,
    };
    this.rebuildTiles(now);
    this.emit();
  }

  /** The classic layout hides the rail on narrow panes; the feed layout shows two tiles in a strip there. */
  private tileCount(): number { return this.m.tier === 'full' ? 3 : 2; }

  private rebuildTiles(now = performance.now() / 1000): void {
    const stats = this.statsSnap;
    if (!stats) { this.m = { ...this.m, tiles: [] }; return; }
    const n = this.tileCount();
    const eligible = (k: StatKey): boolean => !!TILE_DEFS[k] && !!stats[k] && stats[k].gate !== 'hidden';
    let keys: StatKey[];
    if (this.kimiTiles) keys = this.kimiTiles.filter(eligible);
    else {
      const el = ROTATION.filter(eligible);
      keys = [];
      for (let i = 0; i < Math.min(n, el.length); i++) keys.push(el[(this.tileOffset + i) % el.length]!);
    }
    const tiles: TileView[] = [];
    for (const k of keys.slice(0, n)) {
      const st = stats[k]!;
      const def = TILE_DEFS[k]!;
      const prev = this.lastStat.get(k);
      let v = st.value, paused = !!st.paused;
      // <= 2 updates per second per stat
      if (prev && now - prev.at < RULES.statMinInterval) { v = prev.v; paused = prev.paused; }
      else this.lastStat.set(k, { at: now, v, paused });
      tiles.push({ key: k, label: def.label, unit: def.unit, hint: def.hint, value: v, paused, ball: def.ball });
    }
    // While the cards linger, refresh the values of the latched keys only (never add or drop keys).
    const live = new Map(tiles.map((t) => [t.key, t] as const));
    const shownTiles = this.m.tilesOn
      ? this.m.shownTiles.map((s) => { const l = live.get(s.key); return l ? { ...s, value: l.value, paused: l.paused } : s; })
      : this.m.shownTiles;
    this.m = { ...this.m, tiles, shownTiles };
    // First time there is something to show: pop it (the cycle timer brings it back every STAT_CYCLE_MS).
    if (tiles.length && !this.statsPopped) { this.popTiles(); if (this.m.tilesOn) this.statsPopped = true; }
  }

  // ---------- messages ----------
  message(msg: UiMessage, now = performance.now() / 1000): void {
    switch (msg.kind) {
      case 'line': this.handleLine(msg.line); break;
      case 'prediction': this.handlePrediction(msg.prediction); break;
      case 'intent': case 'clear': break; // engine-owned
      case 'event': this.handleEvent(msg.event, msg.eventToGraphicMs); break;
      case 'call': {
        this.calls.push({ at: now, ms: msg.ms });
        if (this.calls.length > 40) this.calls.shift();
        const recent = this.calls.filter((c) => now - c.at <= 60);
        const sorted = this.calls.map((c) => c.ms).sort((a, b) => a - b);
        this.m = {
          ...this.m, pulse: this.calls.map((c) => c.ms),
          callsPerMin: Math.round(recent.length * (60 / Math.max(10, Math.min(60, now - (recent[0]?.at ?? now))))),
          p50: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0),
        };
        this.emit();
        break;
      }
      case 'tiles': this.kimiTiles = msg.keys.length ? msg.keys : null; this.rebuildTiles(now); this.emit(); this.popTilesIfGapElapsed(); break;
      case 'typing': if (msg.on !== this.m.typing) { this.m = { ...this.m, typing: msg.on }; this.emit(); } break;
      case 'feed_note': this.note(msg.id, msg.text); break;
      case 'perf':
        this.m = { ...this.m, hz: msg.hz, device: msg.device, level: msg.level, eye: msg.eye, dropped: msg.captureDropped ?? this.m.dropped, perfDetail: msg.detail ?? this.m.perfDetail };
        this.emit();
        break;
      case 'thinking': {
        const r = this.m.race ?? { label: '', onTime: 0, other: 0, otherLabel: '', fairness: '', thinking: false, thinkingSince: 0 };
        this.m = { ...this.m, race: { ...r, thinking: msg.on, thinkingSince: msg.since } };
        this.emit();
        break;
      }
      case 'late': {
        if (this.m.feed.some((f) => f.id === msg.lineId)) {
          this.m = { ...this.m, feed: this.m.feed.map((f) => (f.id === msg.lineId ? { ...f, late: msg.lateS } : f)) };
        }
        if (this.m.line && this.m.line.id === msg.lineId) this.m = { ...this.m, line: { ...this.m.line, late: msg.lateS } };
        if (this.pending && this.pending.id === msg.lineId) this.lateFor = { id: msg.lineId, s: msg.lateS };
        else this.lateFor = { id: msg.lineId, s: msg.lateS };
        this.emit();
        break;
      }
      case 'lag': break; // engine-owned
      case 'race': {
        const r = this.m.race;
        this.m = { ...this.m, race: { label: msg.label, onTime: msg.onTime, other: msg.other, otherLabel: msg.otherLabel,
          fairness: msg.fairness ?? 'Same model, same prompt, same reasoning setting, same token cap.', thinking: r?.thinking ?? false, thinkingSince: r?.thinkingSince ?? 0 } };
        this.emit();
        break;
      }
      case 'scoreboard': this.m = { ...this.m, scoreboard: { hits: msg.hits, total: msg.total } }; this.emit(); break;
      case 'replay_card': this.m = { ...this.m, replayCard: msg.steps }; this.emit(); break;
      case 'summary': this.m = { ...this.m, summary: msg.summary }; this.emit(); break;
      case 'ask_state': this.m = { ...this.m, askQuestion: msg.question }; this.emit(); break;
      case 'director': this.m = { ...this.m, director: msg.log.slice(-5) }; this.emit(); break;
      case 'kimi_speed': this.m = { ...this.m, speed: msg.speed }; this.emit(); break;
      case 'hud_reset': this.resetTransient(); break;
    }
  }

  /** Seek, source restart or showcase loop: no stale line, toast, call or prediction survives. */
  private resetTransient(): void {
    this.pending = null;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (this.predTimer) clearTimeout(this.predTimer);
    this.pendingTimer = null; this.toastTimer = null; this.predTimer = null;
    if (this.statHide) clearTimeout(this.statHide);
    this.statHide = null; this.statsPopped = false;
    if (this.m.tilesOn) this.lastStatHide = Date.now();
    if (this.askTimer) clearTimeout(this.askTimer);
    this.askTimer = null;
    this.calls = [];
    this.possCand = null;
    this.lateFor = null;
    this.lastStat.clear();
    this.lastToastAt.clear();
    this.m = {
      ...this.m,
      line: null, feed: [], typing: false, askPending: false, tilesOn: false, toast: null, prediction: null, replayCard: null, summary: null, askQuestion: null,
      scoreboard: { hits: 0, total: 0 }, pulse: [], callsPerMin: 0, p50: 0, director: [],
      poss: { ...this.m.poss, have: false, gate: 'hidden', paused: false },
      tiles: [], shownTiles: [],
    };
    this.emit();
  }
  private lateFor: { id: string; s: number } | null = null;

  private toView(line: KimiLine, now: number): LineView {
    const st = line.stamp;
    return {
      id: line.id, text: line.text, lane: line.lane, phase: line.phase, mentions: line.mentions,
      final: st.totalMs > 0, ttftMs: st.ttftMs, totalMs: st.totalMs, tokPerS: st.tokPerS, provider: st.provider,
      eventToGraphicMs: st.eventToGraphicMs, late: this.lateFor && this.lateFor.id === line.id ? this.lateFor.s : null, shownAt: now,
    };
  }

  /** Side chat: every line goes in the moment it arrives (no min-on-time gate); streamed updates replace by id. */
  private feedUpsert(line: KimiLine, now: number): void {
    const raw = line.text.replace(/\[\[\d*\]?$/, '');   // a half-streamed [[12]] mention is not text yet
    // The director's lines never mention pictures, trackers or the payload: drop those sentences before they enter the chat.
    const text = line.lane === 'director' ? stripMediaTalk(raw) : raw;
    const final = line.stamp.totalMs > 0;
    const feed = this.m.feed;
    const i = feed.findIndex((f) => f.id === line.id);
    if (i >= 0 && !text.trim() && line.lane === 'director') {
      this.m = { ...this.m, feed: feed.filter((_, k) => k !== i) };
      return;
    }
    if (i >= 0) {
      const next = feed.slice();
      next[i] = { ...feed[i]!, text, final, phase: line.phase, lane: line.lane };
      this.m = { ...this.m, feed: next };
    } else {
      if (!text.trim()) return;
      const item: FeedItem = { id: line.id, kind: 'kimi', text, lane: line.lane, phase: line.phase, final, late: null, at: now };
      this.m = { ...this.m, feed: [...feed, item].slice(-FEED_MAX) };
    }
  }

  private handleLine(line: KimiLine): void {
    const now = performance.now() / 1000;
    this.feedUpsert(line, now);
    if (line.lane === 'ask' && line.text.trim()) this.endAsk();
    else if (this.m.typing && line.text.trim()) this.m = { ...this.m, typing: false };
    const cur = this.m.line;
    if (cur && cur.id === line.id) {
      this.m = { ...this.m, line: { ...this.toView(line, cur.shownAt), shownAt: cur.shownAt } };
      this.emit();
      return;
    }
    if (this.pending && this.pending.id === line.id) { this.pending = line; return; }
    const minOn = cur ? Math.max(RULES.minOnLineBase, RULES.minOnLinePerChar * cur.text.length) : 0;
    const wait = cur && line.lane !== 'ask' ? minOn - (now - cur.shownAt) : 0;
    if (wait > 0) {
      this.pending = line;
      if (this.pendingTimer) clearTimeout(this.pendingTimer);
      this.pendingTimer = setTimeout(() => {
        const p = this.pending;
        this.pending = null;
        if (p) this.show(p);
      }, wait * 1000);
      return;
    }
    this.show(line);
  }
  private show(line: KimiLine): void {
    const now = performance.now() / 1000;
    this.m = { ...this.m, line: this.toView(line, now) };
    this.emit();
    if (line.mentions.length) this.onMention?.(line.mentions);
  }
  clearLine(): void {
    this.pending = null;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.m = { ...this.m, line: null };
    this.emit();
  }

  private handleEvent(ev: Event, e2g?: number): void {
    const label = TOAST[ev.type];
    if (!label) return;
    const now = performance.now();
    // Passes are frequent; do not let them strobe over the more meaningful toasts.
    if (ev.type === 'pass' && now - (this.lastToastAt.get(label) ?? -Infinity) < 2200) return;
    this.lastToastAt.set(label, now);
    this.m = { ...this.m, toast: { key: ++this.seqKey, label, sub: e2g ? `Kimi ${(e2g / 1000).toFixed(2)} s` : undefined } };
    this.emit();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (this.hold) return;
    this.toastTimer = setTimeout(() => { this.m = { ...this.m, toast: null }; this.emit(); }, 1200);
  }

  private handlePrediction(p: Prediction): void {
    const prevView = this.m.prediction;
    if (p.status === 'open') {
      this.m = { ...this.m, prediction: {
        id: p.id, kind: p.kind, side: p.side, targetId: p.targetId, windowS: p.windowS,
        durMs: (p.windowS / Math.max(0.25, this.rate)) * 1000, status: 'open', calledBeforeS: null, key: ++this.seqKey } };
      this.emit();
      return;
    }
    if (!prevView || prevView.id !== p.id) return;
    // A resolved call (hit, miss or void) just takes the card down: no verdict stamp and no running tally.
    if (this.predTimer) clearTimeout(this.predTimer);
    this.m = { ...this.m, prediction: null };
    this.emit();
  }

  submitAsk(q: string): void {
    const text = q.trim();
    if (!text) return;
    const you: FeedItem = { id: `you${++this.seqKey}`, kind: 'you', text, lane: 'ask', phase: 'none', final: true, late: null, at: performance.now() / 1000 };
    this.m = { ...this.m, askQuestion: text, askPending: true, feed: [...this.m.feed, you].slice(-FEED_MAX) };
    if (this.askTimer) clearTimeout(this.askTimer);
    this.askTimer = setTimeout(() => { if (this.m.askPending) this.note('ask-timeout', "Kimi didn't answer that one. Try asking again."); }, ASK_TIMEOUT_MS);
    this.emit();
    this.onAsk?.(text);
  }
}
