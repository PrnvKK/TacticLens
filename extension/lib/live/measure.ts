// Live measurement bridge: FrameState -> core Engine -> MatchState / Event[] -> overlay snapshot, toasts and rules graphics.
// The engine owns every number and every gate (shown / held / hidden) and the paused flag while the ball is absent; this file only maps.
import { Engine, type EngineDetail, type Event, type FrameState, type GraphicIntent, type MatchState } from '@tacticlens/core';
import type { UiMessage } from '../render/ui-types';

export interface Measured { match: MatchState; events: Event[]; detail: EngineDetail }

const REFRESH_S = 1;          // re-assert long-lived rules graphics (cheap: same id updates in place)
const LINKS_REFRESH_S = 0.5;  // marking pairs change faster
const FOREVER = 3600;
const MAX_PAIRS = 8;

/** Wraps the engine, resets it on a backward seek or loop, and derives the rules graphics (hull, line, links, pressure ring) from its output. */
export class MeasureBridge {
  private engine = new Engine();
  private prevT = -Infinity;
  private active = new Map<string, number>();   // intent id -> last emit time (video seconds)
  last: Measured | null = null;
  /** Events of the last ~30 s of video, newest last (feeds the LLM payload). */
  readonly recent: Event[] = [];
  /** When a Kimi director is active, rules no longer fire toasts or graphics on their own. */
  rulesEnabled = true;

  reset(): void { this.engine = new Engine(); this.active.clear(); this.recent.length = 0; this.last = null; this.prevT = -Infinity; }

  /** Forget active graphics (scene cut cleared the renderer): they are re-asserted on the next frames. */
  cleared(): void { this.active.clear(); }

  step(f: FrameState, emit: (m: UiMessage) => void): Measured {
    if (f.t < this.prevT - 0.5) this.reset();
    this.prevT = f.t;
    const out = this.engine.update(f);
    this.last = out;
    for (const e of out.events) {
      this.recent.push(e);
      if (!this.rulesEnabled) continue;
      emit({ kind: 'event', event: e });
      if (e.type === 'high_press' && typeof e.detail.carrierId === 'number' && e.detail.carrierId >= 0) {
        emit({ kind: 'intent', intent: this.intent(`r-press-${e.t.toFixed(1)}`, 'pressure', [e.detail.carrierId], f, undefined, 3) });
      }
    }
    while (this.recent.length && f.t - this.recent[0]!.t > 30) this.recent.shift();
    if (!this.rulesEnabled) {
      for (const id of [...this.active.keys()]) emit({ kind: 'clear', id });
      this.active.clear();
    } else this.graphics(f, out, emit);
    return out;
  }

  private intent(id: string, type: GraphicIntent['type'], ids: number[], f: FrameState, team: 'A' | 'B' | undefined, ttlS: number): GraphicIntent {
    return { id, type, ids, team, enteredAt: f.tMedia, ttlS, source: 'rules' };
  }

  private graphics(f: FrameState, out: Measured, emit: (m: UiMessage) => void): void {
    const { match, detail } = out;
    const want = new Map<string, GraphicIntent>();
    if (match.liveness === 'LIVE') {
      const holder = detail.possessionState === 'A' || detail.possessionState === 'B' ? detail.possessionState : null;
      const att: 'A' | 'B' = holder ?? (match.possession.value.current === 'B' ? 'B' : 'A');
      const def: 'A' | 'B' = att === 'A' ? 'B' : 'A';
      if (match.shape[att].gate === 'shown') want.set(`r-hull-${att}`, this.intent(`r-hull-${att}`, 'hull', [], f, att, FOREVER));
      if (match.shape[def].gate === 'shown') want.set(`r-line-${def}`, this.intent(`r-line-${def}`, 'line', [], f, def, FOREVER));
      // marking pairs follow the ball: no links while the ball is absent (the stat is paused)
      if (holder && f.ball.state !== 'absent' && detail.marking.length >= 2 && match.shape[att].gate !== 'hidden') {
        const ids = detail.marking.slice(0, MAX_PAIRS).flatMap((p) => [p.attacker, p.defender]);
        want.set(`r-links-${att}`, this.intent(`r-links-${att}`, 'links', ids, f, att, FOREVER));
      }
    }
    for (const id of [...this.active.keys()]) {
      if (!want.has(id)) { this.active.delete(id); emit({ kind: 'clear', id }); }
    }
    for (const [id, it] of want) {
      const prev = this.active.get(id);
      const every = it.type === 'links' ? LINKS_REFRESH_S : REFRESH_S;
      if (prev !== undefined && f.t - prev < every && f.t >= prev) continue;
      this.active.set(id, f.t);
      emit({ kind: 'intent', intent: it });
    }
  }
}
