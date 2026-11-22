// Wire contract mirrored from tools/bridge/src/protocol.ts. Kept local so the extension does not
// depend on the Node-only bridge package; both sides are covered by tests.
import type { BallState, Liveness, SceneKind, StatKey, StatValue, Team } from '@tacticlens/core';

export interface BridgeEvent {
  type: string;
  t: number;
  team: Team;
  confidence: number;
  detail: Record<string, number | string>;
}

export interface BridgeStat {
  value: StatValue;
  gate: 'shown' | 'held' | 'hidden';
  confidence: number;
  paused?: boolean;
}

export interface BridgeFact {
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
  stats: Partial<Record<StatKey, BridgeStat>>;
  facts?: BridgeFact[];
  teamNames: { A: string; B: string };
  /** Jersey-colour labels ("Team Red"); the bridge and analyst refer to teams only by these, never A/B or club names. */
  teamLabels?: { A: string; B: string };
  kitColours?: { A: string; B: string };
  /** Latest final line already shown in the Theatre side chat, reused for the 10 s Telegram ping. */
  commentary?: { text: string; t: number };
  score?: [number, number] | null;
  events: BridgeEvent[];
  director?: { onScreen: string | null; lastGraphicS: number | null };
}

export interface BridgeCommand {
  id: string;
  graphic: string;
  targets: number[];
  reason: string;
  at: number;
}

export interface CommandAck {
  id: string;
  accepted: boolean;
  reason?: string;
}
