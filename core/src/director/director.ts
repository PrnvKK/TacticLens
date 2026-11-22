// The director lane. Kimi is the TV director: this class builds the compact payload, calls the
// provider, validates the answer and keeps the decision log. It owns no rendering and no network.
import type { BallState, Event, Liveness, MatchState, SceneKind, Team } from '../types';
import type { EngineOutput } from '../engine';
import type { LLMEvent } from '../llm/client';
import type { LLMErrorKind } from '../llm/errors';
import type { LLMRequest } from '../llm/providers';
import type { CallTiming } from '../llm/timing';
import { DIRECTOR_MAX_TOKENS, DIRECTOR_SCHEMA, DIRECTOR_SCHEMA_NAME, DIRECTOR_SYSTEM_PROMPT } from './prompts';
import { buildMenu } from './menu';
import { validateDecision, type ValidateResult } from './validate';
import type {
  DirectorDecision, DirectorEventLite, DirectorGraphicId, DirectorLogEntry, DirectorMenuItemPayload, DirectorOutcome,
  DirectorPayload, GraphicsMenu, OnScreenGraphic,
} from './types';

export interface DirectorCallResult {
  status: 'ok' | 'error' | 'aborted' | 'skipped';
  parsed?: unknown;
  timing?: CallTiming;
  error?: string;
  /** HTTP status and shared classification, when the call reached the provider. */
  statusCode?: number;
  errorKind?: LLMErrorKind;
  errorCode?: string;
  errorMessage?: string;
}

export type DirectorCaller = (request: LLMRequest, onEvent?: (e: LLMEvent) => void) => Promise<DirectorCallResult>;

export interface DirectorContext {
  /** Wall-clock seconds (performance.now()/1000 in the extension). */
  nowS: number;
  /** Video time of the latest frame. */
  t: number;
  playbackRate: number;
  liveness: Liveness;
  scene: SceneKind;
  ballState: BallState;
  ballXY: [number, number] | null;
  match: MatchState;
  out: EngineOutput;
  events: Event[];
  liveIds: number[];
  /** Fresh live ids at arrival; falls back to the call-time list. */
  liveIdsNow?: () => number[];
  onScreen: OnScreenGraphic | null;
  sinceLastGraphicS: number | null;
  calm: { ready: boolean; reason: string };
}

export interface DirectorOptions {
  /** Tick cadence during live play, seconds. */
  intervalS?: number;
  /** Minimum wall gap between any two calls, including event triggers. */
  minGapS?: number;
  staleS?: number;
  repeatS?: number;
  now?: () => number;
}

const r1 = (v: number): number => Math.round(v * 10) / 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function eventLite(e: Event): DirectorEventLite {
  const detail: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(e.detail)) if (typeof v === 'number' || typeof v === 'string') detail[k] = typeof v === 'number' ? r2(v) : v;
  return { type: e.type, t: r1(e.t), team: e.team, conf: r2(e.confidence), detail };
}

export function buildPayload(ctx: DirectorContext, menu: GraphicsMenu): DirectorPayload {
  const items: DirectorMenuItemPayload[] = menu.items.map((it) => ({
    id: it.id, label: it.label, kind: it.kind, targets: it.targets, team: it.team,
    confidence: r2(it.fact.confidence), sinceS: r1(it.fact.sinceS), ...it.data,
  }));
  const p = ctx.match.possession.value;
  return {
    clock: ctx.match.scout?.clock ?? fmtClock(ctx.t),
    t: r1(ctx.t),
    scene: ctx.scene,
    ball: { state: ctx.ballState, x: ctx.ballXY ? r2(ctx.ballXY[0]) : null, y: ctx.ballXY ? r2(ctx.ballXY[1]) : null },
    possession: { A: Math.round(p.A), B: Math.round(p.B), current: p.current as Team | 'NONE' },
    live: ctx.liveIds,
    events: ctx.events.filter((e) => ctx.t - e.t <= 20).slice(-10).map(eventLite),
    menu: items,
    screen: ctx.onScreen ? { graphic: ctx.onScreen.id, forS: r1(ctx.onScreen.sinceS) } : null,
    sinceLastGraphicS: ctx.sinceLastGraphicS === null ? null : r1(ctx.sinceLastGraphicS),
    calm: { state: ctx.calm.ready ? 'ready' : 'busy', reason: ctx.calm.reason },
  };
}

/** Any number the model writes must already exist in the payload (guardrail 1). */
export function allowedNumbers(payload: DirectorPayload): Set<string> {
  const out = new Set<string>();
  const collect = (v: unknown): void => {
    if (typeof v === 'number' && Number.isFinite(v)) { out.add(String(v)); out.add(String(Math.round(v))); }
    else if (typeof v === 'string') for (const m of v.matchAll(/\d+(?:\.\d+)?/g)) out.add(m[0]);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(payload);
  for (const id of payload.live) out.add(String(id));
  return out;
}

export function scrub(text: string, allowed: ReadonlySet<string>): string {
  return text.replace(/\b\d+(?:\.\d+)?\b/g, (n) => (allowed.has(n) ? n : '')).replace(/\s{2,}/g, ' ').trim();
}

export function scrubDecision(parsed: unknown, allowed: ReadonlySet<string>): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const d = parsed as Record<string, unknown>;
  return {
    ...d,
    caption: typeof d.caption === 'string' ? scrub(d.caption, allowed) : d.caption,
    say: typeof d.say === 'string' ? scrub(d.say, allowed) : d.say,
  };
}

/**
 * One director. `tick` is called on a timer and on rule events; it never overlaps a call and keeps
 * the last 10 decisions for ?perf=1. The caller decides how to reach the provider (background port,
 * in-page mock, or a test double).
 */
export class Director {
  readonly log: DirectorLogEntry[] = [];
  private lastShown = new Map<string, number>();
  private lastCallAt = -Infinity;
  private busy = false;
  private seq = 0;
  private now: () => number;

  constructor(private call: DirectorCaller, private o: DirectorOptions = {}) {
    this.now = o.now ?? (() => Date.now() / 1000);
  }

  get lastCallS(): number { return this.lastCallAt; }
  get calls(): number { return this.seq; }
  get shown(): ReadonlyMap<string, number> { return this.lastShown; }

  /** True when a tick should fire now. Event ticks still respect a short minimum gap. */
  due(ctx: DirectorContext, force = false): boolean {
    if (this.busy) return false;
    if (ctx.liveness !== 'LIVE' || ctx.scene !== 'WIDE') return false;
    const gap = this.o.minGapS ?? 0.8;
    const elapsed = ctx.nowS - this.lastCallAt;
    if (elapsed < gap) return false;
    return force || elapsed >= (this.o.intervalS ?? 2);
  }

  async tick(ctx: DirectorContext, force = false): Promise<DirectorOutcome | null> {
    if (!this.due(ctx, force)) return null;
    this.busy = true;
    this.lastCallAt = ctx.nowS;
    const live = new Set(ctx.liveIds);
    const menu = buildMenu(ctx.out, ctx.t, live);
    const payload = buildPayload(ctx, menu);
    const request: LLMRequest = {
      lane: 'director',
      framesSent: 0,
      schema: { name: DIRECTOR_SCHEMA_NAME, schema: DIRECTOR_SCHEMA },
      maxCompletionTokens: DIRECTOR_MAX_TOKENS,
      reasoningEffort: 'low',
      messages: [
        { role: 'system', content: DIRECTOR_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    };
    const started = this.now();
    let res: DirectorCallResult;
    try {
      res = await this.call(request);
    } catch (err) {
      res = { status: 'error', error: String((err as Error)?.message ?? err) };
    } finally {
      this.busy = false;
    }
    const arrival = this.now();
    const timing = res.timing ?? null;
    // The snapshot ages in video time: at 2x a 1.5 s wait is 3 s of play.
    const ageS = Math.max(0, (arrival - started) * Math.max(0.25, ctx.playbackRate));
    const liveNow = new Set(ctx.liveIdsNow ? ctx.liveIdsNow() : ctx.liveIds);
    const allowed = allowedNumbers(payload);
    let v: ValidateResult;
    if (res.status === 'ok' && res.parsed !== undefined) {
      v = validateDecision({
        decision: scrubDecision(res.parsed, allowed), menu, liveIds: liveNow, ageS, nowS: arrival,
        onScreen: ctx.onScreen, calm: ctx.calm, lastShown: this.lastShown,
        staleS: this.o.staleS, repeatS: this.o.repeatS,
      });
    } else {
      v = { ok: false, reason: res.status === 'ok' ? 'schema: empty JSON' : `${res.status}${res.error ? `: ${res.error}` : ''}` };
    }
    const raw = (res.parsed && typeof res.parsed === 'object' ? res.parsed : {}) as Partial<DirectorDecision>;
    const log: DirectorLogEntry = {
      at: arrival, requestT: ctx.t,
      action: v.decision?.action ?? (typeof raw.action === 'string' ? raw.action : 'invalid'),
      graphic: v.decision?.graphic ?? (typeof raw.graphic === 'string' ? raw.graphic : 'unknown'),
      ttftMs: Math.round(timing?.ttftMs ?? 0), totalMs: Math.round(timing?.totalMs ?? 0),
      accepted: v.ok, reason: v.reason,
      caption: v.decision?.caption ?? (typeof raw.caption === 'string' ? raw.caption.slice(0, 80) : ''),
    };
    if (v.ok && v.decision) {
      this.seq++;
      if (v.decision.action === 'show' && v.decision.graphic !== 'none') this.lastShown.set(v.decision.graphic, arrival);
    }
    this.log.push(log);
    while (this.log.length > 10) this.log.shift();
    return { decision: v.decision ?? null, accepted: v.ok, reason: v.reason, timing, log, payload };
  }

  /** Test/dev helper: clear the repeat history and the log. */
  reset(): void {
    this.lastShown.clear();
    this.log.length = 0;
    this.lastCallAt = -Infinity;
  }
}

export type DirectorRequest = LLMRequest;
export type DirectorChoice = DirectorGraphicId;
