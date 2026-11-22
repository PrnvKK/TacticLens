// Typed contracts shared by core, the extension and the bridge.

export type Team = 'A' | 'B' | 'OTHER';
export type Gate = 'shown' | 'held' | 'hidden';
export type Liveness =
  | 'CALIBRATING' | 'LIVE' | 'REPLAY' | 'CLOSE_UP'
  | 'PAUSED' | 'ASK' | 'COMMENTARY' | 'UNSUPPORTED';   // ball loss is ball.state, not a liveness value
export type SceneKind = 'WIDE' | 'CLOSE' | 'REPLAY' | 'CROWD' | 'GRAPHIC';

export type BallState = 'visible' | 'searching' | 'absent';
export type QualityLevel = 0 | 1 | 2 | 3;   // degrade ladder Q0..Q3

export interface Stat<T> {
  value: T;
  confidence: number;      // 0..1, product of components
  updatedAt: number;       // video time, seconds
  gate: Gate;              // output of hysteresis gate
  paused?: boolean;        // ball-dependent stat frozen because ball is absent; render "paused", not value
}

export interface Detection {
  cls: 'player' | 'goalkeeper' | 'referee' | 'ball';
  score: number;
  box: [x1: number, y1: number, x2: number, y2: number]; // normalised video coords
}

export interface Track extends Detection {
  id: number;
  age: number;             // seconds of video time since birth
  hits: number;
  timeSinceUpdate: number; // seconds of video time
  tMedia: number;          // media time of the frame this snapshot came from
  foot: [number, number];  // bottom-centre of box, normalised; graphics anchor here
  vel: [number, number];   // normalised units per second of video time
  team: Team;
  teamMargin: number;      // 0..1
}

/** Measured shirt colours (sRGB hex) plus a 0..1 confidence from the teams fit. */
export interface TeamColours {
  A: string;
  B: string;
  confidence: number;
}

export interface FrameState {
  t: number;               // video currentTime at processing
  tMedia: number;          // media time of the captured frame (requestVideoFrameCallback)
  playbackRate: number;
  globalMotion: [number, number]; // camera pan estimate: median track velocity
  quality: QualityLevel;
  frameIdx: number;
  scene: { kind: SceneKind; confidence: number };
  tracks: Track[];
  ball: { xy: [number, number] | null; visibility: number; coastingS: number; state: BallState };
  teamsCalibrated: boolean;
  /** True on the frame where the scene analyser saw a hard cut. */
  cut?: boolean;
  /** Real kit colours from the teams module; absent until the first successful cluster fit. */
  teamColours?: TeamColours;
}

// Rule-computed stats. Kimi may cite by key, never invent values.
export type StatKey =
  | 'possession' | 'spell' | 'passes' | 'tempo' | 'turnovers' | 'pressure'
  | 'timeToPressure' | 'numbersNearBall' | 'openOptions' | 'freePlayers'
  | 'teamExtent' | 'compactness' | 'blockGap' | 'lineHeight' | 'fieldTilt'
  | 'switches' | 'sprints' | 'ballSpeed' | 'momentum'
  | 'kimiCalls' | 'kimiSpeed' | 'detectorHealth';

export interface Scout {
  names: { A: string; B: string };
  kitColours: { A: string; B: string };   // '#rrggbb'
  score: [number, number] | null;
  clock: string | null;
  source: 'kimi' | 'user';                // Kimi-read values are labels, rendered with a Kimi mark
}

/** Per-team number pair; per-team stats use this instead of strings so the HUD can tween them. */
export interface TeamNum { A: number; B: number }
export type StatValue = number | string | TeamNum;

export interface MatchState {
  liveness: Liveness;
  possession: Stat<{ A: number; B: number; current: Team | 'NONE' }>;
  shape: Record<'A' | 'B', Stat<{ label?: string; lines: number[][]; lineConfidence?: number[]; stable?: boolean[] }>>;   // label only when >= 8 outfielders in shot
  lineHeight: Record<'A' | 'B', Stat<number>>;     // 0 own goal .. 1 opp goal
  passOptions: Stat<{ carrierId: number; targets: { id: number; score: number }[] }>;
  momentum: Stat<number>;                          // -1 (B) .. +1 (A)
  stats: Record<StatKey, Stat<StatValue>>;
  attackDir: { A: 'left' | 'right' | 'unknown'; confidence: number };
  scout: Scout | null;                             // only set when a scorebug was detected
  teamNames: { A: string; B: string };             // fallback labels until scout/user sets them
}

export type EventType =
  | 'turnover' | 'spell' | 'high_press' | 'line_height_change'
  | 'switch_of_play' | 'counter_attack' | 'formation_change' | 'momentum_flip'
  | 'overload' | 'pass' | 'prediction_hit' | 'prediction_miss';

export interface Event {
  type: EventType;
  t: number;
  team: Team;
  confidence: number;
  detail: Record<string, number | string>;
}

// Graphics vocabulary.
export type GraphicType =
  | 'ring' | 'ball_marker' | 'carrier' | 'spotlight' | 'tag' | 'lanes' | 'prediction'
  | 'hull' | 'pressure' | 'overload' | 'links' | 'run' | 'line' | 'switch' | 'pocket' | 'lag_ghost';

export interface GraphicIntent {
  id: string;
  type: GraphicType;
  ids: number[];           // live track ids
  team?: 'A' | 'B';
  label?: string;          // <= 18 chars, no digits
  enteredAt: number;       // video time
  ttlS: number;
  source: 'rules' | 'kimi';
}

export type KimiLane = 'reflex' | 'watch' | 'ask' | 'replay' | 'director';

export interface KimiLine {
  id: string;
  text: string;            // player mentions as [[id]]
  mentions: number[];
  phase: 'build_up' | 'press' | 'transition' | 'settled' | 'set_piece' | 'none';
  lane: KimiLane;
  stamp: LatencyStamp;
  snapshotT: number;       // video time of the snapshot the line was based on
}

export interface Prediction {
  id: string;
  kind: 'pass_to' | 'switch' | 'turnover';
  targetId?: number;
  side?: 'left' | 'right';
  madeAt: number;
  windowS: number;
  status: 'open' | 'hit' | 'miss' | 'void';
  resolvedAt?: number;
}

// ~8 Hz from the brain. The renderer predicts, smooths and animates at 60 fps.
export interface OverlaySnapshot {
  tMedia: number;
  playbackRate: number;
  globalMotion: [number, number];
  liveness: Liveness;
  scene: SceneKind;
  tracks: Track[];
  ball: FrameState['ball'];
  match: MatchState;
  teamsCalibrated: boolean;
  /** True on the frame where the scene analyser saw a hard cut (the renderer snaps and hides markers). */
  cut?: boolean;
  /** Real kit colours for the renderer/HUD; mock/showcase sources may supply their own. */
  teamColours?: TeamColours;
}

// Event-driven stream, independent of snapshots.
export type OverlayMessage =
  | { kind: 'intent'; intent: GraphicIntent }
  | { kind: 'clear'; id?: string }                 // omitted id = clear all (camera cut)
  | { kind: 'line'; line: KimiLine }
  | { kind: 'prediction'; prediction: Prediction };

export interface LatencyStamp {
  provider: string;
  lane: KimiLane | 'scout';
  ttftMs: number;
  totalMs: number;
  tokensIn: number;
  tokensOut: number;
  tokPerS: number;
  framesSent: number;
  eventToGraphicMs?: number;
}

// Provider abstraction (OpenAI-compatible /chat/completions).
export interface LLMProvider {
  name: string;
  baseURL: string;          // OpenAI-compatible /chat/completions
  model: string;
  apiKey: string;
  supportsImages: boolean;
  extra?: Record<string, unknown>; // merged into request body (reasoning_effort, provider routing...)
}
