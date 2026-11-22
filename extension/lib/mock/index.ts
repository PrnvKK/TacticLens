// Mock perception + Kimi source. Runs the whole UI offline from a scripted ~70 s timeline that walks through
// every overlay state and every primitive. Drive it with a real <video> clock or a VirtualClock.
import type { Event, EventType, GraphicIntent, GraphicType, KimiLane, KimiLine, Prediction } from '@tacticlens/core';
import type { PerceptionMeta, PerceptionSource, SourceSink, UiMessage } from '../render/ui-types';
import type { MediaClock } from '../video';
import { LOOP, PASS, SEQ, ballAt, carrierAt, receiverAfter, snapshotAt } from './world';

export { LOOP, snapshotAt, phaseAt, carrierAt, receiverAfter, SEQ, PASS, MOCK_SCOUT } from './world';

export type MockVariant = 'fast' | 'slow';
export interface MockOpts {
  clock: MediaClock;
  /** 'slow' replays the same timeline as a laggy GPU baseline provider (the race's right pane). */
  variant?: MockVariant;
  label?: string;
  /** Emit race footer / thinking messages. */
  race?: boolean;
}

interface Ctx {
  st: number;
  say(text: string, o?: { lane?: KimiLane; phase?: KimiLine['phase'] }): void;
  intent(type: GraphicType, ids: number[], o?: { team?: 'A' | 'B'; label?: string; ttlS?: number; source?: 'rules' | 'kimi'; id?: string }): string;
  event(type: EventType, team?: 'A' | 'B', e2g?: number): void;
  predict(kind: Prediction['kind'], targetId: number, windowS: number): string;
  resolve(id: string, status: 'hit' | 'miss', at: number): void;
  later(t: number, fn: (c: Ctx) => void): void;
  msg(m: UiMessage): void;
  clear(): void;
  carrier(): number;
}
type Step = { t: number; fn: (c: Ctx) => void };

const SLOW_TTFT = [2400, 1100, 2900, 2600, 1300, 3100];

export class MockSource implements PerceptionSource {
  private sink: SourceSink | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private clock: MediaClock;
  private variant: MockVariant;
  private lastSt: number | null = null;
  private queue: Step[] = [];
  private seq = 0;
  private lines = 0;
  private onTime = 0;
  private pausedTick = 0;
  private rnd = 7;
  private lastTs = 0;
  private preds = new Map<string, Prediction>();
  /** Tracked stream/delay timers: cancelled on seek/loop so a stray line cannot land on the new position. */
  private inflight = new Set<ReturnType<typeof setTimeout>>();
  readonly label: string;
  private raceMode: boolean;

  constructor(o: MockOpts) {
    this.clock = o.clock;
    this.variant = o.variant ?? 'fast';
    this.label = o.label ?? (this.variant === 'fast' ? 'Cerebras - Kimi K3.1 Pro' : 'GPU baseline');
    this.raceMode = !!o.race;
  }

  setRace(on: boolean): void { this.raceMode = on; }
  private rand(): number { this.rnd = (this.rnd * 1664525 + 1013904223) % 4294967296; return this.rnd / 4294967296; }

  start(sink: SourceSink): void {
    this.sink = sink;
    this.lastSt = null;
    this.rebuild(0);
    this.schedule();
  }
  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; this.dropInflight(); this.sink = null; }

  private to(fn: () => void, ms: number): void {
    const id = setTimeout(() => { this.inflight.delete(id); fn(); }, ms);
    this.inflight.add(id);
  }
  private dropInflight(): void {
    for (const id of this.inflight) clearTimeout(id);
    this.inflight.clear();
  }
  async process(bitmap: ImageBitmap, _meta: PerceptionMeta): Promise<void> {
    bitmap.close();
    await new Promise((r) => setTimeout(r, 4)); // the brain "acks" shortly after
  }

  // ---------- scheduling ----------
  private schedule(): void {
    this.timer = setTimeout(() => { this.tick(); if (this.sink) this.schedule(); }, 85 + this.rand() * 45);
  }

  private rebuild(fromSt: number): void {
    this.queue = TIMELINE.filter((s) => s.t > fromSt).map((s) => ({ ...s }));
    if (this.variant === 'fast') for (let t = 3.4; t < LOOP - 1; t += 1.9) this.queue.push({ t: t + (t % 1) * 0.1, fn: (c) => c.msg({ kind: 'call', ms: 170 + this.rand() * 170, lane: 'watch' }) });
    else for (let t = 4; t < LOOP - 1; t += 3.3) this.queue.push({ t, fn: (c) => c.msg({ kind: 'call', ms: 1500 + this.rand() * 1600, lane: 'watch' }) });
    this.queue.sort((a, b) => a.t - b.t);
  }

  private tick(): void {
    const sink = this.sink;
    if (!sink) return;
    const ts = this.clock.currentTime;
    const st = ts % LOOP;
    if (this.lastSt === null || st < this.lastSt - 0.05 || st - this.lastSt > 2) {
      if (this.lastSt !== null) { sink.message({ kind: 'clear' }); sink.message({ kind: 'hud_reset' }); this.dropInflight(); }
      this.rebuild(st);
      this.lastSt = st;
    }
    const paused = this.clock.paused;
    if (!paused) {
      const ctx = this.ctx(st);
      while (this.queue.length && this.queue[0]!.t <= st) this.queue.shift()!.fn(ctx);
    } else {
      this.pausedTick++;
      if (this.pausedTick % 5 !== 0 && this.lastSt === st) return; // keep a slow heartbeat while paused
    }
    this.lastSt = st;
    this.lastTs = ts;
    const age = 0.13;
    const sw = Math.max(0, st - age);
    const snap = snapshotAt(sw, ts - age, true);
    snap.playbackRate = this.clock.playbackRate;
    sink.snapshot(snap);
  }

  // ---------- Kimi simulation ----------
  private ctx(st: number): Ctx {
    const slow = this.variant === 'slow';
    const emit = (m: UiMessage, delayMs = 0): void => {
      if (delayMs > 0) this.to(() => this.sink?.message(m), delayMs);
      else this.sink?.message(m);
    };
    const mkIntent = (type: GraphicType, ids: number[], o: { team?: 'A' | 'B'; label?: string; ttlS?: number; source?: 'rules' | 'kimi'; id?: string }, at: number): GraphicIntent => ({
      id: o.id ?? `g${++this.seq}`, type, ids, team: o.team, label: o.label, enteredAt: at, ttlS: o.ttlS ?? 4, source: o.source ?? 'rules',
    });
    const self = this;
    const c: Ctx = {
      st,
      msg: (m) => emit(m),
      clear: () => emit({ kind: 'clear' }),
      carrier: () => carrierAt(st).id,
      later: (t, fn) => { self.queue.push({ t, fn }); self.queue.sort((a, b) => a.t - b.t); },
      event: (type, team = 'A', e2g) => {
        const ev: Event = { type, t: st, team, confidence: 0.85, detail: {} };
        emit({ kind: 'event', event: ev, eventToGraphicMs: e2g ?? (slow ? 2600 : 220 + Math.round(self.rand() * 150)) });
      },
      intent: (type, ids, o = {}) => {
        const kimi = (o.source ?? 'rules') === 'kimi';
        const delay = slow && kimi ? SLOW_TTFT[self.lines % SLOW_TTFT.length]! + 400 : 0;
        const it = mkIntent(type, ids, o, st + delay / 1000);
        emit({ kind: 'intent', intent: it }, delay);
        return it.id;
      },
      predict: (kind, targetId, windowS) => {
        const delay = slow ? 2400 : 0;
        const p: Prediction = { id: `p${++self.seq}`, kind, targetId, madeAt: st, windowS, status: 'open' };
        self.preds.set(p.id, p);
        emit({ kind: 'prediction', prediction: p }, delay);
        emit({ kind: 'intent', intent: { id: p.id, type: 'prediction', ids: [carrierAt(st).id, targetId], enteredAt: st + delay / 1000, ttlS: windowS + 1.5, source: 'kimi' } }, delay);
        return p.id;
      },
      resolve: (id, status, at) => {
        const old = self.preds.get(id);
        const p: Prediction = { id, kind: 'pass_to', targetId: old?.targetId, madeAt: old?.madeAt ?? at - 2, windowS: old?.windowS ?? 5, status, resolvedAt: at };
        emit({ kind: 'prediction', prediction: p }, slow ? 2400 : 0);
      },
      say: (text, o = {}) => {
        const n = self.lines++;
        const id = `l${++self.seq}`;
        const mentions = [...text.matchAll(/\[\[(\d+)\]\]/g)].map((m) => Number(m[1]));
        const ttft = slow ? SLOW_TTFT[n % SLOW_TTFT.length]! : 170 + Math.round(self.rand() * 150);
        const tokPerS = slow ? 70 : 1100 + Math.round(self.rand() * 800);
        const cps = tokPerS * 4;
        // Floor the stream at 320 ms so short lines still type out visibly (see showcase.ts).
        const streamMs = Math.max(320, (text.length / cps) * 1000);
        const base: Omit<KimiLine, 'text' | 'stamp'> = { id, mentions, phase: o.phase ?? 'none', lane: o.lane ?? 'watch', snapshotT: st };
        const stamp = (done: boolean): KimiLine['stamp'] => ({
          provider: self.label, lane: base.lane, ttftMs: done ? ttft : 0, totalMs: done ? Math.round(ttft + streamMs) : 0,
          tokensIn: 5200, tokensOut: Math.ceil(text.length / 4), tokPerS: done ? tokPerS : 0, framesSent: base.lane === 'reflex' ? 0 : 4,
        });
        if (self.raceMode) emit({ kind: 'thinking', on: true, since: performance.now() / 1000 });
        this.to(() => {
          if (self.raceMode) emit({ kind: 'thinking', on: false, since: 0 });
          const chunk = Math.max(1, Math.ceil(text.length / Math.max(1, Math.round(streamMs / 30))));
          let i = 0;
          const step = (): void => {
            i = Math.min(text.length, i + chunk);
            const done = i >= text.length;
            self.sink?.message({ kind: 'line', line: { ...base, text: text.slice(0, i), stamp: stamp(done) } });
            if (!done) this.to(step, 30);
            else {
              const total = ttft + streamMs;
              const late = slow && total > 1500;
              if (late) {
                const lateS = total / 1000;
                self.sink?.message({ kind: 'late', lineId: id, lateS });
                const gid = `lag${++self.seq}`;
                self.sink?.message({ kind: 'lag', id: gid, ballXY: ballAt(Math.max(0, st - 0.1)), lateS });
                self.sink?.message({ kind: 'intent', intent: { id: gid, type: 'lag_ghost', ids: [], enteredAt: st + lateS, ttlS: 3, source: 'rules' } });
              }
              if (!late) self.onTime++;
              if (self.raceMode) self.sink?.message({ kind: 'race', label: self.label, onTime: self.onTime, other: 0, otherLabel: '' });
            }
          };
          step();
        }, ttft);
      },
    };
    return c;
  }

  /** Pause-and-ask: answer streams, drawings enter in order, 150 ms apart. */
  ask(question: string): void {
    const st = this.clock.currentTime % LOOP;
    const c = this.ctx(st);
    const q = question.toLowerCase();
    const car = carrierAt(st).id;
    let free = receiverAfter(st, 2).id;
    if (free === car) free = receiverAfter(st, 3).id;
    const step = (ms: number, fn: () => void): void => { this.to(fn, ms); };
    this.sink?.message({ kind: 'ask_state', question });
    const keep = 600;
    if (q.includes('shape')) {
      c.say('Harbor keep a compact block: the front three sit high and the back line holds the half-way line.', { lane: 'ask', phase: 'settled' });
      step(260, () => c.intent('hull', [], { team: 'A', ttlS: keep, source: 'kimi' }));
      step(410, () => c.intent('line', [], { team: 'B', ttlS: keep, source: 'kimi' }));
    } else if (q.includes('press')) {
      c.say('Redstone press the carrier with two men while the rest hold a deep line.', { lane: 'ask', phase: 'press' });
      step(260, () => c.intent('pressure', [car], { ttlS: keep, source: 'kimi' }));
      step(410, () => c.intent('links', [], { team: 'A', ttlS: keep, source: 'kimi' }));
    } else if (q.includes('recap')) {
      c.say('Harbor have built from the left all half; three passes in, they switch and find [[9]] in space.', { lane: 'ask', phase: 'build_up' });
    } else {
      c.say(`[[${free}]] is free: nobody within a body length, and the lane from [[${car}]] is open.`, { lane: 'ask', phase: 'build_up' });
      step(260, () => c.intent('spotlight', [free], { ttlS: keep, source: 'kimi' }));
      step(410, () => c.intent('tag', [free], { label: 'free man', ttlS: keep, source: 'kimi' }));
      step(560, () => c.intent('lanes', [car, free], { ttlS: keep, source: 'kimi' }));
    }
  }
}

// ---------- the scripted timeline (scenario seconds) ----------
const at = (t: number, fn: (c: Ctx) => void): Step => ({ t, fn });
export const TIMELINE: Step[] = [
  at(0.05, (c) => { c.msg({ kind: 'perf', hz: 7.8, device: 'Intel iGPU (mock)', level: 3, eye: false }); c.msg({ kind: 'clear' }); c.msg({ kind: 'scoreboard', hits: 0, total: 0 }); }),
  at(4.2, (c) => c.msg({ kind: 'call', ms: 640, lane: 'scout' })),
  at(4.5, (c) => c.msg({ kind: 'perf', hz: 7.8, device: 'Intel iGPU (mock)', level: 3, eye: true })),
  at(5.5, (c) => {
    c.say('[[8]] has time, and [[9]] is the free man on the left.', { lane: 'reflex', phase: 'build_up' });
    c.intent('spotlight', [9], { ttlS: 5, source: 'kimi' });
    c.intent('tag', [9], { label: 'free man', ttlS: 5, source: 'kimi' });
    const k = Math.floor(c.st / PASS);
    c.intent('lanes', [c.carrier(), SEQ[(k + 1) % SEQ.length]!, SEQ[(k + 2) % SEQ.length]!, 4], { team: 'A', ttlS: 3.5, source: 'kimi' });
  }),
  at(7.0, (c) => c.event('switch_of_play')),
  at(8.0, (c) => c.msg({ kind: 'tiles', keys: ['pressure', 'openOptions', 'compactness'] })),
  at(9.0, (c) => { c.intent('hull', [], { team: 'A', ttlS: 6, source: 'rules' }); c.intent('line', [], { team: 'B', ttlS: 6, source: 'rules' }); }),
  at(9.8, (c) => { c.say('Redstone sit deep; the gap between their lines is the way in.', { lane: 'watch', phase: 'settled' }); c.intent('pocket', [10, 9], { ttlS: 4, source: 'kimi' }); }),
  at(12.0, (c) => {
    const r = receiverAfter(c.st, 2);
    c.say(`Expect the ball to reach [[${r.id}]] next.`, { lane: 'reflex', phase: 'build_up' });
    const id = c.predict('pass_to', r.id, 5);
    c.later(r.at, (cc) => cc.resolve(id, 'hit', r.at));
  }),
  at(17.0, (c) => {
    c.event('overload');
    c.intent('overload', [6, 7, 9, 10], { team: 'A', ttlS: 4.5, source: 'rules' });
    c.say('Four against three down the left: [[7]] can step inside.', { lane: 'reflex', phase: 'build_up' });
  }),
  at(20.0, (c) => {
    c.say('Looks like [[4]] gets the next ball.', { lane: 'reflex', phase: 'transition' });
    const id = c.predict('pass_to', 4, 4);
    c.later(c.st + 4, (cc) => cc.resolve(id, 'miss', c.st + 4));
  }),
  at(28.0, (c) => c.say('Ball out of shot while the keeper sets up.', { lane: 'watch', phase: 'set_piece' })),
  at(30.0, (c) => {
    c.event('high_press', 'B');
    c.intent('pressure', [c.carrier()], { ttlS: 4, source: 'rules' });
    c.intent('links', [], { team: 'A', ttlS: 5, source: 'rules' });
    c.intent('run', [11], { ttlS: 4, source: 'rules' });
  }),
  at(31.2, (c) => c.say('[[11]] is running in behind: the back line is stretched.', { lane: 'reflex', phase: 'transition' })),
  at(34.0, (c) => {
    const car = c.carrier();
    c.intent('switch', [car, car === 11 ? 10 : 11], { ttlS: 3, source: 'kimi' });
    c.event('switch_of_play');
  }),
  at(36.0, (c) => {
    c.event('counter_attack');
    c.say('Counter on: [[9]] and [[10]] against two defenders.', { lane: 'reflex', phase: 'transition' });
    c.intent('spotlight', [9, 10], { ttlS: 3.5, source: 'kimi' });
    c.intent('tag', [10], { label: 'overlap run', ttlS: 3.5, source: 'kimi' });
  }),
  at(40.0, (c) => c.clear()),
  at(41.5, (c) => {
    c.msg({ kind: 'replay_card', steps: [{ text: '[[8]] draws the full-back wide' }, { text: '[[9]] finds the pocket behind' }, { text: 'The finish comes off the second ball' }] });
    c.say('Replay: the move starts with a short switch to the left.', { lane: 'replay', phase: 'none' });
    c.intent('spotlight', [8, 9], { ttlS: 4, source: 'kimi' });
  }),
  at(46.8, (c) => c.msg({ kind: 'replay_card', steps: null })),
  at(47.0, (c) => c.clear()),
  at(50.0, (c) => c.clear()),
  at(51.0, (c) => c.say('Close-up: the keeper is organising the wall.', { lane: 'watch', phase: 'set_piece' })),
  at(54.0, (c) => c.clear()),
  at(55.5, (c) => c.say('Commentary mode: no tracking, Kimi is reading the frames only.', { lane: 'watch', phase: 'none' })),
  at(59.0, (c) => c.clear()),
  at(62.0, (c) => c.clear()),
  at(63.0, (c) => c.say('Back to live play: Harbor settle into their left-sided shape.', { lane: 'watch', phase: 'settled' })),
  at(64.5, (c) => c.msg({ kind: 'summary', summary: { calls: 184, p50: 240, p95: 410, dropped: 0, provider: 'Kimi K3.1 Pro on Cerebras (mock)' } })),
  at(69.4, (c) => c.msg({ kind: 'summary', summary: null })),
];
