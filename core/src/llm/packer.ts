// Payload packer: compact match JSON + columnar 5 Hz track history from FrameState history.
// Integers 0-99 as percent of frame, to keep tokens down. Pure; no prompts here.
import type { FrameState, MatchState, Scout, StatKey, Team, Track } from '../types';

export interface PackOptions {
  seconds?: number;          // history span in seconds (Watch 5, Reflex 2)
  hz?: number;               // default 5
  minAgeS?: number;          // a track must be at least this old at the last frame (default 0.3)
  carrierId?: number | null; // from rules; else nearest player to the ball in the last frame
  includeVelocity?: boolean; // last-frame velocity per track, in percent of frame per second
  maxTracks?: number;        // cap, nearest to ball first (default 24)
}

export interface PackedTrack { team: Team; xy: (number[] | null)[]; v?: number[] }
export interface PackedTracking {
  t: number; hz: number;
  ball: (number[] | null)[];
  tracks: Record<string, PackedTrack>;
  carrier: number | null;
}

const pct = (v: number) => Math.max(0, Math.min(99, Math.round(v * 100)));
const isPlayer = (tr: Track) => tr.cls === 'player' || tr.cls === 'goalkeeper';

/** Nearest frame at or before time `t`; falls back to the earliest if none. */
function frameAt(frames: FrameState[], t: number): FrameState | null {
  let best: FrameState | null = null;
  for (const f of frames) { if (f.tMedia <= t + 1e-6) best = f; else break; }
  return best;
}

export function packTracking(history: FrameState[], opts: PackOptions = {}): PackedTracking | null {
  if (!history.length) return null;
  const frames = history.slice().sort((a, b) => a.tMedia - b.tMedia);
  const hz = opts.hz ?? 5;
  const seconds = opts.seconds ?? 5;
  const last = frames[frames.length - 1]!;
  const n = Math.max(1, Math.round(seconds * hz));
  const step = 1 / hz;
  const minAge = opts.minAgeS ?? 0.3;
  const times: number[] = [];
  for (let i = n - 1; i >= 0; i--) times.push(last.tMedia - i * step);
  const slots = times.map((t) => (t < frames[0]!.tMedia - step / 2 ? null : frameAt(frames, t)));

  const ball = slots.map((f) => (f && f.ball.xy && f.ball.state === 'visible' ? [pct(f.ball.xy[0]), pct(f.ball.xy[1])] : null));

  const alive = last.tracks.filter((t) => isPlayer(t) && t.age >= minAge && t.timeSinceUpdate < 0.5);
  const bxy = last.ball.xy;
  const dist = (t: Track) => (bxy ? (t.foot[0] - bxy[0]) ** 2 + (t.foot[1] - bxy[1]) ** 2 : 0);
  let chosen = alive;
  if (opts.maxTracks ?? 24) {
    const cap = opts.maxTracks ?? 24;
    if (chosen.length > cap) chosen = chosen.slice().sort((a, b) => dist(a) - dist(b)).slice(0, cap);
  }
  chosen = chosen.slice().sort((a, b) => a.id - b.id);

  const tracks: Record<string, PackedTrack> = {};
  for (const tr of chosen) {
    const xy = slots.map((f) => {
      const m = f?.tracks.find((x) => x.id === tr.id);
      return m ? [pct(m.foot[0]), pct(m.foot[1])] : null;
    });
    const p: PackedTrack = { team: tr.team, xy };
    if (opts.includeVelocity) p.v = [Math.round(tr.vel[0] * 100), Math.round(tr.vel[1] * 100)];
    tracks[String(tr.id)] = p;
  }

  let carrier: number | null = opts.carrierId ?? null;
  if (carrier == null && bxy && chosen.length) {
    const c = chosen.reduce((a, b) => (dist(a) <= dist(b) ? a : b));
    carrier = dist(c) < 0.08 * 0.08 ? c.id : null;
  }
  return { t: Math.round(last.tMedia * 10) / 10, hz, ball, tracks, carrier };
}

export type PackedStats = Record<string, number | string | { A: number; B: number }>;
const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Only stats gated `shown`; paused stats are the string "paused", never a stale number. */
export function packStats(match: MatchState, keys?: StatKey[]): PackedStats {
  const out: PackedStats = {};
  for (const [k, s] of Object.entries(match.stats) as [StatKey, MatchState['stats'][StatKey]][]) {
    if (keys && !keys.includes(k)) continue;
    if (s.paused) { out[k] = 'paused'; continue; }
    if (s.gate !== 'shown') continue;
    const v = s.value;
    out[k] = typeof v === 'number' ? r2(v) : typeof v === 'string' ? v : { A: r2(v.A), B: r2(v.B) };
  }
  return out;
}

export interface MatchPayload extends PackedTracking {
  stats?: PackedStats;
  scout?: { A: string; B: string; kitA: string; kitB: string; attack: string } | null;
  said?: string[];          // last lines said, so the model does not repeat itself
}

export function packMatch(
  history: FrameState[],
  match: MatchState | null,
  opts: PackOptions & { said?: string[]; scout?: Scout | null } = {},
): MatchPayload | null {
  const tr = packTracking(history, opts);
  if (!tr) return null;
  const out: MatchPayload = { ...tr };
  if (match) {
    const st = packStats(match);
    if (Object.keys(st).length) out.stats = st;
    const sc = opts.scout ?? match.scout;
    const names = sc?.names ?? match.teamNames;
    out.scout = {
      A: names.A, B: names.B, kitA: sc?.kitColours.A ?? '', kitB: sc?.kitColours.B ?? '',
      attack: `A:${match.attackDir.A}`,
    };
  }
  if (opts.said?.length) out.said = opts.said.slice(-3);
  return out;
}

/** Compact JSON string (no whitespace) as sent to the model. */
export function payloadToString(p: unknown): string { return JSON.stringify(p); }

/** Rough token estimate for JSON-ish text. Digits and punctuation tokenise at ~2.5-3 chars/token; be conservative. */
export function estimateJsonTokens(s: string): number { return Math.ceil(s.length / 3); }
