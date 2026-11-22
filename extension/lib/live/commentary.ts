// Kimi's live side chat on the real (video) path: a dedicated commentary lane and the pause-and-ask lane.
//
// Why this exists: the director only speaks when it also shows a graphic (its `say` is optional and often
// empty), so on its own the chat stays quiet. This lane asks Kimi for ONE short, plain-words sentence about
// the mid-term picture (the last 30-90 seconds, from the match memory) every few seconds (sooner on a strong
// rule event), plus up to two follow-ups shown five seconds apart, and streams it into the chat. Ask grabs the
// current frame plus the tracking snapshot and streams the answer into the same chat.
//
// Both lanes go through the background LLM host (keys never enter the page), so Kimi is the only model in play.
// Every failure is surfaced in the chat as a muted note: the chat never sits on a typing bubble that will not resolve.
import {
  BLOCK_TOKENS, PHASES, fillerText, kimiModelError, packMatch, payloadToString, toStamp,
  type BudgetGovernor, type Event, type FrameState, type KimiLane, type KimiLine, type LLMEvent, type LLMRequest, type LaneOutcome, type LatencyStamp, type PresetId,
} from '@tacticlens/core';
import { annotatedJpeg } from '../llm/frame';
import { llmCall, type CallHandle } from '../llm/client';
import { kimiModelId } from '../llm/model';
import type { OverlayController } from '../render/controller';
import type { MediaClock } from '../video';
import { MatchMemory } from './memory';
import { stripMediaTalk } from './media-talk';
import { emptyMatch, type LiveSource } from './source';

/** Strong rule events that justify speaking again before the normal cadence is up. */
const TRIGGERS = new Set<Event['type']>(['counter_attack', 'high_press', 'overload', 'momentum_flip']);

/** A busy refusal is retried up to three attempts in total, with these jittered base delays before attempts 2 and 3. */
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = [700, 1800] as const;
/** Output caps: reasoning tokens count against these, so the ask cap is generous. */
const COMMENTARY_MAX_TOKENS = 300;
/** How many recently said lines Kimi is shown so it does not repeat itself. */
const RECENT_LINES = 6;
const ASK_MAX_TOKENS = 600;
const ASK_RETRY_MAX_TOKENS = 800;

/** A viewer's question is retried every ~10 s (jittered) for as long as Kimi stays busy; the typing bubble stays on meanwhile. */
const ASK_RETRY_EVERY_MS = 10_000;
const EMPTY_ASK_NOTE = "Kimi couldn't read that one. Try asking again.";

const SCHEMA_NAME = 'live_line';
/** Pause-and-ask still asks for one answer. */
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['say', 'phase'],
  properties: {
    say: { type: 'string' },
    phase: { type: 'string', enum: [...PHASES] },
  },
} as const;

/** Commentary writes one short sentence plus up to two follow-ups: `say` shows at once, `next` five seconds apart. */
const COMMENTARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['say', 'next', 'phase'],
  properties: {
    say: { type: 'string' },
    next: { type: 'array', items: { type: 'string' } },
    phase: { type: 'string', enum: [...PHASES] },
  },
} as const;

const COMMENTARY_SYSTEM = `You are the live commentator for a football match, talking to a casual fan.
Your input is a short digest of the last few minutes: scout (the two teams, A and B, as "Team <colour>"), possessionNow, tactics (formations, attack direction and tactics.facts, the rule facts that are true right now), memory (per-minute rows where momentum is signed toward the first team in memory.teams, plus phases) and recent (what you already said).
Reply with JSON {"say": string, "next": string[], "phase": string}.
- say: ONE short sentence, at most 16 words, about what is happening right now, in plain words.
- next: zero to two more short sentences, each from a different angle; they are shown about five seconds after say.
- Start from tactics.facts and say why the play looks the way it does: overload.team has the extra attackers, pressTrap.onBall is the side being trapped (so the pressers are the OTHER team), freePlayer.team has the spare man, passingLane.team has the open options, switchArc.team and counterRun.team are the attackers, possessionSwing.team is gaining the ball. When tactics.facts is empty, comment on the phase, the possession or the momentum trend.
- Refer to teams ONLY as "Team <colour>", exactly as written in scout.A and scout.B; never club names or the letters A or B. Refer to players only by position or area ("Team Yellow's right back", "down Team Orange's left"); never write player ids, [[...]] tags, shirt numbers or names.
- Never invent scores, numbers or facts that are not in the digest. Do not repeat or rephrase anything in recent; vary the theme.
- Sound like a live commentator: never mention any picture, frame, image, annotation, tracker, data, payload, JSON, memory or tool.
- phase is one of build_up, press, transition, settled, set_piece, none.

Everything after this line is a background glossary, kept only so repeat calls reuse the cached prefix. Ignore it.`;

/** Pad the stable system prefix to the first 1024-token cache block (Cerebras caches matching prefixes). */
const COMMENTARY_STABLE = `${COMMENTARY_SYSTEM}\n\n${fillerText(Math.max(0, Math.floor(BLOCK_TOKENS * 3.5) - COMMENTARY_SYSTEM.length - 2))}`;

const ASK_SYSTEM = `You are Kimi, a football analyst watching the match live. A viewer paused the match and asked you a question.
You get the question, a compact snapshot of this moment (scout names and kit colours, ball, stats, rule events), a long-term memory the system built while the match played, and the current picture of the pitch, where each player is marked in their team colour and the ball is circled.
Reply with JSON {"say": string, "phase": string}.
- A stat marked "paused" only means the ball is out of play or the picture is frozen right now. It is NEVER a reason to refuse or to say you cannot tell.
- Answer from memory first. memory.lastKnownStats has the latest real value of each stat with agoS (seconds of match time since it was seen); memory.minutes is the per-video-minute history (every pair is [teams[0], teams[1]]; momentum there is positive for teams[0]); memory.events are recent rule events (agoS = how long ago); memory.said is what was said earlier; memory.phases tallies the play phases. tactics.facts are the rule-computed mechanisms valid right now (overload, pressTrap, freePlayer, passingLane, switchArc, counterRun, spacePocket, possessionSwing, marking). Prefer a mechanism from tactics.facts over restating a stat: if you mention pressure or a free player, say who is causing it and what it opens. Combine all of it with the snapshot and the pitch you can see.
- When a value is not fresh, say how old it is in a few words (for example "about 8 s ago"); do not mention freshness when it is under 3 s.
- Say you do not know only when neither the memory, the snapshot nor the pitch has anything relevant, and then say in one short sentence what you do know.
- say: answer the question directly in at most two short sentences, 35 words in total, in plain words a casual fan understands.
- Refer to teams ONLY as "Team <colour>", exactly as written in scout.A and scout.B (memory uses the same names); never club names or the letters A or B.
- Refer to players only by position or area ("Team Yellow's right back", "the Team Orange midfield", "down Team Yellow's left"). Never write player ids, [[...]] tags, shirt numbers or names.
- Never invent ids, names, scores, numbers or facts that are not in the memory, the snapshot or on the pitch.
- You are a live commentator: say "right now" or "at this moment" rather than describing what you were given. Never mention any picture, frame, image, screenshot, annotation, tracker, data, payload, JSON, memory, stats feed or tool in what you say.
- phase is one of build_up, press, transition, settled, set_piece, none.`;

export interface CommentaryOpts {
  controller: OverlayController;
  clock: MediaClock;
  video: HTMLVideoElement;
  source: LiveSource;
  preset: PresetId;
  /** Popup setting for the Kimi model id (CEREBRAS_KIMI_MODEL). */
  kimiModel?: string;
  /** Gap between model calls, ms (default 10000). Each call returns up to three sentences, shown five seconds apart. */
  everyMs?: number;
  /** The director's shared token budget: commentary and ask run on its "analyst" lane, so every lane sees one rolling 60 s window. */
  budget?: BudgetGovernor;
}

interface RunResult {
  ok: boolean;
  aborted: boolean;
  say: string;
  extras: KimiLine[];
  error?: string;
  /** The provider refused for capacity reasons (queue full, 429, 503): worth another attempt. */
  busy?: boolean;
}

/** The first sentence-worth of an error, for a chat note. */
const brief = (e: string | undefined): string => (e ?? 'unknown error').replace(/\s+/g, ' ').trim().slice(0, 140);

/** A capacity refusal (Cerebras "high traffic" queue, a 429 or a 503): the same request is worth sending again shortly. */
function isBusy(r: { status?: number; errorKind?: string; error?: string; errorMessage?: string }): boolean {
  if (r.errorKind === 'queue_full' || r.errorKind === 'rate_limited') return true;
  if (r.status === 429 || r.status === 503) return true;
  return /high traffic|queue|too many requests/i.test(`${r.error ?? ''} ${r.errorMessage ?? ''}`);
}

/** The shared Cerebras queue is congested (HTTP 429 "queue_exceeded"): not our own rate limit, so it must not back the lane off. */
function isQueueFull(r: { errorKind?: string; error?: string; errorMessage?: string }): boolean {
  if (r.errorKind === 'queue_full') return true;
  if (r.errorKind === 'rate_limited') return false;
  return /high traffic|queue_exceeded|queue/i.test(`${r.error ?? ''} ${r.errorMessage ?? ''}`);
}

/** Jittered wait before attempt `attempt + 1` (about 700 ms, then about 1800 ms). */
const retryDelayMs = (attempt: number): number => Math.round(RETRY_BASE_MS[attempt - 1]! * (0.8 + Math.random() * 0.4));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** When the JSON did not parse (cut off by the token cap), pull the `say` string out of the raw text. */
function sayFromRaw(raw: string | undefined): string {
  if (!raw) return '';
  const m = /"say"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (!m) return '';
  try { return String(JSON.parse(`"${m[1]}"`)); } catch { return m[1] ?? ''; }
}

export class CommentaryDriver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private n = 0;
  private said: string[] = [];
  private lastCallAt = 0;
  /** Follow-up lines from the current call, exposed at 5 s intervals. */
  private queued: KimiLine[] = [];
  private nextQueuedAt = 0;
  private seenEventT = -Infinity;
  private lastNote = new Map<string, number>();
  private handles = new Set<CallHandle>();
  private stopped = false;
  private configError: string | null;
  /** Long-term memory of this match (last real stat values, per-minute rows, events, what was said); both lanes send it to Kimi. */
  readonly memory = new MatchMemory();

  constructor(private o: CommentaryOpts) {
    this.configError = o.preset === 'cerebras-kimi' ? kimiModelError(kimiModelId(o.kimiModel)) : null;
  }

  start(): void {
    if (this.timer !== null) return;
    this.stopped = false;
    if (this.configError) { this.note('cm-config', `Kimi isn't configured: ${this.configError}.`); return; }
    this.timer = setInterval(() => this.tick(), 400);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const h of this.handles) h.cancel();
    this.handles.clear();
    this.queued = [];
    this.nextQueuedAt = 0;
    this.o.controller.message({ kind: 'typing', on: false });
  }

  // ---------- commentary ----------

  private latest(): FrameState | null {
    const h = this.o.source.history;
    return h.length ? h[h.length - 1]! : null;
  }

  /** Colour words from the common controller setting, with a HUD fallback for lightweight test doubles. */
  private jerseyNames(): { A: string; B: string } {
    const c = this.o.controller as unknown as {
      jerseyNames?: { A: string; B: string };
      hud?: { m?: { jersey?: { A: string; B: string } } };
    };
    return c.jerseyNames ?? c.hud?.m?.jersey ?? { A: 'A', B: 'B' };
  }

  /**
   * The rule facts that explain *why* the picture looks the way it does. The commentary prompt is told to
   * start here, not from the stat feed; ids and confidences are deliberately left out so the model cannot
   * read a tracker number or turn this into a dashboard.
   */
  private tacticsPayload(): object | null {
    const measured = this.o.source.measure.last;
    const facts = measured?.detail?.facts;
    if (!facts) return null;
    const formation = measured?.detail?.formation;
    const j = this.jerseyNames();
    const team = (t: 'A' | 'B' | null | undefined): string | null =>
      t === 'A' ? `Team ${j.A}` : t === 'B' ? `Team ${j.B}` : null;
    const f: Record<string, unknown> = {};
    if (facts.overload.valid) {
      f.overload = {
        team: team(facts.overload.team), attackers: facts.overload.attackers,
        defenders: facts.overload.defenders, heldS: Math.round(facts.overload.sinceS),
      };
    }
    if (facts.press.valid) {
      // team is the side on the ball: the opponents are the ones trapping it.
      f.pressTrap = { onBall: team(facts.press.team), pressers: facts.press.pressers, heldS: Math.round(facts.press.sinceS) };
    }
    if (facts.freePlayer.valid) f.freePlayer = { team: team(facts.freePlayer.team), spaceM: facts.freePlayer.spaceM };
    if (facts.passing.valid) f.passingLane = { team: team(facts.passing.team), options: facts.passing.options.length };
    if (facts.switchArc.valid) f.switchArc = { team: team(facts.switchArc.team) };
    if (facts.counter.valid) f.counterRun = { team: team(facts.counter.team) };
    if (facts.pocket.valid) f.spacePocket = { gapM: facts.pocket.gapM };
    if (facts.swing.valid) {
      f.possessionSwing = { team: team(facts.swing.team), deltaPct: Math.round(facts.swing.deltaPct), windowS: Math.round(facts.swing.windowS) };
    }
    if (facts.links.valid) f.marking = { team: team(facts.links.team), pairs: facts.links.pairs.length };
    const dir = measured?.match?.attackDir?.A ?? 'unknown';
    return {
      attackDir: dir === 'unknown' ? null : { A: dir, B: dir === 'left' ? 'right' : 'left' },
      formations: { A: formation?.A ?? null, B: formation?.B ?? null },
      nearBall: { A: facts.nearBall.A, B: facts.nearBall.B },
      facts: Object.keys(f).length ? f : null,
    };
  }

  /** Feed the memory from the engine's latest stats and recent events (idempotent: safe to call every tick and at ask time). */
  private observe(f: FrameState): void {
    const { source, controller } = this.o;
    const j = this.jerseyNames();
    this.memory.ingest({
      t: f.t,
      match: source.measure.last?.match,
      events: source.measure.recent,
      labels: { A: `Team ${j.A}`, B: `Team ${j.B}` },
    });
    // Director lines reach the chat through the controller, not through this driver: pick the finished ones up from the feed.
    for (const it of controller.hud?.m.feed ?? []) {
      if (it.kind === 'kimi' && it.lane === 'director' && it.final) this.memory.addSaid({ id: it.id, text: it.text, t: f.t, phase: it.phase, by: 'director' });
    }
  }

  /** Expose one queued follow-up every 5 s so the left chat updates between model calls. */
  private flushQueued(now = performance.now()): void {
    if (!this.queued.length || now < this.nextQueuedAt) return;
    const line = this.queued.shift()!;
    this.o.controller.message({ kind: 'line', line });
    this.nextQueuedAt = this.queued.length ? now + 5000 : 0;
  }

  private tick(): void {
    if (this.stopped) return;
    const { clock, source } = this.o;
    if (clock.paused || !source.isReady) return;
    this.flushQueued();
    const f = this.latest();
    if (f) this.observe(f);
    if (this.busy || this.queued.length) return;
    if (!f || f.scene.kind !== 'WIDE' || !f.teamsCalibrated) return;
    const fresh = source.measure.recent.filter((e) => e.t > this.seenEventT + 1e-3);
    const trigger = fresh.some((e) => TRIGGERS.has(e.type) && f.t - e.t <= 2);
    const gap = performance.now() - this.lastCallAt;
    if (gap < (trigger ? 5000 : (this.o.everyMs ?? 10000))) return;
    // Shared budget: refused while a 429 backoff runs, when the ladder has switched the analyst lane off, or when this call would cross the uncached/request ceilings.
    if (this.o.budget && !this.o.budget.tryLaunch('analyst')) return;
    if (fresh.length) this.seenEventT = Math.max(this.seenEventT, ...fresh.map((e) => e.t));
    void this.commentate(f);
  }

  private async commentate(f: FrameState): Promise<void> {
    this.busy = true;
    this.lastCallAt = performance.now();
    try {
      const request: LLMRequest = {
        lane: 'reflex', framesSent: 0, schema: { name: SCHEMA_NAME, schema: COMMENTARY_SCHEMA }, maxCompletionTokens: COMMENTARY_MAX_TOKENS, reasoningEffort: 'low',
        messages: [{ role: 'system', content: COMMENTARY_STABLE }, { role: 'user', content: payloadToString(this.commentaryPayload(f)) }],
      };
      const r = await this.run(request, `cm${++this.n}`, 'watch', f.tMedia);
      if (r.ok) {
        if (r.say) this.said.push(r.say);
        for (const line of r.extras) this.said.push(line.text);
        if (r.extras.length) {
          this.queued.push(...r.extras);
          this.nextQueuedAt = performance.now() + 5000;
        }
      } else if (!r.aborted && !r.busy) this.note('cm-error', `Kimi isn't answering: ${brief(r.error)}`); // a busy refusal stays silent: the next tick tries again and only real lines reach the chat
    } finally {
      this.busy = false;
    }
  }

  /** Mid-term digest for the commentary lane: no tracks, no velocities, no ids. Roughly 600 tokens at most. */
  private commentaryPayload(f: FrameState): object {
    const j = this.jerseyNames();
    const m = this.memory.toPayload(f.t, { maxChars: 1000 });
    // Kimi needs the facts, the recent trend and what it already said: no raw stat feed.
    const minutes = m.minutes.slice(-3).map((row) => {
      const out = { ...row };
      delete out.pressure;
      delete out.freePlayers;
      return out;
    });
    return {
      scout: { A: `Team ${j.A}`, B: `Team ${j.B}` },
      possessionNow: this.memory.lastKnown('possession', f.t),
      tactics: this.tacticsPayload(),
      memory: {
        teams: m.teams,
        minutes,
        ...(m.phases ? { phases: m.phases } : {}),
      },
      recent: this.said.slice(-RECENT_LINES),
    };
  }

  // ---------- ask ----------

  /** Pause-and-ask: stream Kimi's answer about the current frame into the chat. */
  async ask(question: string): Promise<void> {
    const q = question.trim();
    if (!q) return;
    if (this.configError) { this.note('ask-error', `Kimi isn't configured: ${this.configError}.`); return; }
    const wait = this.o.budget?.backoffLeftMs('analyst') ?? 0;
    if (wait > 0) { this.note('ask-error', `Kimi is at its per-minute limit. Try again in ${Math.ceil(wait / 1000)} s.`); return; }
    const f = this.latest();
    if (!f) { this.note('ask-error', "Kimi can't read the pitch yet. Let the video play for a few seconds, then ask again."); return; }
    // Take one more reading now (the clock may be paused, so no tick has run): paused stats never overwrite what memory already knows.
    this.observe(f);
    const payload = { ...(this.payload(f, 3) ?? {}), memory: this.memory.toPayload(f.t) };
    let image: string | undefined;
    try { image = await this.grab(f); } catch { /* text-only is still a fair answer */ }
    const build = (img: string | undefined, maxTokens: number): LLMRequest => {
      const text = `Viewer question: ${JSON.stringify(q)}\n${payloadToString(payload)}`;
      return {
        lane: 'ask', framesSent: img ? 1 : 0, schema: { name: SCHEMA_NAME, schema: SCHEMA }, maxCompletionTokens: maxTokens, reasoningEffort: 'low',
        messages: [
          { role: 'system', content: ASK_SYSTEM },
          { role: 'user', content: img ? [{ type: 'image_url', image_url: { url: img } }, { type: 'text', text }] : text },
        ],
      };
    };
    const id = `ask${++this.n}`;
    let r = await this.run(build(image, ASK_MAX_TOKENS), id, 'ask', f.tMedia);
    // If the picture was the problem (an endpoint without image input), try once more on the data alone.
    if (!r.ok && !r.aborted && !r.busy && image) r = await this.run(build(undefined, ASK_MAX_TOKENS), id, 'ask', f.tMedia);
    // An empty answer usually means the reasoning used the whole cap: one more text-only try with a larger cap.
    if (r.ok && !r.say && !this.stopped) r = await this.run(build(undefined, ASK_RETRY_MAX_TOKENS), id, 'ask', f.tMedia);
    if (this.stopped || r.aborted) return;
    if (!r.ok) this.note('ask-error', `Kimi couldn't answer: ${brief(r.error)}`);
    else if (!r.say) this.note('ask-error', EMPTY_ASK_NOTE);
  }

  // ---------- plumbing ----------

  /** The compact tracking + stats snapshot (same packer the lanes use), plus the last rule events. Used by ask only. */
  private payload(f: FrameState, seconds: number): object | null {
    const hist = this.o.source.history.slice();
    const match = this.o.source.measure.last?.match ?? emptyMatch('LIVE');
    const base = packMatch(hist, match, { seconds, includeVelocity: true, said: this.said });
    if (!base) return null;
    const events = this.o.source.measure.recent.filter((e) => f.t - e.t <= 10).slice(-6)
      .map((e) => ({ type: e.type, t: Math.round(e.t * 10) / 10, team: e.team, conf: Math.round(e.confidence * 100) / 100, ...e.detail }));
    // Teams are called by jersey colour everywhere (chat chips use the same words): hand Kimi "Team Red", not club names.
    // Kit hexes come from the same measured colour setting as the overlay.
    const j = this.jerseyNames();
    const kit = this.o.controller.teamColours;
    const named = base.scout
      ? { ...base, scout: { ...base.scout, A: `Team ${j.A}`, B: `Team ${j.B}`, ...(kit ? { kitA: kit.A, kitB: kit.B } : {}) } }
      : base;
    const tactics = this.tacticsPayload();
    const withEvents = events.length ? { ...named, events } : named;
    return tactics ? { ...withEvents, tactics } : withEvents;
  }

  /** One annotated 768 px JPEG of the current picture. */
  private async grab(f: FrameState): Promise<string> {
    const v = this.o.video;
    if (!v.videoWidth) throw new Error('no picture');
    const w = 768, h = Math.max(2, Math.round((w * v.videoHeight) / v.videoWidth));
    const bmp = await createImageBitmap(v, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' });
    try {
      const col = this.o.controller.teamColours ?? f.teamColours;
      const jpg = await annotatedJpeg(bmp, f, { width: w, quality: 0.72, ...(col ? { colours: { A: col.A, B: col.B } } : {}) });
      return jpg.dataUrl;
    } finally { bmp.close(); }
  }

  /** Player ids never reach the chat: strip every complete [[id]] tag and a half-streamed one ("[[1", "[[12]"). Media talk goes too. */
  private scrub(text: string): string {
    return stripMediaTalk(text.replace(/\[\[\d*\]?\]?/g, ''))
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /**
   * One chat call with capacity retries: a busy refusal is sent again, with jittered waits (up to three attempts
   * for commentary, every ~10 s without limit for a question). The typing bubble stays on across the retries.
   * Resolves when the call ends; never throws.
   */
  private async run(request: LLMRequest, id: string, lane: KimiLane, snapshotT: number): Promise<RunResult> {
    const ctl = this.o.controller;
    ctl.message({ kind: 'typing', on: true });
    try {
      let r = await this.runOnce(request, id, lane, snapshotT);
      // Commentary gives up after three quick attempts (its next tick tries again); a question keeps going every ~10 s until it is answered or the driver stops.
      for (let attempt = 1; r.busy && (lane === 'ask' || attempt < RETRY_ATTEMPTS); attempt++) {
        await sleep(lane === 'ask' ? Math.round(ASK_RETRY_EVERY_MS * (0.8 + Math.random() * 0.4)) : retryDelayMs(attempt));
        if (this.stopped) return { ok: false, aborted: true, say: '', extras: [] };
        r = await this.runOnce(request, id, lane, snapshotT);
      }
      return r;
    } finally {
      ctl.message({ kind: 'typing', on: false });
    }
  }

  /** A single streamed Kimi attempt into the chat. */
  private async runOnce(request: LLMRequest, id: string, lane: KimiLane, snapshotT: number): Promise<RunResult> {
    const ctl = this.o.controller;
    const partial: LatencyStamp = { provider: this.o.preset, lane, ttftMs: 0, totalMs: 0, tokensIn: 0, tokensOut: 0, tokPerS: 0, framesSent: request.framesSent ?? 0 };
    const mk = (text: string, stamp: LatencyStamp, phase: KimiLine['phase'] = 'none', lineId = id): KimiLine => ({
      id: lineId, text, mentions: [], phase, lane, stamp, snapshotT,
    });
    const onEvent = (e: LLMEvent): void => {
      if (e.type !== 'say') return;
      const text = this.scrub(e.text);
      if (text) ctl.message({ kind: 'line', line: mk(text, partial) });
    };
    let outcome: LaneOutcome;
    const budget = this.o.budget;
    const handle = llmCall(this.o.preset, request, { onEvent, policy: 'parallel' });
    this.handles.add(handle);
    budget?.begin('analyst');
    try { outcome = await handle.done; } finally { this.handles.delete(handle); budget?.end('analyst'); }
    if (budget && outcome.status !== 'skipped') {
      const tm = outcome.result.timing;
      if (tm?.usageReported) budget.record({ lane: 'analyst', prompt: tm.tokensIn, cached: tm.cachedTokens ?? 0, completion: tm.tokensOut, ok: outcome.status === 'ok' });
      // Only a real rate limit backs the lane off. A congested shared queue (HTTP 429 queue_exceeded) is just retried:
      // backing off for it blocked every later commentary call, and made typed questions fail as "per-minute limit".
      if (isQueueFull(outcome.result)) budget.noteRetry('analyst');
      else if (outcome.result.status === 429 || outcome.result.errorKind === 'rate_limited') budget.note429('analyst', outcome.result.retryAfterMs);
      else if (outcome.status === 'ok') budget.noteOk('analyst');
    }
    if (outcome.status === 'aborted') return { ok: false, aborted: true, say: '', extras: [] };
    if (outcome.status === 'skipped') return { ok: false, aborted: false, say: '', extras: [], error: `request skipped (${outcome.reason})` };
    if (outcome.status !== 'ok') {
      return { ok: false, aborted: false, say: '', extras: [], error: outcome.result.error ?? outcome.status, busy: isBusy(outcome.result) };
    }
    const stamp = outcome.stamp ?? toStamp(outcome.result.timing);
    ctl.message({ kind: 'call', ms: stamp.totalMs, lane });
    const p = outcome.result.parsed as { say?: unknown; next?: unknown; phase?: unknown } | undefined;
    // A reply cut off by the token cap has no parsed JSON: the say string may still be in the raw text.
    const say = this.scrub(typeof p?.say === 'string' ? p.say : sayFromRaw(outcome.result.text));
    const phase = (PHASES as readonly string[]).includes(String(p?.phase)) ? (p!.phase as KimiLine['phase']) : 'none';
    const next = Array.isArray(p?.next) ? p!.next.slice(0, 2) : [];
    const extras = next
      .map((v, i) => ({ text: typeof v === 'string' ? this.scrub(v) : '', id: `${id}-${i + 2}` }))
      .filter((v) => v.text)
      .map((v) => mk(v.text, stamp, phase, v.id));
    if (!say && !extras.length) return { ok: true, aborted: false, say: '', extras: [] };
    if (say) ctl.message({ kind: 'line', line: mk(say, stamp, phase) });
    const by = lane === 'ask' ? 'answer' : 'commentary';
    if (say) this.memory.addSaid({ id, text: say, t: snapshotT, phase, by });
    for (const line of extras) this.memory.addSaid({ id: line.id, text: line.text, t: snapshotT, phase: line.phase, by });
    return { ok: true, aborted: false, say, extras };
  }

  /** A muted chat note, at most once per 30 s per id so a failing lane cannot flood the chat. */
  private note(id: string, text: string): void {
    const now = performance.now();
    if (id !== 'ask-error' && now - (this.lastNote.get(id) ?? -Infinity) < 30_000) return;
    this.lastNote.set(id, now);
    this.o.controller.message({ kind: 'feed_note', id, text });
  }
}
