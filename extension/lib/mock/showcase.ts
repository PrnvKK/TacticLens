// ?showcase=1: a 30-second scripted broadcast on the mock world. Every graphic and transition
// appears in recording order: lock-on, score read, lower third, lanes, prediction + CALLED IT,
// freeze-frame telestrator, replay wipe, ball-out pause, marking/formation, overload and end card.
// Wall clock drives the script so the freeze-frame can pause media time without stalling the show.
import type { EventType, GraphicType, KimiLane, KimiLine, Prediction } from '@tacticlens/core';
import type { PerceptionSource, SourceSink, UiMessage } from '../render/ui-types';
import type { MediaClock } from '../video';
import { LOOP, MOCK_SCOUT, PASS, SEQ, carrierAt, receiverAfter, snapshotAt } from './world';

export const SHOWCASE_S = 30;

interface Step { t: number; fn: () => void }

export class ShowcaseSource implements PerceptionSource {
  private sink: SourceSink | null = null;
  readonly clock: MediaClock;
  private offset: number;
  private startWall = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private steps: Step[] = [];
  private fired = new Set<number>();
  seq = 0;
  private loop = 0;
  private pausedForStill = false;

  constructor(o: { clock: MediaClock; startAt?: number }) {
    this.clock = o.clock;
    this.offset = Math.max(0, Math.min(SHOWCASE_S - 0.1, o.startAt ?? 0));
    this.steps = buildSteps(this);
  }

  start(sink: SourceSink): void {
    this.stop();
    this.sink = sink;
    this.startWall = performance.now() - this.offset * 1000;
    this.clock.currentTime = this.offset;
    // Dev/recording jump: never replay every past step at once.
    this.fired.clear();
    for (let i = 0; i < this.steps.length; i++) if (this.steps[i]!.t < this.offset) this.fired.add(i);
    this.pausedForStill = this.offset >= 16 && this.offset < 18;
    if (this.pausedForStill) this.clock.pause(); else this.clock.play();
    this.sendSetup();
    this.interval = setInterval(() => this.tick(), 42);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.sink = null;
  }

  /** The showcase keeps its scripted telestrator, but a typed question still gets a streamed answer in the chat. */
  ask(question?: string): void {
    const q = (question ?? '').toLowerCase();
    const text = q.includes('shape') ? 'Harbor keep a compact block: the front three sit high and the back line holds the half-way line.'
      : q.includes('press') ? 'Redstone press the carrier with two men while the rest hold a deep line.'
      : q.includes('recap') ? 'Harbor have built from the left all half; three passes in, they switch and find [[9]] in space.'
      : '[[9]] is free: nobody within a body length, and the lane from [[8]] is open.';
    this.stream(text, { lane: 'ask', phase: 'build_up' });
  }

  /** Used by the synthetic pitch so the picture and the overlay agree on ball-out / replay. */
  get phase(): 'live' | 'replay' | 'ballout' {
    const elapsed = (performance.now() - this.startWall) / 1000;
    if (elapsed >= 18 && elapsed < 21) return 'replay';
    if (elapsed >= 21.3 && elapsed < 23.6) return 'ballout';
    return 'live';
  }

  private later(ms: number, fn: () => void): void {
    const id = setTimeout(() => { this.timers.delete(id); fn(); }, ms);
    this.timers.add(id);
  }

  msg(m: UiMessage): void { this.sink?.message(m); }

  private sendSetup(): void {
    this.msg({ kind: 'perf', hz: 8.2, device: 'Intel iGPU - WebGPU', level: 3, eye: true });
    this.msg({ kind: 'clear' });
    this.msg({ kind: 'hud_reset' });
    this.msg({ kind: 'scoreboard', hits: 0, total: 0 });
    this.msg({ kind: 'tiles', keys: ['pressure', 'openOptions', 'compactness'] });
    this.msg({ kind: 'replay_card', steps: null });
    this.msg({ kind: 'summary', summary: null });
    this.msg({ kind: 'ask_state', question: null });
    for (let i = 0; i < 6; i++) this.msg({ kind: 'call', ms: 170 + ((i * 53) % 130), lane: 'watch' });
  }

  private tick(): void {
    const elapsed = (performance.now() - this.startWall) / 1000;
    if (elapsed >= SHOWCASE_S) {
      this.resetLoop();
      return;
    }
    if (this.pausedForStill && elapsed >= 18) {
      this.pausedForStill = false;
      this.clock.play();
    }
    for (let i = 0; i < this.steps.length; i++) {
      if (this.fired.has(i)) continue;
      if (this.steps[i]!.t > elapsed) continue;
      this.fired.add(i);
      this.steps[i]!.fn();
    }
    // the media clock is the source of truth for the world
    const t = this.clock.currentTime;
    const st = Math.max(0, Math.min(LOOP - 0.05, t));
    const paused = this.clock.paused;
    const sw = paused ? st : Math.max(0, st - 0.13);
    const mediaT = paused ? st : st - 0.13;
    const wall = elapsed;
    let opts: Parameters<typeof snapshotAt>[3] | undefined;
    if (wall >= 18 && wall < 21) {
      opts = { forcePhase: { liveness: 'REPLAY', calibrated: true, ball: 'visible', coasting: 0, scene: 'REPLAY', replay: true } };
    } else if (wall >= 21.3 && wall < 23.6) {
      opts = { forcePhase: { liveness: 'LIVE', calibrated: true, ball: 'absent', coasting: 2, scene: 'WIDE' } };
    }
    const snap = snapshotAt(sw, mediaT, true, opts);
    snap.playbackRate = this.clock.playbackRate;
    this.sink?.snapshot(snap);
  }

  private resetLoop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.fired.clear();
    this.loop++;
    this.startWall = performance.now();
    this.clock.currentTime = 0;
    this.clock.play();
    this.sendSetup();
  }

  // ----- script helpers -----
  intent(type: GraphicType, ids: number[], o: IntentOpts = {}): string {
    const id = o.id ?? `sc${++this.seq}`;
    this.msg({ kind: 'intent', intent: {
      id, type, ids, team: o.team, label: o.label, enteredAt: this.clock.currentTime,
      ttlS: o.ttlS ?? 4.2, source: o.source ?? 'rules',
    } });
    return id;
  }

  event(type: EventType, team: 'A' | 'B' = 'A', e2g = 240): void {
    this.msg({ kind: 'event', event: { type, t: this.clock.currentTime, team, confidence: 0.9, detail: {} }, eventToGraphicMs: e2g });
  }

  stream(text: string, o: { lane?: KimiLane; phase?: KimiLine['phase']; ttft?: number; tokPerS?: number } = {}): void {
    const lane = o.lane ?? 'watch';
    const id = `sl${++this.seq}`;
    const ttft = o.ttft ?? 180 + ((this.seq * 41) % 140);
    const tokPerS = o.tokPerS ?? 1200 + ((this.seq * 137) % 900);
    const cps = tokPerS * 4;
    // Pace the delivery over at least 320 ms: a fast pipe would otherwise land a whole
    // lower-third in one 34 ms chunk, and the word-by-word stream plus the live badge
    // would never be seen. totalMs/tokPerS still report the true figures.
    const streamMs = Math.max(320, (text.length / cps) * 1000);
    const mentions = [...text.matchAll(/\[\[(\d+)\]\]/g)].map((m) => Number(m[1]));
    const base: Omit<KimiLine, 'text' | 'stamp'> = { id, mentions, phase: o.phase ?? 'none', lane, snapshotT: this.clock.currentTime };
    const stamp = (done: boolean): KimiLine['stamp'] => ({
      provider: 'Kimi K3.1 Pro on Cerebras', lane, ttftMs: done ? ttft : 0, totalMs: done ? Math.round(ttft + streamMs) : 0,
      tokensIn: 5200, tokensOut: Math.max(1, Math.ceil(text.length / 4)), tokPerS: done ? tokPerS : 0, framesSent: lane === 'reflex' ? 0 : 4,
    });
    this.later(ttft, () => {
      const chunk = Math.max(2, Math.ceil(text.length / Math.max(1, Math.round(streamMs / 34))));
      let i = 0;
      const step = (): void => {
        i = Math.min(text.length, i + chunk);
        const done = i >= text.length;
        this.sink?.message({ kind: 'line', line: { ...base, text: text.slice(0, i), stamp: stamp(done) } });
        if (!done) this.later(34, step);
      };
      step();
    });
  }

  predict(target: number, windowS = 5): string {
    const id = `sp${++this.seq}`;
    const p: Prediction = { id, kind: 'pass_to', targetId: target, madeAt: this.clock.currentTime, windowS, status: 'open' };
    this.msg({ kind: 'prediction', prediction: p });
    this.intent('prediction', [carrierAt(this.clock.currentTime).id, target], { source: 'kimi', ttlS: windowS + 1.2, id });
    return id;
  }

  resolve(id: string, status: 'hit' | 'miss', before: number): void {
    const at = this.clock.currentTime;
    this.msg({ kind: 'prediction', prediction: { id, kind: 'pass_to', madeAt: at - before, windowS: 5, status, resolvedAt: at } });
  }
}

interface IntentOpts { team?: 'A' | 'B'; label?: string; ttlS?: number; source?: 'rules' | 'kimi'; id?: string }

function buildSteps(s: ShowcaseSource): Step[] {
  const steps: Step[] = [];
  let predId = '';
  const at = (t: number, fn: () => void): void => { steps.push({ t, fn }); };
  const line = (t: number, text: string, lane: KimiLane = 'watch', phase: KimiLine['phase'] = 'none', ttft?: number): void => {
    at(t, () => s.stream(text, { lane, phase, ttft }));
  };
  const intent = (t: number, type: GraphicType, ids: number[], o: IntentOpts = {}): void => {
    at(t, () => s.intent(type, ids, o));
  };

  // 0-3 lock-on
  at(0.25, () => s.msg({ kind: 'perf', hz: 8.2, device: 'Intel iGPU - WebGPU', level: 3, eye: false }));
  line(2.35, 'Locking on. Two teams, one shape.', 'watch', 'none', 260);
  at(3.05, () => s.msg({ kind: 'perf', hz: 8.2, device: 'Intel iGPU - WebGPU', level: 3, eye: true }));
  at(3.2, () => s.msg({ kind: 'call', ms: 620, lane: 'scout' }));
  line(4.35, 'Harbor in blue. Redstone in red.', 'watch', 'settled', 196);

  // 4-9 score read, lower third, lanes, spotlight
  at(4.3, () => s.msg({ kind: 'tiles', keys: ['pressure', 'openOptions', 'compactness'] }));
  intent(5.0, 'spotlight', [9], { source: 'kimi', ttlS: 4.4 });
  intent(5.1, 'tag', [9], { source: 'kimi', label: 'free man', ttlS: 4.3 });
  intent(5.3, 'lanes', [carrierAt(5.3).id, SEQ[(Math.floor(5.3 / PASS) + 1) % SEQ.length]!, SEQ[(Math.floor(5.3 / PASS) + 2) % SEQ.length]!, 4], { team: 'A', source: 'kimi', ttlS: 3.4 });
  line(6.4, '[[8]] has time. [[9]] is the free man.', 'reflex', 'build_up');

  // 9-13 shape, pocket, prediction
  at(8.8, () => s.event('switch_of_play', 'A', 310));
  intent(9.3, 'hull', [], { team: 'A', ttlS: 4.8 });
  intent(9.5, 'line', [], { team: 'B', ttlS: 4.8 });
  line(9.9, 'Redstone sit deep. The gap is there.', 'watch', 'settled');
  intent(10.4, 'pocket', [10, 9], { source: 'kimi', ttlS: 3.4 });
  at(11.2, () => s.msg({ kind: 'scoreboard', hits: 0, total: 0 }));
  at(11.4, () => { predId = s.predict(receiverAfter(s.clock.currentTime, 2).id, 5); });
  line(12.0, 'Expect the ball to reach [[9]].', 'reflex', 'build_up');
  at(14.0, () => s.resolve(predId, 'hit', 2.6));
  at(14.05, () => s.msg({ kind: 'scoreboard', hits: 1, total: 1 }));
  at(14.1, () => s.event('pass', 'A', 180));

  // 14-16 overload, pressure, links, run
  at(15.0, () => s.event('overload', 'A', 260));
  intent(15.1, 'overload', [6, 7, 9, 10], { team: 'A', ttlS: 3.5 });
  intent(15.2, 'pressure', [carrierAt(s.clock.currentTime).id], { ttlS: 3.4 });
  intent(15.3, 'links', [], { team: 'A', ttlS: 3.6 });
  intent(15.4, 'run', [11], { ttlS: 3.2 });

  // 16-18 freeze-frame telestrator
  at(16.0, () => { s.clock.pause(); });
  at(16.1, () => s.msg({ kind: 'ask_state', question: "Who's free?" }));
  intent(16.25, 'spotlight', [9], { source: 'kimi', ttlS: 2.4 });
  intent(16.35, 'tag', [9], { source: 'kimi', label: 'free man', ttlS: 2.3 });
  intent(16.5, 'lanes', [carrierAt(s.clock.currentTime).id, 9], { source: 'kimi', ttlS: 2.2 });
  line(16.6, '[[9]] is free. The lane from [[8]] is open.', 'ask', 'build_up', 148);
  at(17.85, () => { s.clock.play(); s.msg({ kind: 'ask_state', question: null }); });

  // 18-21 replay wipe + breakdown
  at(18.0, () => {
    s.msg({ kind: 'replay_card', steps: [{ text: '[[8]] draws the full-back wide' }, { text: '[[9]] finds the pocket behind' }, { text: 'The finish comes off the second ball' }] });
  });
  line(18.7, 'Replay: the switch creates the overlap.', 'replay', 'none');
  intent(19.2, 'spotlight', [8, 9], { source: 'kimi', ttlS: 2.8 });
  at(20.9, () => s.msg({ kind: 'replay_card', steps: null }));

  // 21-24 ball out, paused possession
  line(21.6, 'Ball out. The keeper resets the wall.', 'watch', 'set_piece');
  at(23.0, () => s.msg({ kind: 'tiles', keys: ['numbersNearBall', 'tempo', 'lineHeight'] }));
  line(24.0, 'Back live. The far side is open.', 'watch', 'transition');

  // 24-27 marking, switch arc, lag ghost, overload
  intent(24.3, 'links', [], { team: 'B', ttlS: 3.4 });
  intent(24.5, 'switch', [carrierAt(s.clock.currentTime).id, 10], { source: 'kimi', ttlS: 3.2 });
  intent(25.2, 'line', [], { team: 'A', ttlS: 3.0 });
  at(25.5, () => {
    s.msg({ kind: 'lag', id: 'show-lag', ballXY: [0.42, 0.55], lateS: 2.4 });
    s.intent('lag_ghost', [], { ttlS: 2.6, id: 'show-lag' });
  });
  line(25.7, 'Two against three on the switch.', 'reflex', 'transition');

  // 27-30 end card
  at(27.2, () => s.event('counter_attack', 'A', 210));
  at(27.6, () => s.msg({ kind: 'scoreboard', hits: 3, total: 4 }));
  at(27.9, () => s.msg({ kind: 'summary', summary: { calls: 184, p50: 240, p95: 410, dropped: 0, provider: 'Kimi K3.1 Pro on Cerebras (mock)' } }));
  at(29.8, () => s.msg({ kind: 'summary', summary: null }));

  // pulse ticks across the whole show
  for (let t = 3.2; t < 28; t += 1.55) {
    at(t, () => s.msg({ kind: 'call', ms: 170 + ((t * 97) % 210), lane: 'watch' }));
  }
  return steps.sort((a, b) => a.t - b.t);
}

export { MOCK_SCOUT };
