// Real perception source: capture bitmaps -> brain iframe -> FrameState -> OverlaySnapshot for the render engine.
// Every FrameState also runs through the core engine (MeasureBridge): its MatchState (gated stats, paused while the ball is absent,
// frozen on replay) fills the snapshot's match block; its events become toasts and rules graphics.
import type { FrameState, Liveness, MatchState, OverlaySnapshot, SceneKind, Stat, StatKey, StatValue } from '@tacticlens/core';
import { MeasureBridge } from './measure';
import type { BrainHandle, BrainStats } from '../brain-bridge';
import type { PerceptionMeta, PerceptionSource, SourceSink } from '../render/ui-types';
import type { MediaClock } from '../video';

const STAT_KEYS: StatKey[] = [
  'possession', 'spell', 'passes', 'tempo', 'turnovers', 'pressure', 'timeToPressure', 'numbersNearBall', 'openOptions', 'freePlayers',
  'teamExtent', 'compactness', 'blockGap', 'lineHeight', 'fieldTilt', 'switches', 'sprints', 'ballSpeed', 'momentum',
  'kimiCalls', 'kimiSpeed', 'detectorHealth',
];

const hidden = <T>(value: T): Stat<T> => ({ value, confidence: 0, updatedAt: 0, gate: 'hidden' });

export function emptyMatch(liveness: Liveness): MatchState {
  const stats = {} as Record<StatKey, Stat<StatValue>>;
  for (const k of STAT_KEYS) stats[k] = hidden(0);
  return {
    liveness,
    possession: hidden({ A: 50, B: 50, current: 'NONE' as const }),
    shape: { A: hidden({ lines: [] }), B: hidden({ lines: [] }) },
    lineHeight: { A: hidden(0.5), B: hidden(0.5) },
    passOptions: hidden({ carrierId: -1, targets: [] }),
    momentum: hidden(0),
    stats,
    attackDir: { A: 'unknown', confidence: 0 },
    scout: null,
    teamNames: { A: 'Team A', B: 'Team B' },
  };
}

export function livenessOf(f: FrameState): Liveness {
  if (f.scene.kind === 'REPLAY') return 'REPLAY';
  if (f.scene.kind === 'CLOSE' || f.scene.kind === 'CROWD' || f.scene.kind === 'GRAPHIC') return 'CLOSE_UP';
  return f.teamsCalibrated ? 'LIVE' : 'CALIBRATING';
}

export function toSnapshot(f: FrameState, match: MatchState = emptyMatch(livenessOf(f))): OverlaySnapshot {
  const liveness = livenessOf(f);
  return {
    tMedia: f.tMedia, playbackRate: f.playbackRate, globalMotion: f.globalMotion, liveness, scene: f.scene.kind as SceneKind,
    tracks: f.tracks, ball: f.ball, match, teamsCalibrated: f.teamsCalibrated,
    cut: f.cut, teamColours: f.teamColours,
  };
}

const HISTORY = 80;
const ACK_TIMEOUT_MS = 10_000;

export class LiveSource implements PerceptionSource {
  /** Recent FrameStates, oldest first (feeds the LLM payload packer). */
  readonly history: FrameState[] = [];
  /** Engine side: latest MatchState and recent events (feeds the LLM payload). */
  readonly measure = new MeasureBridge();
  /** Optional tap on every FrameState (session recorder). */
  onFrame: ((f: FrameState) => void) | null = null;
  /** Called when the brain reports the active source profile (broadcast or game). */
  onProfile: ((p: 'broadcast' | 'game') => void) | null = null;
  captureDropped = 0;
  stats: BrainStats | null = null;
  private sink: SourceSink | null = null;
  private ready = false;
  private pending: (() => void) | null = null;
  private lastScene: SceneKind | null = null;
  private lastPerf = 0;
  private adapter = '';
  private lastProfile: 'broadcast' | 'game' | null = null;
  /** Wall-clock age of the picture the last FrameState describes (video-time gap / playbackRate). */
  private ageMs = 0;
  private scene = '';

  constructor(private brain: BrainHandle, private clock: MediaClock) {}

  start(sink: SourceSink): void {
    this.sink = sink;
    this.brain.onState((state, stats) => {
      this.stats = stats;
      if (stats.profile && stats.profile !== this.lastProfile) {
        this.lastProfile = stats.profile;
        this.onProfile?.(stats.profile);
      }
      this.ageMs = Math.max(0, (this.clock.currentTime - state.tMedia) / Math.max(0.1, state.playbackRate)) * 1000;
      this.scene = state.scene.kind;
      this.history.push(state);
      if (this.history.length > HISTORY) this.history.shift();
      if (this.lastScene !== null && state.scene.kind !== this.lastScene) { sink.message({ kind: 'clear' }); this.measure.cleared(); }
      this.lastScene = state.scene.kind;
      this.onFrame?.(state);
      const m = this.measure.step(state, (msg) => sink.message(msg));
      sink.snapshot(toSnapshot(state, m.match));
      this.perf();
      this.release();
    });
    this.brain.onError(() => this.release());
    void this.brain.ready.then((r) => { this.ready = true; this.adapter = r.adapter; }, () => undefined);
  }

  stop(): void { this.sink = null; this.release(); }

  get isReady(): boolean { return this.ready; }

  private release(): void { const p = this.pending; this.pending = null; p?.(); }

  private perf(): void {
    const now = performance.now();
    if (!this.sink || !this.stats || now - this.lastPerf < 500) return;
    this.lastPerf = now;
    const st = this.stats;
    const t = (k: string): string => `${Math.round(st.stages[k]?.p50 ?? 0)}`;
    const detail = `prep ${t('prep')} / players ${t('players')} / ball ${t('ball')} / grey ${t('grey')} / track ${t('track')} / teams ${t('teams')} / total ${t('total')} ms (p50, p95 ${Math.round(st.stages.total?.p95 ?? 0)}) / lag ${Math.round(this.ageMs)} ms / ${this.scene} / source ${this.lastProfile ?? 'broadcast'} / new ids ${(st.newIdsPerMinute ?? 0).toFixed(1)}/min`;
    const hz = Number.isFinite(st.hz) ? st.hz : 0;
    this.sink.message({ kind: 'perf', hz, device: this.adapter || 'WebGPU', level: st.quality as 0 | 1 | 2 | 3, eye: true, captureDropped: this.captureDropped, detail });
  }

  /** Capturer hook: resolves when the brain has acked this bitmap (or immediately if it was refused). */
  process(bitmap: ImageBitmap, meta: PerceptionMeta): Promise<void> {
    if (!this.ready || this.pending) { bitmap.close(); return Promise.resolve(); }
    if (!this.brain.sendFrame(bitmap, meta.tMedia, this.clock.currentTime, meta.playbackRate)) { bitmap.close(); return Promise.resolve(); }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.release(), ACK_TIMEOUT_MS);
      this.pending = () => { clearTimeout(timer); resolve(); };
    });
  }
}
