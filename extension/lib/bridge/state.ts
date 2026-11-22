// Map a FrameState + the engine's MatchState to the compact wire state the bridge ingests.
import type { EngineFacts, Event, FrameState, MatchState, StatKey } from '@tacticlens/core';
import type { BridgeEvent, BridgeFact, BridgeState, BridgeStat } from './types';

export const BRIDGE_STATS: StatKey[] = [
  'possession', 'passes', 'turnovers', 'tempo', 'momentum', 'lineHeight', 'fieldTilt',
  'pressure', 'switches', 'sprints', 'freePlayers', 'compactness',
];

export function clockText(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function livenessOf(f: FrameState, match: MatchState | null): BridgeState['liveness'] {
  if (match) return match.liveness;
  if (f.scene.kind === 'REPLAY') return 'REPLAY';
  if (f.scene.kind === 'CLOSE' || f.scene.kind === 'CROWD' || f.scene.kind === 'GRAPHIC') return 'CLOSE_UP';
  return f.teamsCalibrated ? 'LIVE' : 'CALIBRATING';
}

function eventLite(e: Event): BridgeEvent {
  const detail: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(e.detail)) {
    if (typeof v === 'number' && Number.isFinite(v)) detail[k] = Math.round(v * 100) / 100;
    else if (typeof v === 'string') detail[k] = v;
  }
  return { type: e.type, t: Math.round(e.t * 10) / 10, team: e.team, confidence: Math.round(e.confidence * 100) / 100, detail };
}

export interface StateBuildOpts {
  paused: boolean;
  events: Event[];
  facts?: EngineFacts;
  director?: BridgeState['director'];
  halfTime?: boolean;
  /** Jersey-colour labels per side ("Team Red", "Team Yellow"), carried to the bridge so Telegram never says Team A/B. */
  teamLabels?: { A: string; B: string };
  /** Resolved kit colours from the common colour setting (measured kit colours). */
  teamColours?: { A: string; B: string } | null;
  /** Latest final side-chat line; the bridge forwards it as the 10 s Telegram ping. */
  commentary?: { text: string; t: number } | null;
}

const r1 = (v: number): number => Math.round(v * 10) / 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Compact facts for the bridge. Numeric detail is kept only where the bridge must sanity-check it. */
export function factsLite(f: EngineFacts): BridgeFact[] {
  const out: BridgeFact[] = [];
  const add = (
    id: string,
    fact: { valid: boolean; confidence: number; sinceS: number; targets: number[] },
    data: Record<string, number | string>,
    team?: 'A' | 'B' | null,
  ): void => {
    out.push({
      id,
      valid: fact.valid === true,
      confidence: r2(fact.confidence),
      sinceS: r1(fact.sinceS),
      targets: [...fact.targets].slice(0, 12),
      ...(team ? { team } : {}),
      data,
    });
  };
  add('overload', f.overload, { attackers: f.overload.attackers, defenders: f.overload.defenders }, f.overload.team);
  add('formation_a', f.formation.A, {}, 'A');
  add('formation_b', f.formation.B, {}, 'B');
  add('links', f.links, {}, f.links.team);
  add('passing_lanes', f.passing, {}, f.passing.team);
  add('free_player', f.freePlayer, {}, f.freePlayer.team);
  add('press_trap', f.press, {}, f.press.team);
  add('possession_swing', f.swing, {}, f.swing.team);
  add('key_player', f.keyPlayer, {});
  add('switch_arc', f.switchArc, {}, f.switchArc.team);
  add('counter_run', f.counter, {}, f.counter.team);
  add('space_pocket', f.pocket, {});
  return out;
}

export function buildBridgeState(f: FrameState, match: MatchState | null, o: StateBuildOpts): BridgeState {
  const stats: Partial<Record<StatKey, BridgeStat>> = {};
  if (match) {
    for (const k of BRIDGE_STATS) {
      const st = match.stats[k];
      if (!st) continue;
      stats[k] = { value: st.value, gate: st.gate, confidence: st.confidence, paused: st.paused };
    }
  }
  const names = match?.scout?.names ?? match?.teamNames ?? { A: 'Team A', B: 'Team B' };
  const kits = o.teamColours ?? (f.teamColours
    ? { A: f.teamColours.A, B: f.teamColours.B }
    : match?.scout?.kitColours ?? undefined);
  return {
    t: Math.round(f.t * 10) / 10,
    tMedia: Math.round(f.tMedia * 10) / 10,
    wallMs: Date.now(),
    clock: match?.scout?.clock ?? clockText(f.t),
    liveness: livenessOf(f, match),
    scene: f.scene.kind,
    paused: o.paused,
    playing: !o.paused,
    halfTime: o.halfTime ?? false,
    ball: {
      state: f.ball.state,
      coastingS: Math.round(f.ball.coastingS * 10) / 10,
      visibility: Math.round(f.ball.visibility * 100) / 100,
      xy: f.ball.xy,
    },
    possession: match
      ? { A: match.possession.value.A, B: match.possession.value.B, current: match.possession.value.current }
      : { A: 50, B: 50, current: 'NONE' },
    stats,
    facts: o.facts ? factsLite(o.facts) : undefined,
    teamNames: names,
    ...(o.teamLabels ? { teamLabels: { A: o.teamLabels.A, B: o.teamLabels.B } } : {}),
    ...(o.commentary?.text?.trim() ? { commentary: o.commentary } : {}),
    kitColours: kits,
    score: match?.scout?.score ?? null,
    events: o.events.map(eventLite),
    director: o.director,
  };
}
