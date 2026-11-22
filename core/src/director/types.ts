// Director contracts: Kimi is the TV director. Rules compute facts; Kimi decides what to show,
// when, on whom and for how long, and may stay silent. Everything here is pure data.
import type { BallState, GraphicType, MatchState, SceneKind, Team } from '../types';
import type { Fact } from '../engine';
import type { CallTiming } from '../llm/timing';

/** Static graphic vocabulary. The schema enum never changes, so the cached system prefix stays stable. */
export const GRAPHIC_IDS = [
  'overload',
  'formation_a',
  'formation_b',
  'marking_links',
  'passing_lanes',
  'free_player',
  'press_trap',
  'spotlight',
  'possession_swing',
  'key_player',
  'switch_arc',
  'counter_run',
  'space_pocket',
] as const;
export type DirectorGraphicId = (typeof GRAPHIC_IDS)[number];
export type DirectorGraphicChoice = DirectorGraphicId | 'none';
export type DirectorAction = 'show' | 'hide' | 'keep' | 'none';

/** One currently-valid entry in the graphics menu, with the facts behind it. */
export interface MenuItem {
  id: DirectorGraphicId;
  /** Short human label for the UI and the model. */
  label: string;
  /** Renderer primitive. */
  kind: GraphicType;
  /** Live track ids (empty = the renderer reads the shape from the match state). */
  targets: number[];
  team?: 'A' | 'B';
  fact: Fact;
  /** Flat numbers the model may cite. Never nested objects. */
  data: Record<string, number | string>;
}

export interface GraphicsMenu {
  t: number;
  items: MenuItem[];
}

export interface OnScreenGraphic {
  id: DirectorGraphicId;
  sinceS: number;
}

export interface DirectorDecision {
  action: DirectorAction;
  graphic: DirectorGraphicChoice;
  targets: number[];
  /** <= 10 words, may be "". */
  caption: string;
  /** <= 20 words, may be "". */
  say: string;
  duration_s: number;
  confidence: number;
}

export interface DirectorEventLite {
  type: string;
  t: number;
  team: Team;
  conf: number;
  detail: Record<string, number | string>;
}

export interface DirectorMenuItemPayload {
  id: DirectorGraphicId;
  label: string;
  kind: GraphicType;
  targets: number[];
  team?: 'A' | 'B';
  confidence: number;
  sinceS: number;
  [key: string]: number | string | number[] | 'A' | 'B' | undefined;
}

export interface DirectorPayload {
  clock: string;
  t: number;
  scene: SceneKind;
  ball: { state: BallState; x: number | null; y: number | null };
  possession: { A: number; B: number; current: Team | 'NONE' };
  live: number[];
  events: DirectorEventLite[];
  menu: DirectorMenuItemPayload[];
  screen: { graphic: DirectorGraphicId; forS: number } | null;
  sinceLastGraphicS: number | null;
  calm: { state: 'ready' | 'busy'; reason: string };
  /** Pipeline delta: your last accepted decisions (ago = seconds), newest last. */
  recent?: { ago: number; a: DirectorAction; g: DirectorGraphicChoice }[];
  /** Pipeline delta: what the latest annotated frame showed (from the watch lane). */
  seen?: string;
  /** Pipeline delta: ball positions of the last ~5 s as [x,y] percent, oldest first. */
  trail?: [number, number][];
}

export interface DirectorLogEntry {
  /** Wall-clock seconds when the decision arrived. */
  at: number;
  /** Video time of the snapshot the decision was based on. */
  requestT: number;
  action: DirectorAction | 'invalid';
  graphic: DirectorGraphicChoice | 'unknown';
  ttftMs: number;
  totalMs: number;
  accepted: boolean;
  reason?: string;
  caption: string;
}

export interface DirectorOutcome {
  decision: DirectorDecision | null;
  accepted: boolean;
  reason?: string;
  timing: CallTiming | null;
  log: DirectorLogEntry;
  payload: DirectorPayload;
}

export interface DirectorSource {
  /** Latest video time, seconds. */
  t: number;
  playbackRate: number;
  scene: SceneKind;
  ball: BallState;
  ballXY: [number, number] | null;
  match: MatchState;
}

export type DirectorScene = Pick<DirectorSource, 't' | 'playbackRate' | 'scene' | 'ball' | 'ballXY' | 'match'>;
