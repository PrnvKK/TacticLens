// Wire contract shared by the extension client and the local bridge. Kept dependency-free so the
// bridge can run on plain Node; the extension mirrors this shape in extension/lib/bridge/types.ts.
import type { BallState, Liveness, SceneKind, StatKey, StatValue, Team } from '@tacticlens/core';

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

export type GraphicId = (typeof GRAPHIC_IDS)[number];

export interface EventLite {
  type: string;
  t: number;
  team: Team;
  confidence: number;
  detail: Record<string, number | string>;
}

export interface StatLite {
  value: StatValue;
  gate: 'shown' | 'held' | 'hidden';
  /** Product confidence from the engine; used to gate MCP exposure. */
  confidence: number;
  paused?: boolean;
}

/** Compact rule fact. Numeric payload stays internal; MCP exposes the qualitative id/team only. */
export interface FactLite {
  id: string;
  valid: boolean;
  confidence: number;
  sinceS: number;
  targets: number[];
  team?: 'A' | 'B';
  data: Record<string, number | string>;
}

export interface BridgeState {
  t: number;
  tMedia: number;
  wallMs: number;
  clock: string;
  liveness: Liveness;
  scene: SceneKind;
  paused: boolean;
  playing: boolean;
  halfTime?: boolean;
  ball: {
    state: BallState;
    coastingS: number;
    visibility: number;
    xy: [number, number] | null;
  };
  possession: { A: number; B: number; current: Team | 'NONE' };
  stats: Partial<Record<StatKey, StatLite>>;
  /** Rule facts; the bridge filters by validity, confidence and overload sanity before MCP exposure. */
  facts?: FactLite[];
  teamNames: { A: string; B: string };
  /** Jersey-colour labels ("Team Red"); validated by the bridge, latest known wins, absent from older extensions. */
  teamLabels?: { A: string; B: string };
  kitColours?: { A: string; B: string };
  /** Latest final line already shown in the Theatre side chat; the bridge forwards it on the 10 s ping. */
  commentary?: { text: string; t: number };
  score?: [number, number] | null;
  /** Events since the previous POST /state from this tab. */
  events: EventLite[];
  director?: { onScreen: string | null; lastGraphicS: number | null };
}

/** A state as stored by the bridge, with the wall time it arrived. */
export interface LiveStateRecord extends BridgeState {
  receivedAt: number;
}

export interface MinuteSnapshot {
  minute: number;
  t: number;
  possession: { A: number; B: number; current: Team | 'NONE' } | null;
  passes: { A: number; B: number } | null;
  turnovers: { A: number; B: number } | null;
}

export interface StoredUpdate {
  id: number;
  at: number;
  t: number;
  text: string;
  skipped: boolean;
}

export interface SnapshotRef {
  id: string;
  path: string;
  t: number;
  width: number;
  height: number;
  bytes: number;
  receivedAt: number;
}

export interface GraphicCommand {
  id: string;
  graphic: GraphicId;
  targets: number[];
  reason: string;
  at: number;
}

export interface CommandAck {
  id: string;
  accepted: boolean;
  reason?: string;
}

export interface SnapshotPost {
  jpegBase64: string;
  t: number;
  width: number;
  height: number;
}

export function isGraphicId(v: unknown): v is GraphicId {
  return typeof v === 'string' && (GRAPHIC_IDS as readonly string[]).includes(v);
}

export function isBridgeState(v: unknown): v is BridgeState {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<BridgeState>;
  return typeof s.t === 'number' && typeof s.wallMs === 'number'
    && typeof s.liveness === 'string' && typeof s.scene === 'string'
    && !!s.ball && typeof s.ball === 'object'
    && !!s.possession && typeof s.possession === 'object'
    && !!s.stats && typeof s.stats === 'object'
    && !!s.teamNames && typeof s.teamNames === 'object';
}
