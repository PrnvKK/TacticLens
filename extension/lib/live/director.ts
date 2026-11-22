// Kimi as the TV director, wired to the live source and the renderer. The core Director builds the
// payload, calls the provider and validates; this file maps an accepted decision to intents and lines,
// keeps track of what is on screen, and feeds the ?perf=1 decision log.
import {
  BUNDLED_CALIBRATION, BudgetGovernor, DirectorPipeline, Governor, KIMI_PROMPT_SPEC, LaneRunner, PromptBuilder, SpeedMeter, WatchLane,
  buildMenu, gpuBaselineConfig, gpuBaselineStatus, kimiModelError, labelFromCaption, pickFallback, resolveProvider, speedSnapshot, toStamp, validateDecision,
  type DirectorCallResult, type DirectorContext, type DirectorGraphicId, type DirectorLogEntry, type DirectorOutcome,
  type Event, type FrameState, type KimiLine, type LaneOutcome, type LatencyStamp, type LLMEvent, type LLMRequest,
  type MatchBlock, type MockProfile, type PresetId, type GraphicType, type Prediction,
} from '@tacticlens/core';
import { llmCall, llmWarmup } from '../llm/client';
import { kimiModelId } from '../llm/model';
import { annotatedJpeg } from '../llm/frame';
import type { OverlayController } from '../render/controller';
import type { MediaClock } from '../video';
import type { LiveSource } from './source';

/** The vision lane stands down below this detection rate so Kimi load can never starve perception. */
const WATCH_MIN_DETECT_HZ = 3;

const TRIGGERS = new Set<Event['type']>(['turnover', 'switch_of_play', 'counter_attack', 'high_press', 'overload', 'momentum_flip']);

/**
 * Default cadence: 3 director calls/s (a decision every ~300 ms; the budget governor
 * steps this down if the shared uncached-token limit is tight) and one vision frame per 2.5 s. With
 * the third cache block now hit, a director call costs ~130 uncached tokens, so this rate fits the
 * 50k/min key limit and several calls overlap; the wall's aggregate rate can pass 1k tok/s instead
 * of idling between single 300-500 tok/s calls.
 */
export const DEFAULT_DIRECTOR_HZ = 3;
export const DEFAULT_WATCH_HZ = 0.4;

/** Rules-side safety net: if Kimi has shown nothing for this long, put one valid menu graphic up. */
export const FALLBACK_GAP_S = 8;
const FALLBACK_TTL_S = 5;
/** Small, neat graphics that do not need the heavy calm gate. */
const LIGHT_KINDS = new Set<GraphicType>(['tag', 'spotlight']);
/** Live pass prediction: the next pass from the current carrier to the best option. */
const PREDICT_WINDOW_S = 4;
const PREDICT_COOLDOWN_S = 14;

/** A positive number from a URL parameter, or undefined when the parameter is absent or not a rate. */
function urlRate(search: string, key: string): number | undefined {
  const v = new URLSearchParams(search).get(key);
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface DirectorDriverOpts {
  controller: OverlayController;
  clock: MediaClock;
  source: LiveSource;
  preset: PresetId;
  mockProfile?: MockProfile;
  /** Popup setting for the Kimi model id (CEREBRAS_KIMI_MODEL); no fallback model exists. */
  kimiModel?: string;
  /** Director calls per second (default 1, or ?dirhz=) and vision frames per second (default 0.4, or ?watchhz=). */
  directorHz?: number;
  watchHz?: number;
  /** false = no vision lane (debug ?watch=off). */
  watch?: boolean;
}

export class DirectorDriver {
  private pipe: DirectorPipeline;
  private watch: WatchLane;
  readonly budget: BudgetGovernor;
  readonly speed = new SpeedMeter();
  private speedTimer: ReturnType<typeof setInterval> | null = null;
  private lastWatchAt = 0;
  private watchBusy = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: { id: DirectorGraphicId; intentId: string; atT: number; durationS: number; label: string; ids: number[]; team?: 'A' | 'B'; kind: GraphicType } | null = null;
  private lastGraphicAt: number | null = null;
  private seenEventT = -Infinity;
  /** Engine events already forwarded to the HUD (video seconds), independent of the director trigger cursor. */
  private lastEventT = -Infinity;
  private lastFrameT: number | null = null;
  private lastScene: string | null = null;
  private stopped = false;
  private seq = 0;
  private runner = new LaneRunner(new Governor());
  /** Offline path: only `?mock=1` (or an explicit mock preset). Strictly never a silent fallback. */
  private mockMode: boolean;
  /** Set when Kimi/GPU is not configured; start() then only surfaces the error. */
  private configError: string | null = null;
  /** Graphics requested through the Telegram bridge, for the repeat guard. */
  private bridgeShown = new Map<string, number>();
  /** Rules fallback graphics and the last one picked, so the demo does not loop the same tag. */
  private fallbackShown = new Map<string, number>();
  private lastFallbackId: DirectorGraphicId | null = null;
  /** One live pass prediction at a time, resolved from the pass/turnover events the engine emits. */
  private pred: { id: string; carrierId: number; targetId: number; madeAt: number; windowS: number } | null = null;
  private predCooldownT = -Infinity;

  constructor(private o: DirectorDriverOpts) {
    this.mockMode = o.preset === 'mock' || (typeof location !== 'undefined' && new URLSearchParams(location.search).get('mock') === '1');
    const gpu = o.preset === 'gpu-baseline';
    const model = this.mockMode ? 'mock' : gpu ? gpuBaselineConfig().model : kimiModelId(o.kimiModel);
    if (!this.mockMode && !gpu) this.configError = kimiModelError(model);
    if (!this.mockMode && gpu) {
      const status = gpuBaselineStatus();
      if (!status.configured) this.configError = status.reason ?? 'gpu-baseline not configured';
    }
    const builder = new PromptBuilder(KIMI_PROMPT_SPEC, { model: model || 'unset', calibration: BUNDLED_CALIBRATION });
    const search = typeof location !== 'undefined' ? location.search : '';
    const dirHz = o.directorHz ?? urlRate(search, 'dirhz') ?? DEFAULT_DIRECTOR_HZ;
    const watchHz = o.watchHz ?? urlRate(search, 'watchhz') ?? DEFAULT_WATCH_HZ;
    this.budget = new BudgetGovernor({ baseDirectorHz: dirHz, baseWatchHz: watchHz });
    const match = (): MatchBlock | null => this.matchBlock();
    this.pipe = new DirectorPipeline((req, onEvent, ctl) => this.call(req, onEvent, ctl.id), {
      builder, budget: this.budget, speed: this.speed, intervalMs: Math.round(1000 / dirHz), maxInFlight: 4, maxInFlightCap: 6, repeatS: 9,
      // Mock keeps the strict schema: createMockFetch routes the scripted director answer by schema name.
      strictSchema: this.mockMode,
      now: () => performance.now(), match,
      seen: () => { const lf = this.latestFrame(); return this.watch.seen(new Set(lf ? this.liveIds(lf) : [])); },
      trail: () => this.trail(),
      fresh: () => {
        const f = this.latestFrame();
        const c = f ? this.context(f) : null;
        if (!c || !f) return null;
        return {
          liveIds: c.liveIds, onScreen: c.onScreen, calm: c.calm, playbackRate: f.playbackRate || 1,
          menu: buildMenu(c.out, c.t, new Set(c.liveIds)),
        };
      },
      onOutcome: (outcome) => this.handle(outcome),
    });
    this.watch = new WatchLane((req, onEvent) => this.call(req, onEvent, 0), { builder, budget: this.budget, speed: this.speed, match });
  }

  /** Rarely-changing match facts for the cached prefix: team names, quantised kits, formation and attack direction. */
  private matchBlock(): MatchBlock | null {
    const out = this.o.source.measure.last;
    const f = this.latestFrame();
    if (!out || !f || !f.teamsCalibrated) return null;
    // The display pair is blended then locked by KitColourTracker. Raw measured colours drift every
    // frame, which changes the match block and invalidates the third cached prompt block mid-call.
    const kit = this.o.controller.displayTeamColours ?? this.o.controller.teamColours ?? f.teamColours ?? { A: '#888888', B: '#888888' };
    const sa = out.match.shape.A, sb = out.match.shape.B;
    // Teams are called by jersey colour ("Team Red"), the same words the chat uses, so Kimi's lines never say club names or A/B.
    const j = this.o.controller.jerseyNames;
    const nameA = `Team ${j.A}`;
    const nameB = `Team ${j.B}`;
    return {
      teams: {
        A: { name: nameA, kit: kit.A, ...(sa.gate === 'shown' && sa.value.label ? { formation: sa.value.label } : {}) },
        B: { name: nameB, kit: kit.B, ...(sb.gate === 'shown' && sb.value.label ? { formation: sb.value.label } : {}) },
      },
      attack: { A: out.match.attackDir.A, B: out.match.attackDir.A === 'left' ? 'right' : out.match.attackDir.A === 'right' ? 'left' : 'unknown' },
      extra: { teamsCalibrated: true },
    };
  }

  /** Ball positions of the last ~4 s of video, one every 2 s, as percent (oldest first). */
  private trail(): [number, number][] {
    const h = this.o.source.history;
    const last = h[h.length - 1];
    if (!last) return [];
    const out: [number, number][] = [];
    for (let s = 4; s >= 0; s -= 2) {
      let best: FrameState | null = null;
      for (const fr of h) if (!best || Math.abs(fr.t - (last.t - s)) < Math.abs(best.t - (last.t - s))) best = fr;
      if (best?.ball.xy && best.ball.state === 'visible') out.push([Math.round(best.ball.xy[0] * 100), Math.round(best.ball.xy[1] * 100)]);
    }
    return out;
  }

  start(): void {
    if (this.timer !== null) return;
    if (this.configError) {
      this.o.controller.setKimiSpeed(speedSnapshot(this.budget, this.speed, {
        staleLimitS: 30, intervalMs: 330, maxInFlight: 2, directorInFlight: 0, error: this.configError,
      }));
      return;
    }
    this.stopped = false;
    // Open the connection and prime the real prefix cache while models/load settle. This is a
    // 1-token request; its failure never blocks the director.
    if (!this.mockMode) void llmWarmup(this.o.preset).catch(() => undefined);
    this.timer = setInterval(() => this.scan(), 100);
    this.speedTimer = setInterval(() => {
      this.o.controller.setKimiSpeed(speedSnapshot(this.budget, this.speed, {
        staleLimitS: this.pipe.staleLimitS,
        intervalMs: this.pipe.launchIntervalMs,
        maxInFlight: this.pipe.maxInFlightNow,
        directorInFlight: this.pipe.inFlight,
      }));
    }, 500);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.speedTimer !== null) clearInterval(this.speedTimer);
    this.speedTimer = null;
    this.pipe.cancelAll();
    this.current = null;
    this.pred = null;
  }

  /**
   * A user/agent-requested graphic from the Telegram bridge. It is not trusted: it goes through the
   * same buildMenu + validateDecision path (live ids, fact validity, repeat, on-screen and calm gate)
   * as a Kimi decision before anything is drawn.
   */
  requestGraphic(graphic: string, targets: number[], reason: string): { accepted: boolean; reason?: string } {
    const f = this.latestFrame();
    if (!f) return { accepted: false, reason: 'no frame yet' };
    if (f.scene.kind !== 'WIDE') return { accepted: false, reason: `scene is ${f.scene.kind}` };
    const ctx = this.context(f);
    if (!ctx) return { accepted: false, reason: 'no engine state yet' };
    if (ctx.liveness !== 'LIVE') return { accepted: false, reason: `not live (${ctx.liveness})` };
    const live = new Set(ctx.liveIds);
    const menu = buildMenu(ctx.out, ctx.t, live);
    const nowS = performance.now() / 1000;
    const shown = new Map<string, number>([...this.pipe.shown, ...this.bridgeShown, ...this.fallbackShown]);
    const v = validateDecision({
      decision: {
        action: 'show',
        graphic,
        targets,
        caption: reason.slice(0, 160),
        say: '',
        duration_s: 6,
        confidence: 1,
      },
      menu,
      liveIds: live,
      ageS: 0,
      nowS,
      onScreen: ctx.onScreen,
      calm: ctx.calm,
      lastShown: shown,
    });
    if (!v.ok || !v.decision) return { accepted: false, reason: v.reason ?? 'rejected' };
    const d = v.decision;
    if (d.graphic === 'none') return { accepted: false, reason: 'validator returned none' };
    const item = menu.items.find((m) => m.id === d.graphic);
    if (!item) return { accepted: false, reason: `${d.graphic} is not in the menu` };
    const label = labelFromCaption(d.caption, item.label);
    const intentId = `bridge-${++this.seq}`;
    this.o.controller.message({
      kind: 'intent',
      intent: {
        id: intentId, type: item.kind, ids: d.targets, team: item.team, label,
        enteredAt: f.tMedia, ttlS: d.duration_s, source: 'kimi',
      },
    });
    this.current = { id: d.graphic, intentId, atT: f.tMedia, durationS: d.duration_s, label, ids: d.targets, team: item.team, kind: item.kind };
    this.lastGraphicAt = nowS;
    this.bridgeShown.set(d.graphic, nowS);
    return { accepted: true };
  }

  /** Pipelined, parallel call: no per-lane replace, the budget governor owns the cadence. */
  private async call(request: LLMRequest, onEvent: (e: LLMEvent) => void, id: number): Promise<DirectorCallResult> {
    if (this.configError) return { status: 'skipped', error: this.configError };
    if (this.mockMode) {
      const out = await this.runner.run(resolveProvider('mock', ''), request, {
        policy: 'parallel', callId: 'd' + id + '-' + (++this.seq), mockProfile: this.o.mockProfile ?? 'kimi', onEvent,
      });
      return this.resultOf(out);
    }
    const out = await llmCall(this.o.preset, request, { policy: 'parallel', mockProfile: this.o.mockProfile, onEvent }).done;
    return this.resultOf(out);
  }

  private resultOf(out: LaneOutcome): DirectorCallResult {
    if (out.status === 'skipped') return { status: 'skipped', error: out.reason };
    return {
      status: out.status,
      parsed: out.result.parsed,
      timing: out.result.timing,
      ...(out.result.error ? { error: out.result.error } : {}),
      statusCode: out.result.status,
      ...(out.result.errorKind ? { errorKind: out.result.errorKind } : {}),
      ...(out.result.errorCode ? { errorCode: out.result.errorCode } : {}),
      ...(out.result.errorMessage ? { errorMessage: out.result.errorMessage } : {}),
    };
  }

  private latestFrame(): FrameState | null {
    const h = this.o.source.history;
    return h.length ? h[h.length - 1]! : null;
  }

  private liveIds(f: FrameState): number[] {
    return f.tracks
      .filter((t) => (t.cls === 'player' || t.cls === 'goalkeeper') && t.timeSinceUpdate <= 0.4 && t.age >= 0.3)
      .map((t) => t.id);
  }

  private context(f: FrameState): DirectorContext | null {
    const out = this.o.source.measure.last;
    if (!out) return null;
    const nowS = performance.now() / 1000;
    // What is on screen, measured in video time so a freeze-frame does not age it out.
    let onScreen = null as DirectorContext['onScreen'];
    if (this.current && f.t <= this.current.atT + this.current.durationS + 0.6) {
      onScreen = { id: this.current.id, sinceS: Math.max(0, f.t - this.current.atT) };
    } else {
      this.current = null;
    }
    return {
      nowS, t: f.t, playbackRate: f.playbackRate || 1,
      liveness: out.match.liveness, scene: f.scene.kind, ballState: f.ball.state, ballXY: f.ball.xy,
      match: out.match, out, events: this.o.source.measure.recent,
      liveIds: this.liveIds(f),
      liveIdsNow: () => {
        const last = this.latestFrame();
        return last ? this.liveIds(last) : [];
      },
      onScreen,
      sinceLastGraphicS: this.lastGraphicAt === null ? null : nowS - this.lastGraphicAt,
      calm: this.o.controller.calmInfo(),
    };
  }

  /**
   * Live pass prediction. The rules already score the best option; this makes one concrete call
   * ("the next pass goes to this player") and resolves it from the engine's own pass/turnover events.
   * It is the same prediction the showcase uses, now driven by live facts.
   */
  private maybePredict(ctx: DirectorContext, f: FrameState): void {
    const p = this.pred;
    if (p) {
      let status: Prediction['status'] | null = null;
      let resolvedAt: number | undefined;
      for (const e of ctx.events) {
        if (e.t <= p.madeAt) continue;
        if (e.type === 'pass') {
          if (Number(e.detail.from) !== p.carrierId) continue;
          status = Number(e.detail.to) === p.targetId ? 'hit' : 'miss';
          resolvedAt = e.t;
          break;
        }
        if (e.type === 'turnover' && Number(e.detail.carrierId) === p.carrierId) {
          status = 'miss';
          resolvedAt = e.t;
          break;
        }
      }
      if (!status && ctx.t > p.madeAt + p.windowS) {
        status = 'miss';
        resolvedAt = p.madeAt + p.windowS;
      }
      if (!status) return;
      const resolved: Prediction = {
        id: p.id, kind: 'pass_to', targetId: p.targetId, madeAt: p.madeAt, windowS: p.windowS,
        status, ...(resolvedAt !== undefined ? { resolvedAt } : {}),
      };
      this.o.controller.message({ kind: 'prediction', prediction: resolved });
      this.o.controller.message({
        kind: 'event',
        event: {
          type: status === 'hit' ? 'prediction_hit' : 'prediction_miss',
          t: resolvedAt ?? ctx.t, team: 'OTHER', confidence: 1, detail: { targetId: p.targetId },
        },
      });
      this.pred = null;
      this.predCooldownT = ctx.t + PREDICT_COOLDOWN_S;
      return;
    }
    // Do not compete with a director graphic that is already on screen, and only call it when calm.
    if (this.current || !ctx.calm.ready || ctx.t < this.predCooldownT) return;
    if (ctx.ballState === 'absent') return;
    const passing = ctx.out.detail.facts.passing;
    const opt = passing.valid ? passing.options[0] : undefined;
    if (!opt || passing.carrierId < 0) return;
    if (!ctx.liveIds.includes(passing.carrierId) || !ctx.liveIds.includes(opt.id)) return;
    const id = `pred-${++this.seq}`;
    const windowS = PREDICT_WINDOW_S;
    this.o.controller.message({ kind: 'prediction', prediction: { id, kind: 'pass_to', targetId: opt.id, madeAt: ctx.t, windowS, status: 'open' } });
    this.o.controller.message({
      kind: 'intent',
      intent: {
        id, type: 'prediction', ids: [passing.carrierId, opt.id], team: passing.team ?? undefined,
        label: 'next pass', enteredAt: f.tMedia, ttlS: windowS + 1.2, source: 'rules',
      },
    });
    this.pred = { id, carrierId: passing.carrierId, targetId: opt.id, madeAt: ctx.t, windowS };
  }

  /**
   * Rules fallback for the demo: Kimi is still the director, but if the screen has been empty for
   * FALLBACK_GAP_S and the menu already has a valid item, put the highest-value one up. The item is
   * chosen from the same fact menu and goes through the renderer's normal admission path.
   */
  private maybeFallback(ctx: DirectorContext, f: FrameState): boolean {
    if (this.current || this.pred || ctx.ballState === 'absent') return false;
    const nowS = performance.now() / 1000;
    if (this.lastGraphicAt === null) { this.lastGraphicAt = nowS; return false; }
    if (nowS - this.lastGraphicAt < FALLBACK_GAP_S) return false;
    const menu = buildMenu(ctx.out, ctx.t, new Set(ctx.liveIds));
    // Key player / spotlight are deliberately light; everything else still waits for the calm gate.
    const pickable = ctx.calm.ready ? menu : { ...menu, items: menu.items.filter((i) => LIGHT_KINDS.has(i.kind)) };
    const shown = new Map<string, number>([...this.pipe.shown, ...this.bridgeShown, ...this.fallbackShown]);
    const item = pickFallback(pickable, { nowS, repeatS: 9, lastShown: shown, avoid: this.lastFallbackId });
    if (!item) return false;
    const ttlS = LIGHT_KINDS.has(item.kind) ? FALLBACK_TTL_S : FALLBACK_TTL_S + 1;
    const intentId = `rule-${++this.seq}`;
    this.o.controller.message({
      kind: 'intent',
      intent: {
        id: intentId, type: item.kind, ids: item.targets, team: item.team, label: item.label,
        enteredAt: f.tMedia, ttlS, source: 'rules',
      },
    });
    this.current = { id: item.id, intentId, atT: f.tMedia, durationS: ttlS, label: item.label, ids: item.targets, team: item.team, kind: item.kind };
    this.lastGraphicAt = nowS;
    this.lastFallbackId = item.id;
    this.fallbackShown.set(item.id, nowS);
    this.pipe.noteShown(item.id, performance.now());
    return true;
  }

  private scan(): void {
    if (this.stopped) return;
    const f = this.latestFrame();
    if (!f) return;
    // A backward seek starts a fresh decision window; any scene change cleared the renderer.
    if (this.lastFrameT !== null && f.t < this.lastFrameT - 0.5) {
      this.current = null;
      this.pred = null;
      this.fallbackShown.clear();
      this.lastFallbackId = null;
      this.predCooldownT = -Infinity;
      this.seenEventT = f.t;
      this.lastEventT = f.t;
    }
    if (this.lastScene !== null && f.scene.kind !== this.lastScene) { this.current = null; this.pred = null; }
    this.lastScene = f.scene.kind;
    this.lastFrameT = f.t;
    if (this.o.clock.paused || !this.o.source.isReady) return;
    if (f.scene.kind !== 'WIDE' || !f.teamsCalibrated) return;
    const fresh = this.o.source.measure.recent.filter((e) => e.t > this.seenEventT + 1e-3);
    // Rules toasts are suppressed while the director is active; forward the engine's events here so
    // pass / spell / line-height / formation changes reach the HUD. Start from the newest event on the
    // first scan: do not replay the last 30 s of history as a toast burst.
    if (this.lastEventT === -Infinity) {
      const h = this.o.source.measure.recent;
      this.lastEventT = h.length ? h[h.length - 1]!.t : f.t - 0.001;
    }
    for (const e of this.o.source.measure.recent) {
      if (e.t <= this.lastEventT + 1e-3) continue;
      this.lastEventT = e.t;
      this.o.controller.message({ kind: 'event', event: e });
    }
    // An event older than ~2 s of play is no longer "immediate"; the 2 s cadence covers it.
    const trigger = fresh.some((e) => TRIGGERS.has(e.type) && f.t - e.t <= 2);
    const ctx = this.context(f);
    if (!ctx) return;
    this.maybeWatch(f);
    this.maybePredict(ctx, f);
    if (this.maybeFallback(ctx, f)) return;
    if (!this.pipe.due(ctx, trigger)) {
      // Keep a trigger pending through a burst guard, but do not replay ordinary events later.
      if (!trigger && fresh.length) this.seenEventT = Math.max(this.seenEventT, ...fresh.map((e) => e.t));
      return;
    }
    if (this.pipe.pump(ctx, trigger) !== null && fresh.length) this.seenEventT = Math.max(this.seenEventT, ...fresh.map((e) => e.t));
  }

  /**
   * Vision lane: one annotated 768x432 JPEG per interval (the budget governor sets the interval; null = off).
   * Perception always wins: the grab is skipped while detection is behind, runs only in an idle slice, is
   * resized off-thread at grab time (never a native 4K bitmap) and the JPEG is encoded by OffscreenCanvas.
   */
  private maybeWatch(f: FrameState): void {
    const iv = this.budget.rates().watchIntervalMs;
    const video = this.o.clock as unknown as HTMLVideoElement;
    if (this.o.watch === false || iv === null || this.watchBusy || typeof video.videoWidth !== 'number' || !video.videoWidth) return;
    const hz = this.o.source.stats?.hz;
    if (typeof hz === 'number' && Number.isFinite(hz) && hz < WATCH_MIN_DETECT_HZ) return;   // detection is behind: do not compete
    const now = performance.now();
    if (now - this.lastWatchAt < iv) return;
    this.lastWatchAt = now;
    this.watchBusy = true;
    const grab = (): void => {
      void (async () => {
        try {
          if (this.stopped) return;
          const w = 768, h = Math.max(2, Math.round((w * video.videoHeight) / video.videoWidth));
          const bmp = await createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' });
          const col = this.o.controller.teamColours ?? f.teamColours;
          const jpg = await annotatedJpeg(bmp, f, { width: w, quality: 0.7, ...(col ? { colours: { A: col.A, B: col.B } } : {}) });
          bmp.close();
          await this.watch.tick(jpg.dataUrl, { t: f.t, ids: this.liveIds(f) });
        } catch { /* a failed capture only skips this second */ } finally { this.watchBusy = false; }
      })();
    };
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(grab, { timeout: 1500 }); else setTimeout(grab, 0);
  }

  private handle(outcome: DirectorOutcome): void {
    const f = this.latestFrame();
    if (!f || this.stopped) return;
    this.o.controller.setDirectorLog(this.pipe.log.slice(-5));
    this.emitCall(outcome);
    // The play can move to a replay/close-up while the call is in flight; never draw across that seam.
    const latest = this.latestFrame();
    if (!latest || latest.scene.kind !== 'WIDE') { this.current = null; return; }
    if (!outcome.accepted || !outcome.decision) return;
    const d = outcome.decision;
    const text = (d.say || d.caption || '').trim();
    if (text) this.emitLine(text, outcome, f);

    if (d.action === 'show' && d.graphic !== 'none') {
      const item = outcome.payload.menu.find((m) => m.id === d.graphic);
      const kind: GraphicType = item?.kind ?? 'spotlight';
      const label = labelFromCaption(d.caption, item?.label ?? d.graphic);
      const intentId = `dir-${++this.seq}`;
      this.o.controller.message({
        kind: 'intent',
        intent: {
          id: intentId, type: kind, ids: d.targets, team: item?.team, label,
          enteredAt: f.tMedia, ttlS: d.duration_s, source: 'kimi',
        },
      });
      this.current = { id: d.graphic, intentId, atT: f.tMedia, durationS: d.duration_s, label, ids: d.targets, team: item?.team, kind };
      this.lastGraphicAt = performance.now() / 1000;
      return;
    }
    if (d.action === 'hide') {
      if (this.current) this.o.controller.message({ kind: 'clear', id: this.current.intentId });
      this.current = null;
      return;
    }
    if (d.action === 'keep' && this.current) {
      // The renderer re-asserts the intent with a fresh TTL; keep our on-screen clock in step.
      this.current.atT = f.tMedia;
      this.current.durationS = d.duration_s;
      this.o.controller.message({
        kind: 'intent',
        intent: {
          id: this.current.intentId, type: this.current.kind, ids: this.current.ids, team: this.current.team,
          label: this.current.label, enteredAt: f.tMedia, ttlS: this.current.durationS, source: 'kimi',
        },
      });
    }
  }

  private emitCall(outcome: DirectorOutcome): void {
    if (!outcome.timing) return;
    const stamp = toStamp(outcome.timing);
    this.o.controller.message({ kind: 'call', ms: stamp.totalMs, lane: 'director' });
  }

  private emitLine(text: string, outcome: DirectorOutcome, f: FrameState): void {
    const stamp: LatencyStamp = outcome.timing
      ? toStamp(outcome.timing)
      : { provider: this.o.preset, lane: 'director', ttftMs: 0, totalMs: 0, tokensIn: 0, tokensOut: 0, tokPerS: 0, framesSent: 0 };
    const live = new Set(this.liveIds(f));
    const mentions = [...text.matchAll(/\[\[(\d+)\]\]/g)].map((m) => Number(m[1])).filter((id) => live.has(id));
    const line: KimiLine = {
      id: `dir${++this.seq}`, text, mentions, phase: 'none', lane: 'director', stamp, snapshotT: f.tMedia,
    };
    this.o.controller.message({ kind: 'line', line });
  }

  /** Last decisions, for a host that wants to show them outside the HUD. */
  get log(): DirectorLogEntry[] { return this.pipe.log; }
}
