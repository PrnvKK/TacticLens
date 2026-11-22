// Sanitised MCP view of live data. Facts below the engine gate, invalid facts and impossible
// overloads are dropped here, not merely hidden in the prompt. Only possession/passes/turnovers
// numbers survive, and events/facts lose timestamps, confidences and numeric detail.
import type { Team } from '@tacticlens/core';
import { labelTeams, parseTeamLabels, type TeamLabels } from './labels';
import { formatStatLine, type MatchMemory } from './memory';
import type { BridgeState, EventLite, FactLite, LiveStateRecord, MinuteSnapshot, StatLite } from './protocol';
import { FACT_GATE, filterFacts, NUMERIC_STATS, sideCount, statVisible, visiblePair } from './visibility';

// The A/B keys below are internal structure. Once the extension has sent jersey-colour labels, every
// analyst-facing payload also carries them ("teamLabels", "teamLabel", "currentLabel"), the club names are
// replaced by them and the text fields are rewritten with them, so the analyst never needs to say Team A/B.
export interface ExposedFact { id: string; team?: 'A' | 'B'; teamLabel?: string }
export interface ExposedEvent { type: string; team: Team; teamLabel?: string }
export interface ExposedStats {
  possession?: { A: number; B: number };
  passes?: { A: number; B: number };
  turnovers?: { A: number; B: number };
}
export interface ExposedState {
  /** Jersey-colour labels for sides A/B; the only names the analyst may use. Absent until the extension sends them. */
  teamLabels?: TeamLabels;
  /** Equals teamLabels once known (club names are never shown to the analyst then). */
  teamNames: { A: string; B: string };
  liveness: string;
  scene: string;
  paused: boolean;
  halfTime?: boolean;
  ball: { state: string };
  /** Qualitative dominance label; always safe to quote (no number). */
  possessionLeader: string | null;
  possession: { A: number; B: number; current: string; currentLabel?: string } | null;
  stats: ExposedStats;
  facts: ExposedFact[];
  statLine: string;
}

function labelsOf(s: BridgeState): TeamLabels | null {
  return parseTeamLabels(s.teamLabels);
}

export function possessionLeader(s: BridgeState): string | null {
  const p = visiblePair(s.stats.possession);
  if (!p) return null;
  if (Math.abs(p.A - p.B) < 5) return 'even';
  const names = labelsOf(s) ?? s.teamNames;
  return p.A > p.B ? names.A : names.B;
}

function pairOf(stat: StatLite | undefined): { A: number; B: number } | null {
  return visiblePair(stat);
}

export function exposeFacts(facts: FactLite[] | undefined, labels: TeamLabels | null = null): ExposedFact[] {
  return filterFacts(facts).map((f) => {
    if (!f.team) return { id: f.id };
    return labels ? { id: f.id, team: f.team, teamLabel: labels[f.team] } : { id: f.id, team: f.team };
  });
}

export function overloadSides(e: EventLite): { attackers: number | null; defenders: number | null } {
  const a = sideCount(e.detail?.attackers);
  const d = sideCount(e.detail?.defenders);
  if (a !== null || d !== null) return { attackers: a, defenders: d };
  const near = typeof e.detail?.near === 'string' ? e.detail.near : '';
  const m = /(\d+)\s*v\s*(\d+)/i.exec(near);
  return { attackers: m ? Number(m[1]) : null, defenders: m ? Number(m[2]) : null };
}

export function eventAllowed(e: EventLite): boolean {
  if (typeof e.confidence === 'number' && e.confidence < FACT_GATE) return false;
  if (e.type !== 'overload') return true;
  const s = overloadSides(e);
  // If a count is present it must be sane; 5+ v anything is never shown to the analyst.
  if (s.attackers !== null && s.attackers > 4) return false;
  if (s.defenders !== null && s.defenders > 4) return false;
  return true;
}

export function exposeEvent(e: EventLite, labels: TeamLabels | null = null): ExposedEvent | null {
  if (!eventAllowed(e)) return null;
  const team = e.team === 'A' || e.team === 'B' ? e.team : null;
  return labels && team ? { type: e.type, team: e.team, teamLabel: labels[team] } : { type: e.type, team: e.team };
}

export function exposeStats(stats: BridgeState['stats']): ExposedStats {
  const out: ExposedStats = {};
  for (const key of NUMERIC_STATS) {
    if (!statVisible(stats[key])) continue;
    if (key === 'possession') {
      const p = pairOf(stats.possession);
      if (p) out.possession = { A: Math.round(p.A), B: Math.round(p.B) };
    } else if (key === 'passes') {
      const p = pairOf(stats.passes);
      if (p) out.passes = p;
    } else if (key === 'turnovers') {
      const p = pairOf(stats.turnovers);
      if (p) out.turnovers = p;
    }
  }
  return out;
}

/** includeStats=false is the default: the analyst gets no numbers except when a stat line is due. */
export function exposeState(s: LiveStateRecord, includeStats = false): ExposedState {
  const stats = includeStats ? exposeStats(s.stats) : {};
  const labels = labelsOf(s);
  const cur = s.possession.current;
  return {
    ...(labels ? { teamLabels: labels } : {}),
    teamNames: labels ?? s.teamNames,
    liveness: s.liveness,
    scene: s.scene,
    paused: s.paused,
    halfTime: s.halfTime === true ? true : undefined,
    ball: { state: s.ball.state },
    possessionLeader: possessionLeader(s),
    possession: includeStats && stats.possession
      ? {
        A: stats.possession.A,
        B: stats.possession.B,
        current: cur,
        ...(labels && (cur === 'A' || cur === 'B') ? { currentLabel: labels[cur] } : {}),
      }
      : null,
    stats,
    facts: exposeFacts(s.facts, labels),
    statLine: includeStats ? formatStatLine(s, labels) : '',
  };
}

export function exposeMinute(m: MinuteSnapshot): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (m.possession) out.possession = m.possession;
  if (m.passes) out.passes = m.passes;
  if (m.turnovers) out.turnovers = m.turnovers;
  return out;
}

export function exposeSummary(memory: MatchMemory, includeStats = false): Record<string, unknown> {
  const labels = memory.teamLabels;
  return {
    ...(labels ? { teamLabels: labels } : {}),
    minutes: includeStats
      ? memory.minutes.slice(-10).map(exposeMinute).filter((m) => Object.keys(m).length > 0)
      : [],
    recentEvents: memory.events.slice(-30).map((e) => exposeEvent(e, labels)).filter((e): e is ExposedEvent => e !== null),
    // Updates stored before the labels were known are rewritten on the way out as well.
    previousUpdates: memory.updates.slice(-6).map((u) => ({ text: labelTeams(u.text, labels), skipped: u.skipped })),
    meaningfulSinceLastUpdate: memory.meaningful(),
  };
}
