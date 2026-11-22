// Reactive wrapper over SpeedTracker for the HUD, plus a two-lane race store. Time is always
// performance.now() unless a clock is injected (tests, deterministic recordings).
import { SpeedTracker, CallMeter, officialTps, feedLLMEvent, type SpeedSnapshot, type TimingEvent, type TrackerOptions } from './tps';

export type Clock = () => number;
const defaultClock: Clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class SpeedStore {
  readonly tracker: SpeedTracker;
  private subs = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(readonly now: Clock = defaultClock, opts?: TrackerOptions) { this.tracker = new SpeedTracker(opts); }
  subscribe(fn: () => void): () => void { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  private emit(): void { for (const f of this.subs) f(); }
  snapshot(): SpeedSnapshot { return this.tracker.snapshot(this.now()); }
  /**
   * Subscribe point for the live pipeline: one call per stream event.
   * `atMs` is when the event ARRIVED from the network, on this store's clock. Pass it from the
   * port handler so IPC/message delay never inflates the decode time.
   */
  feed(callId: string, e: TimingEvent | { type: string }, meta: { lane?: string; provider?: string } = {}, atMs?: number): void {
    feedLLMEvent(this.tracker, callId, e, atMs ?? this.now(), meta);
    this.emit();
  }
  /** Start the 100 ms sampler (sparkline + aggregate peak). Returns a stop function. */
  start(): () => void {
    if (!this.timer) this.timer = setInterval(() => { this.tracker.sample(this.now()); this.emit(); }, 100);
    return () => { if (this.timer) { clearInterval(this.timer); this.timer = null; } };
  }
  reset(): void { this.tracker.reset(); this.emit(); }
}

export type RaceSide = 'a' | 'b';
export interface RaceLaneView {
  label: string; sub: string;
  text: string; tokens: number; tps: number; ttftMs: number | null;
  elapsedMs: number; done: boolean; started: boolean; error: string | null;
}
export interface RaceView { a: RaceLaneView; b: RaceLaneView; speedup: number; final: boolean; }

interface Lane { label: string; sub: string; meter: CallMeter | null; text: string; error: string | null }

/** Same request to two providers: live text, stopwatch and TPS per lane, plus the x-faster ratio. */
export class RaceStore {
  private lanes: Record<RaceSide, Lane>;
  private t0 = 0;
  private subs = new Set<() => void>();
  constructor(readonly now: Clock = defaultClock, labels: { a: [string, string]; b: [string, string] } = { a: ['CEREBRAS', 'Kimi K3.1 Pro'], b: ['GPU PROVIDER', 'Kimi K3.1 Pro'] }) {
    this.lanes = {
      a: { label: labels.a[0], sub: labels.a[1], meter: null, text: '', error: null },
      b: { label: labels.b[0], sub: labels.b[1], meter: null, text: '', error: null },
    };
  }
  subscribe(fn: () => void): () => void { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  private emit(): void { for (const f of this.subs) f(); }
  /** Labels come from the provider presets; the harness calls this when settings are known. */
  setLabels(a: [string, string], b: [string, string]): void {
    this.lanes.a.label = a[0]; this.lanes.a.sub = a[1];
    this.lanes.b.label = b[0]; this.lanes.b.sub = b[1];
    this.emit();
  }
  reset(): void {
    this.t0 = 0;
    for (const s of ['a', 'b'] as const) { this.lanes[s].meter = null; this.lanes[s].text = ''; this.lanes[s].error = null; }
    this.emit();
  }
  /** Both lanes start at the same instant: the stopwatch is shared. */
  begin(t = this.now()): void {
    this.t0 = t;
    for (const s of ['a', 'b'] as const) { this.lanes[s].meter = new CallMeter(`race-${s}`, t); this.lanes[s].text = ''; this.lanes[s].error = null; }
    this.emit();
  }
  delta(side: RaceSide, text: string, tokens = 1, t = this.now()): void {
    const l = this.lanes[side];
    if (!l.meter) return;
    l.meter.delta(t, tokens);
    l.text += text;
    this.emit();
  }
  usage(side: RaceSide, completionTokens: number): void { this.lanes[side].meter?.setUsage(completionTokens); this.emit(); }
  end(side: RaceSide, t = this.now()): void { this.lanes[side].meter?.finish(t); this.emit(); }
  /** A lane that failed (HTTP error, no key, abort): stop the clock and surface the reason. */
  fail(side: RaceSide, error: string, t = this.now()): void {
    // A failure before any start still gets a sane shared stopwatch instead of a huge elapsed time.
    if (!this.t0) this.begin(t);
    const l = this.lanes[side];
    l.meter ??= new CallMeter(`race-${side}`, t);
    l.meter.finish(t);
    l.error = error;
    this.emit();
  }
  view(now = this.now()): RaceView {
    const mk = (s: RaceSide): RaceLaneView => {
      const l = this.lanes[s];
      const m = l.meter;
      return {
        label: l.label, sub: l.sub, text: l.text,
        tokens: m?.tokens ?? 0, tps: m ? officialTps(m.tokens, m.tFirst, m.tLast) : 0,
        ttftMs: m && m.tFirst != null ? m.tFirst - m.tStart : null,
        elapsedMs: m ? (m.tDone ?? now) - this.t0 : 0, done: !!m?.done, started: !!m, error: l.error,
      };
    };
    const a = mk('a');
    const b = mk('b');
    const final = a.done && b.done;
    // Final: wall-clock ratio of the full answers. Live: ratio of decode speeds.
    const ratio = final && !a.error && !b.error ? (a.elapsedMs > 0 ? b.elapsedMs / a.elapsedMs : 0) : !final && b.tps > 0 ? a.tps / b.tps : 0;
    const speedup = ratio;
    return { a, b, speedup, final };
  }
}
