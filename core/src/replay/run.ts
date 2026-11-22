// Replay: Session -> FrameState[] (re-running the perception layers on raw, or taking recorded frames) -> Engine -> report.
import type { Event, FrameState, Liveness, MatchState, SceneKind } from '../types';
import { Engine, type EngineDetail } from '../engine/engine';
import type { TrackerDebugStats } from '../tracking/v2';
import { isFullFrame, type Session } from './format';
import { RawPipeline } from './pipeline';

export interface RunOpts { preferFrames?: boolean; tracker?: 'v1' | 'v2' }
export interface FrameOut { frame: FrameState; match: MatchState; events: Event[]; detail: EngineDetail }
export interface Report {
  frames: number;
  durationS: number;
  mode: 'raw' | 'frames';
  possession: { A: number; B: number; creditedS: { A: number; B: number } };
  scenes: { kind: SceneKind; t0: number; t1: number }[];
  ball: { visible: number; searching: number; absent: number };     // percent of frames
  liveness: Partial<Record<Liveness, number>>;                      // percent of frames
  events: Event[];
  gateToggles: number;
  formation: { A: string | null; B: string | null };
  engineMsPerFrame: number;
  newIds: number;
  /** Rolling new-ID rate over the last 60 s (or the whole run when shorter). */
  newIdsPerMinute: number;
  /** Total IDs per minute including the initial squad; useful as a raw allocation count. */
  newIdsTotalPerMinute: number;
  tracker: 'v1' | 'v2';
}

export function toFrameStates(s: Session, o: RunOpts = {}): { frames: FrameState[]; mode: 'raw' | 'frames'; stats?: TrackerDebugStats } {
  const useRaw = !o.preferFrames && s.frames.some((r) => r.raw);
  if (!useRaw) {
    const frames: FrameState[] = [];
    for (const r of s.frames) {
      if (!isFullFrame(r.frame)) throw new Error('record has no full FrameState and raw replay was not requested/possible');
      frames.push(r.frame);
    }
    return { frames, mode: 'frames' };
  }
  const pipe = new RawPipeline({ tracker: o.tracker ?? 'v2' });
  const frames = s.frames.map((r) => {
    if (!r.raw) throw new Error('mixed session: a frame has no raw detections');
    return pipe.step(r.frame, r.raw);
  });
  return { frames, mode: 'raw', stats: pipe.tracker.debugStats() };
}

/** First-appearance accounting for recorded FrameStates (tracking was done before the recording). */
function firstSight(frames: FrameState[]): Pick<Report, 'newIds' | 'newIdsPerMinute' | 'newIdsTotalPerMinute'> {
  const first = new Map<number, number>();
  for (const f of frames) for (const tr of f.tracks) if (!first.has(tr.id)) first.set(tr.id, f.t);
  const firstT = frames.length ? frames[0]!.t : 0;
  const lastT = frames.length ? frames[frames.length - 1]!.t : 0;
  const duration = lastT - firstT;
  const span = Math.min(60, duration);
  const recent = span > 0 ? [...first.values()].filter((t) => t >= lastT - span).length : 0;
  return {
    newIds: first.size,
    newIdsPerMinute: span > 0 ? (recent * 60) / span : 0,
    newIdsTotalPerMinute: duration > 0 ? (first.size * 60) / duration : 0,
  };
}

export function runSession(s: Session, o: RunOpts = {}, now: () => number = () => 0): { outs: FrameOut[]; report: Report } {
  const { frames, mode, stats } = toFrameStates(s, o);
  const engine = new Engine();
  const outs: FrameOut[] = [];
  const events: Event[] = [];
  let ms = 0;
  for (const frame of frames) {
    const a = now();
    const r = engine.update(frame);
    ms += now() - a;
    outs.push({ frame, ...r });
    events.push(...r.events);
  }
  const n = frames.length || 1;
  const last = outs[outs.length - 1];
  const scenes: Report['scenes'] = [];
  for (const f of frames) {
    const cur = scenes[scenes.length - 1];
    if (cur && cur.kind === f.scene.kind) cur.t1 = f.t; else scenes.push({ kind: f.scene.kind, t0: f.t, t1: f.t });
  }
  const share = (p: (f: FrameState) => boolean) => (100 * frames.filter(p).length) / n;
  const liveness: Report['liveness'] = {};
  for (const o2 of outs) liveness[o2.match.liveness] = (liveness[o2.match.liveness] ?? 0) + 100 / n;
  const cr = last?.detail.credited ?? { A: 0, B: 0 };
  const poss = last?.match.possession.value ?? { A: 50, B: 50 };
  const ids = stats && stats.frames > 0
    ? { newIds: stats.newIds, newIdsPerMinute: stats.newIdsPerMinute, newIdsTotalPerMinute: stats.newIdsTotalPerMinute }
    : firstSight(frames);
  const report: Report = {
    frames: frames.length,
    durationS: frames.length ? frames[frames.length - 1]!.t - frames[0]!.t : 0,
    mode,
    possession: { A: poss.A, B: poss.B, creditedS: cr },
    scenes,
    ball: { visible: share((f) => f.ball.state === 'visible'), searching: share((f) => f.ball.state === 'searching'), absent: share((f) => f.ball.state === 'absent') },
    liveness,
    events,
    gateToggles: last?.detail.gateToggles ?? 0,
    formation: last?.detail.formation ?? { A: null, B: null },
    engineMsPerFrame: ms / n,
    ...ids,
    tracker: o.tracker ?? 'v2',
  };
  return { outs, report };
}
