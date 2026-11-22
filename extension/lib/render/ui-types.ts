// UI-side types. Everything that the core contract does not (yet) carry lives here.
// Source of truth for engine data is still core/src/types.ts; nothing here shadows it.
import type { Event, KimiLane, OverlayMessage, OverlaySnapshot, QualityLevel, StatKey } from '@tacticlens/core';
import type { DirectorLogEntry, KimiSpeedSnapshot } from '@tacticlens/core';

/** Effective overlay state shown by the pill. */
export type ViewState =
  | 'OFF' | 'CALIBRATING' | 'LIVE' | 'REPLAY' | 'CLOSE_UP'
  | 'PAUSED' | 'ASK' | 'COMMENTARY' | 'UNSUPPORTED';

export type Tier = 'full' | 'mid' | 'narrow';

export interface ReplayStep { text: string }

/** Event-driven extras on top of core's OverlayMessage. A real source maps its own events to these. */
export type UiMessage =
  | OverlayMessage
  | { kind: 'event'; event: Event; eventToGraphicMs?: number }
  | { kind: 'call'; ms: number; lane: KimiLane | 'scout' }
  | { kind: 'tiles'; keys: StatKey[] }
  | { kind: 'perf'; hz: number; device: string; level: QualityLevel; eye: boolean; captureDropped?: number; detail?: string }
  | { kind: 'thinking'; on: boolean; since: number }
  | { kind: 'late'; lineId: string; lateS: number }
  | { kind: 'lag'; id: string; ballXY: [number, number]; lateS: number }
  | { kind: 'race'; label: string; onTime: number; other: number; otherLabel: string; fairness?: string }
  | { kind: 'scoreboard'; hits: number; total: number }
  | { kind: 'replay_card'; steps: ReplayStep[] | null }
  | { kind: 'summary'; summary: Summary | null }
  | { kind: 'ask_state'; question: string | null }
  | { kind: 'director'; log: DirectorLogEntry[] }
  | { kind: 'kimi_speed'; speed: KimiSpeedSnapshot | null }
  /** Side chat: Kimi has a call in flight (shows the typing bubble). */
  | { kind: 'typing'; on: boolean }
  /** Side chat: a muted system bubble (an error or a "nothing to add"), replaced by id. Also ends a pending ask. */
  | { kind: 'feed_note'; id: string; text: string }
  /** Seek/loop seam: drop transient HUD state without touching the picture. */
  | { kind: 'hud_reset' };

export interface Summary { calls: number; p50: number; p95: number; dropped: number; provider: string }

export interface PerceptionMeta { tMedia: number; playbackRate: number; frameIdx: number }

export interface SourceSink {
  snapshot(s: OverlaySnapshot): void;
  message(m: UiMessage): void;
}

/** Pluggable perception source: the scripted mock or the real brain. */
export interface PerceptionSource {
  start(sink: SourceSink): void;
  stop(): void;
  /** Called by capture with a native-resolution bitmap. Resolve when the brain has acked (back-pressure). */
  process?(bitmap: ImageBitmap, meta: PerceptionMeta): Promise<void>;
  /** Pause-and-ask. Optional; the mock streams a canned answer. */
  ask?(question: string): void;
}
