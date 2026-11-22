// Session JSONL format (version 1). One JSON object per line.
//   line 1      : SessionHeader
//   lines 2..n  : FrameRecord (one per perception cycle)
// A frame record always carries the cycle clocks. It carries either the finished `frame` (FrameState as the brain
// produced it: replay starts at the engine) or `raw` detections (replay re-runs tracking, teams, scene, ball, then
// the engine), or both (the CLI prefers raw unless told otherwise). See tools/replay/README.md.
import type { FrameState, SceneKind } from '../types';
import type { PersonDet } from '../tracking/bytetrack';
import type { BallCandidate } from '../tracking/ball';
import type { Lab } from '../teams/lab';

export const SESSION_VERSION = 1;

export interface SessionHeader {
  kind: 'header';
  version: typeof SESSION_VERSION;
  source: string;                 // 'extension' | 'synthetic' | 'ea-fc' | ...
  createdAt?: string;             // ISO 8601
  hz?: number;                    // nominal perception rate
  hasRaw: boolean;
  video?: { name?: string; w?: number; h?: number; durationS?: number };
  meta?: Record<string, unknown>; // free-form: model versions, quality ladder, notes
}

/** Clocks of one cycle. `frame` may be only this stub when `raw` is present. */
export type FrameStub = Pick<FrameState, 't' | 'tMedia' | 'playbackRate' | 'quality' | 'frameIdx'>;

export interface RawFrame {
  persons: PersonDet[];                 // normalised boxes, as the detector decoded them
  labs?: (Lab | null)[];                // torso Lab per person (same index as persons), null if unsampled
  ballCands?: BallCandidate[];          // ball candidates this cycle
  thumb?: string;                       // optional 64x36 RGBA downsample, base64 (feeds SceneAnalyzer exactly as live)
  scene?: { kind?: SceneKind; confidence?: number; cut?: boolean }; // used when no thumb was recorded
}

export interface FrameRecord {
  kind: 'frame';
  frame: FrameState | FrameStub;
  raw?: RawFrame;
}

export type SessionRecord = SessionHeader | FrameRecord;
export interface Session { header: SessionHeader; frames: FrameRecord[] }

export function isFullFrame(f: FrameState | FrameStub): f is FrameState {
  return (f as FrameState).tracks !== undefined && (f as FrameState).ball !== undefined;
}

/** Labels file (fixtures/<name>.labels.json): ground truth for assertions. */
export interface SessionLabels {
  fixture: string;
  source: string;
  durationS: number;
  possession: { A: number; B: number };            // percent of credited time, excluding replay / close / ball-absent
  turnovers: { t: number; to: 'A' | 'B' }[];
  absent: [number, number][];
  replay: [number, number][];
  close: [number, number][];
  calibratedAtS: number;
  note?: string;
}
