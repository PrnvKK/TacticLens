// Port protocol between pages (Theatre, brain, content) and the background LLM host.
// The API key lives only in the background; nothing here carries it.
import type { LLMEvent, LaneOutcome, LLMRequest, MockProfile, PresetId, RaceResult } from '@tacticlens/core';

export const LLM_PORT = 'tl:llm';

export type ToBg =
  | { type: 'call'; id: string; preset: PresetId; request: LLMRequest; key?: string; policy?: 'replace' | 'drop' | 'parallel'; mockProfile?: MockProfile }
  | { type: 'race'; id: string; a: PresetId; b: PresetId; request: LLMRequest; mockA?: MockProfile; mockB?: MockProfile }
  | { type: 'cancel'; id: string }
  | { type: 'warmup'; id: string; preset: PresetId }
  | { type: 'stats'; id: string }
  | { type: 'keys'; id: string };

export type FromBg =
  /**
   * `tRecv` is the worker's performance.now() at the instant the SSE event was decoded from the network;
   * `tOrigin` is that worker's performance.timeOrigin. Together they let the page put receipt times on
   * its own monotonic clock, so port/message delay never skews TPS or TTFT.
   */
  | { id: string; kind: 'event'; side?: 'a' | 'b'; event: LLMEvent; tRecv: number; tOrigin: number }
  | { id: string; kind: 'outcome'; outcome: LaneOutcome }
  | { id: string; kind: 'race'; result: RaceResult }
  | { id: string; kind: 'warmup'; ms: number | null }
  | { id: string; kind: 'stats'; stats: unknown; pulse: unknown }
  | { id: string; kind: 'keys'; keys: Partial<Record<PresetId, boolean>> }
  | { id: string; kind: 'error'; error: string };

export interface LLMSettings {
  preset: PresetId;            // lane provider
  racePreset: PresetId | null; // second provider for the race
  mockProfile: 'cerebras' | 'gpu';
  /** CEREBRAS_KIMI_MODEL: the Kimi model id, or '' for the cerebras-dev fallback. */
  kimiModel: string;
}
export const DEFAULT_SETTINGS: LLMSettings = { preset: 'mock', racePreset: null, mockProfile: 'cerebras', kimiModel: '' };
