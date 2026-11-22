// Source profiles: every tunable number for the players pipeline, split by footage type.
// `broadcast` reproduces the pre-existing defaults exactly (zero behaviour change); `game` is
// tuned for EA Sports FC gameplay footage, where players move in sharper bursts, the camera pans
// and zooms more aggressively, and the real-human detector reports lower, jitterier confidences.
//
// The profile drives three layers:
//   - the brain's detector decode (playerConf / nmsIou),
//   - the v2 tracker (association, Kalman, camera flow, box smoothing),
//   - the renderer's latency compensation (extrapMaxS / extrapTau).
// It also feeds the scene-side auto classifier (core/src/scene/source.ts), which maps `auto`
// to one of the two concrete profiles.

export type SourceKind = 'broadcast' | 'game' | 'auto';
export type ResolvedSourceKind = 'broadcast' | 'game';

export interface SourceProfile {
  readonly kind: ResolvedSourceKind;
  // --- detector (players model decode + NMS) ---
  readonly playerConf: number;   // decode floor for the player/referee classes (the "low pass")
  readonly nmsIou: number;       // NMS IoU threshold; higher = looser (keeps more boxes)
  // --- tracker two-pass split + association ---
  readonly highScore: number;    // first-pass floor (detections that may start a track)
  readonly lowScore: number;     // second-pass floor (keep a track alive only)
  readonly matchIou: number;     // first-pass IoU gate
  readonly lowMatchIou: number;  // second-pass IoU gate
  readonly centreGate: number;   // centre-distance gate, in box heights
  readonly maxAgeS: number;      // time-based coast horizon
  readonly momentumWeight: number; // OC-SORT direction term in the association cost
  readonly teamPenalty: number;  // soft penalty for a team mismatch (same team preferred)
  // --- Kalman ---
  readonly posQVel: number;      // velocity process noise for cx/cy
  readonly boxWQVel: number;     // velocity process noise for box width
  readonly boxHQVel: number;     // velocity process noise for box height
  // --- box-size EMA (separate from position) ---
  readonly boxSmoothAlpha: number; // 0 = off (broadcast); > 0 smooths jittery game boxes
  // --- camera flow ---
  readonly camLevels: number;        // LK pyramid levels
  readonly camMaxShiftFrac: number;  // max per-cycle point displacement, x min(w, h)
  // --- renderer latency compensation ---
  readonly extrapMaxS: number;   // max extrapolation clamp, video seconds
  readonly extrapTau: number;    // correction spring time constant, seconds
}

/** Broadcast defaults = the values the pipeline shipped with. */
export const BROADCAST_PROFILE: SourceProfile = {
  kind: 'broadcast',
  playerConf: 0.15, nmsIou: 0.45,
  highScore: 0.5, lowScore: 0.1, matchIou: 0.25, lowMatchIou: 0.25, centreGate: 1.2,
  maxAgeS: 3.0, momentumWeight: 0.18, teamPenalty: 0.4,
  posQVel: 0.15, boxWQVel: 0.01, boxHQVel: 0.02, boxSmoothAlpha: 0,
  camLevels: 2, camMaxShiftFrac: 0.3,
  extrapMaxS: 0.4, extrapTau: 0.08,
};

/** Game (EA Sports FC) tuning: lower/loser detector, agile Kalman, centre-driven association. */
export const GAME_PROFILE: SourceProfile = {
  kind: 'game',
  playerConf: 0.12, nmsIou: 0.5,
  highScore: 0.35, lowScore: 0.08, matchIou: 0.12, lowMatchIou: 0.15, centreGate: 1.8,
  maxAgeS: 4.0, momentumWeight: 0.1, teamPenalty: 0.4,
  posQVel: 0.6, boxWQVel: 0.02, boxHQVel: 0.03, boxSmoothAlpha: 0.5,
  camLevels: 3, camMaxShiftFrac: 0.5,
  extrapMaxS: 0.25, extrapTau: 0.05,
};

/** Resolve a requested kind to a concrete profile (auto stays broadcast until classified). */
export function resolveProfile(kind: SourceKind): SourceProfile {
  return kind === 'game' ? GAME_PROFILE : BROADCAST_PROFILE;
}

/** Parse a `?source=` / UI value, defaulting unknown or auto to broadcast. */
export function parseSourceKind(v: string | null | undefined): SourceKind {
  return v === 'game' || v === 'auto' ? v : 'broadcast';
}
