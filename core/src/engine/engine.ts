// Deterministic engine: FrameState in, MatchState and Event[] out. Pure TS, no DOM, no network.
// Rules: only LIVE (WIDE, teams calibrated) frames change stats. REPLAY / CLOSE_UP / PAUSED / CALIBRATING freeze every
// stat object untouched (zero stat changes). ball.state = absent pauses every ball-dependent stat (paused=true, value kept,
// credited to no one); ball-independent stats (shape, lines, extent, compactness, free players) keep running.
// Every value is a Stat<T> with a confidence (product of components) and a hysteresis gate.
import type { Event, EventType, FrameState, Liveness, MatchState, Stat, StatKey, StatValue, Team, Track } from '../types';
import {
  ASPECT, BODY_M, Ewma, clamp, convexHull, dist, distMetres, mean, median, nearest, perspectiveOf, polygonArea, segDist,
  teamPlayers, bodyH, withinMetres, type Perspective, type Pt,
} from './geometry';
import { HysteresisGate } from './gate';
import { PossessionFSM, type PState, type PossessionOpts, type PossessionStep } from './possession';
import { LineTracker, estimateHorizon, type TrackedShape } from './lines';
import {
  emptyFacts, type EngineFacts, type Fact, type FormationFact, type KeyPlayerCandidate, type KeyPlayerFact,
  type OverloadFact, type PossessionSwingFact,
} from './facts';

export const STAT_KEYS: StatKey[] = [
  'possession', 'spell', 'passes', 'tempo', 'turnovers', 'pressure', 'timeToPressure', 'numbersNearBall', 'openOptions',
  'freePlayers', 'teamExtent', 'compactness', 'blockGap', 'lineHeight', 'fieldTilt', 'switches', 'sprints', 'ballSpeed',
  'momentum', 'kimiCalls', 'kimiSpeed', 'detectorHealth',
];
/** Stats that need the ball: paused while ball.state = absent. */
export const BALL_DEPENDENT: ReadonlySet<StatKey> = new Set<StatKey>([
  'possession', 'spell', 'passes', 'tempo', 'turnovers', 'pressure', 'timeToPressure', 'numbersNearBall', 'openOptions',
  'fieldTilt', 'switches', 'ballSpeed', 'momentum',
]);

export interface MarkingPair { attacker: number; defender: number; distM: number }
export interface EngineDetail {
  possessionState: PState;
  carrierId: number | null;
  /** Credited seconds per team. */
  credited: { A: number; B: number };
  formation: { A: string | null; B: string | null };
  /** Per-team line geometry confidence, for fading unstable formation lines. */
  shape: Record<'A' | 'B', { confidence: number; lineConfidence: number[]; stable: boolean[] }>;
  marking: MarkingPair[];
  /** Rule-computed facts for the director; every fact is { valid, confidence, sinceS, targets }. */
  facts: EngineFacts;
  /** Raw per-team numbers (unrounded) behind the per-team stats. */
  teamNumbers: Record<'A' | 'B', { passes: number; tempo: number; lost: number; free: number; extentLenM: number; extentWidM: number; compactness: number }>;
  medianBodyH: number;
  gateToggles: number;
}
export interface EngineOutput { match: MatchState; events: Event[]; detail: EngineDetail }

export interface EngineOpts {
  possession: Partial<PossessionOpts>;
  pressRadiusM: number;      // ~5 m: opponents pressuring the carrier
  nearBallRadiusM: number;   // ~15 m: numbers near the ball
  overloadRadiusM: number;   // ~10 m: overload cluster
  freeRadiusM: number;       // ~4 m: no opponent this close
  markingRadiusM: number;    // ~5 m: a marking pair
  laneClearH: number;
  maxDt: number;
}
export const DEFAULT_ENGINE: EngineOpts = {
  possession: {}, pressRadiusM: 5, nearBallRadiusM: 10, overloadRadiusM: 10, freeRadiusM: 4, markingRadiusM: 5,
  laneClearH: 0.8, maxDt: 0.5,
};

const mk = <T>(value: T): Stat<T> => ({ value, confidence: 0, updatedAt: 0, gate: 'hidden' });
const fix = (v: number, d = 1) => v.toFixed(d);
const rnd = (v: number, d = 0) => { const k = 10 ** d; return Math.round(v * k) / k; };
const AB = (a: number, b: number, d = 0) => ({ A: rnd(a, d), B: rnd(b, d) });
/** Stats whose value is a per-team { A, B } pair of numbers (the rest are plain numbers or strings). */
export const TEAM_STATS: ReadonlySet<StatKey> = new Set<StatKey>(['possession', 'passes', 'tempo', 'turnovers', 'numbersNearBall', 'freePlayers', 'teamExtent', 'compactness', 'lineHeight', 'fieldTilt']);

function initialStats(): Record<StatKey, Stat<StatValue>> {
  const r = {} as Record<StatKey, Stat<StatValue>>;
  for (const k of STAT_KEYS) r[k] = mk<StatValue>(TEAM_STATS.has(k) ? { A: 0, B: 0 } : 0);
  return r;
}

export function livenessOf(f: FrameState): Liveness {
  if (!f.teamsCalibrated) return 'CALIBRATING';
  switch (f.scene.kind) {
    case 'REPLAY': return 'REPLAY';
    case 'CLOSE': return 'CLOSE_UP';
    case 'CROWD': case 'GRAPHIC': return 'PAUSED';
    default: return 'LIVE';
  }
}

export class Engine {
  readonly o: EngineOpts;
  private fsm: PossessionFSM;
  private gates = new Map<string, HysteresisGate>();
  private stats = initialStats();
  private match: MatchState;
  private prevT: number | null = null;
  private wasLive = false;
  private votes = { score: 0, total: 0 };
  private passes = { A: 0, B: 0 };
  private lost: { A: number[]; B: number[] } = { A: [], B: [] };
  private tilt = { A: 0, B: 0 };
  private ballHist: { t: number; x: number }[] = [];
  private prevBall: { t: number; xy: Pt } | null = null;
  private switches = 0;
  private sprintActive = new Set<number>();
  private sprints = 0;
  private cool = new Map<EventType, number>();
  private momentumEwma = new Ewma(20);
  private momentumSign = 0;
  private lineRef: { A: number | null; B: number | null } = { A: null, B: null };
  private formationEmitted: { A: string | null; B: string | null } = { A: null, B: null };
  private lineTracker: Record<'A' | 'B', LineTracker> = { A: new LineTracker(), B: new LineTracker() };
  private counter: { team: 'A' | 'B'; t0: number; x0: number } | null = null;
  private frames = { n: 0, visible: 0 };
  private detail: EngineDetail;
  /** Facts state: how long each condition has held (keyed), plus involvement windows. */
  private held = new Map<string, number>();
  private possHist: { t: number; A: number }[] = [];
  private kp = new Map<number, { team: 'A' | 'B'; touches: number; carries: number; received: number; firstT: number; lastT: number; margin: number }>();
  private lastCarrier: number | null = null;
  private lastTouchT = -Infinity;
  private inThird = new Set<number>();
  private switchAt = -Infinity;
  private switchTarget: number | null = null;
  private counterAt = -Infinity;
  private counterRunner: number | null = null;

  constructor(o: Partial<EngineOpts> = {}) {
    this.o = { ...DEFAULT_ENGINE, ...o };
    this.fsm = new PossessionFSM(this.o.possession);
    this.match = {
      liveness: 'CALIBRATING',
      possession: mk({ A: 50, B: 50, current: 'NONE' as Team | 'NONE' }),
      shape: { A: mk({ lines: [] as number[][] }), B: mk({ lines: [] as number[][] }) },
      lineHeight: { A: mk(0.5), B: mk(0.5) },
      passOptions: mk({ carrierId: -1, targets: [] as { id: number; score: number }[] }),
      momentum: mk(0),
      stats: this.stats,
      attackDir: { A: 'unknown', confidence: 0 },
      scout: null,
      teamNames: { A: 'Team A', B: 'Team B' },
    };
    this.detail = this.emptyDetail();
  }

  private emptyDetail(): EngineDetail {
    const z = { passes: 0, tempo: 0, lost: 0, free: 0, extentLenM: 0, extentWidM: 0, compactness: 0 };
    return {
      possessionState: 'DEAD', carrierId: null, credited: { A: 0, B: 0 }, formation: { A: null, B: null },
      shape: { A: { confidence: 0, lineConfidence: [], stable: [] }, B: { confidence: 0, lineConfidence: [], stable: [] } },
      marking: [], facts: emptyFacts(), teamNumbers: { A: { ...z }, B: { ...z } }, medianBodyH: 0, gateToggles: 0,
    };
  }

  private gate(key: string): HysteresisGate {
    let g = this.gates.get(key);
    if (!g) { g = new HysteresisGate(); this.gates.set(key, g); }
    return g;
  }
  private setStat<T>(key: string, value: T, conf: number, t: number): Stat<T> {
    conf = clamp(conf, 0, 1);
    return { value, confidence: conf, updatedAt: t, gate: this.gate(key).update(conf, t) };
  }
  private put(key: StatKey, value: StatValue, conf: number, t: number): void {
    this.stats[key] = this.setStat('s.' + key, value, conf, t);
  }
  /** Ball-dependent stat while the ball is absent: keep the value, mark paused, never touch updatedAt. */
  private pause<T>(key: string, s: Stat<T>): Stat<T> {
    if (s.paused) return s;
    this.gate(key).reset();
    return { ...s, gate: 'hidden', paused: true };
  }
  private cooled(type: EventType, t: number, s: number): boolean {
    const last = this.cool.get(type);
    if (last !== undefined && t - last < s) return false;
    this.cool.set(type, t);
    return true;
  }

  update(f: FrameState): EngineOutput {
    const events: Event[] = [];
    const t = f.t;
    const dt = this.prevT === null ? 0 : clamp(t - this.prevT, 0, this.o.maxDt);
    this.prevT = t;
    this.frames.n++;
    if (f.ball.state === 'visible') this.frames.visible++;

    const liveness = livenessOf(f);
    if (liveness !== 'LIVE') {
      if (this.wasLive) {
        this.fsm.gap(); this.ballHist = []; this.prevBall = null; this.counter = null; this.sprintActive.clear();
        this.held.clear(); this.possHist = []; this.kp.clear(); this.lastCarrier = null; this.inThird.clear();
        this.switchAt = -Infinity; this.counterAt = -Infinity;
      }
      this.wasLive = false;
      if (liveness !== this.match.liveness) this.match = { ...this.match, liveness };
      return { match: this.match, events, detail: this.detail };
    }
    this.wasLive = true;
    this.match = { ...this.match, shape: { ...this.match.shape }, lineHeight: { ...this.match.lineHeight } };   // never mutate a previously returned MatchState

    const players = teamPlayers(f.tracks);
    const P = { A: players.filter((p) => p.team === 'A'), B: players.filter((p) => p.team === 'B') };
    const H = median(players.map(bodyH)) || 0.1;
    const ballAbsent = f.ball.state === 'absent' || !f.ball.xy;
    const ball: Pt | null = ballAbsent ? null : f.ball.xy;
    const ballVis = f.ball.state === 'visible' ? 1 : f.ball.state === 'searching' ? clamp(1 - f.ball.coastingS, 0.3, 0.95) : 0;
    const margin = mean(players.map((p) => p.teamMargin));
    const cBase = margin * Math.min(1, players.length / 12) * (f.scene.kind === 'WIDE' ? 1 : 0);
    const cBall = cBase * ballVis;
    const mPerH = BODY_M / H;   // crude local scale: ~metres per frame-height unit
    const horizon = estimateHorizon(f.tracks);   // shot-level ground-plane fit feeding the line pencil
    const persp = perspectiveOf(players, horizon);   // local player height at a screen y (perspective-aware radii)

    // ---- attack direction: which side each goalkeeper defends, owned by the team whose centroid is nearer
    const decay = Math.exp(-dt / 90);
    this.votes.score *= decay; this.votes.total *= decay;
    if (P.A.length >= 3 && P.B.length >= 3) {
      const cA = mean(P.A.map((p) => p.foot[0])), cB = mean(P.B.map((p) => p.foot[0]));
      for (const g of f.tracks) {
        if (g.cls !== 'goalkeeper' || g.timeSinceUpdate > 0.4) continue;
        const x = g.foot[0];
        if (x > 0.35 && x < 0.65) continue;
        const owner: 'A' | 'B' = Math.abs(x - cA) <= Math.abs(x - cB) ? 'A' : 'B';
        const defendsLeft = x < 0.5;
        this.votes.score += dt * ((owner === 'A') === defendsLeft ? 1 : -1);   // A attacks right when A defends left
        this.votes.total += dt;
      }
    }
    const dirConf = this.votes.total > 0 ? clamp(this.votes.total / 10, 0, 1) * (Math.abs(this.votes.score) / this.votes.total) : 0;
    const aDir: 'left' | 'right' | 'unknown' = dirConf >= 0.6 ? (this.votes.score > 0 ? 'right' : 'left') : 'unknown';
    const dirOf = (tm: 'A' | 'B'): 'left' | 'right' | 'unknown' => (aDir === 'unknown' ? 'unknown' : tm === 'A' ? aDir : aDir === 'right' ? 'left' : 'right');
    const attackAxis = (tm: 'A' | 'B') => (dirOf(tm) === 'left' ? -1 : 1);

    // ---- possession FSM (absent ball -> gap: credited to no one)
    const step = this.fsm.update(dt, ball, players, H);
    const holder: 'A' | 'B' | null = this.fsm.state === 'A' || this.fsm.state === 'B' ? this.fsm.state : null;
    const carrier = this.fsm.carrierId !== null ? players.find((p) => p.id === this.fsm.carrierId) ?? null : null;

    const ev = (type: EventType, team: Team, confidence: number, detail: Event['detail']) => events.push({ type, t, team, confidence: clamp(confidence, 0, 1), detail });
    if (step.turnover) {
      this.lost[step.turnover.from].push(t);
      ev('turnover', step.turnover.to, cBall, { from: step.turnover.from, carrierId: step.turnover.carrierId });
      if (ball) this.counter = { team: step.turnover.to, t0: t, x0: ball[0] };
    }
    if (step.pass) { this.passes[step.pass.team]++; ev('pass', step.pass.team, cBall, { from: step.pass.from, to: step.pass.to }); }
    if (step.spellDone) ev('spell', step.spellDone.team, cBall, { seconds: Math.round(step.spellDone.seconds * 10) / 10 });

    // ---- ball-dependent stats
    const detail = this.emptyDetail();
    detail.possessionState = this.fsm.state; detail.carrierId = this.fsm.carrierId; detail.credited = { ...this.fsm.credited };
    detail.medianBodyH = H;
    const facts = detail.facts;
    const credTotal = this.fsm.credited.A + this.fsm.credited.B;
    const pct = this.fsm.percent();
    const tempoOf = (tm: 'A' | 'B') => (this.fsm.credited[tm] > 5 ? this.passes[tm] / (this.fsm.credited[tm] / 60) : 0);
    const lostIn5 = (tm: 'A' | 'B') => { this.lost[tm] = this.lost[tm].filter((x) => t - x <= 300); return this.lost[tm].length; };
    for (const tm of ['A', 'B'] as const) { const n = detail.teamNumbers[tm]; n.passes = this.passes[tm]; n.tempo = tempoOf(tm); n.lost = lostIn5(tm); }

    // pass options, pressure, numbers near ball. Radii are ~metres measured with the local player height
    // (a perspective ellipse), never a fixed box-height fraction. Goalkeepers (cls) and uncertain teams are excluded.
    let optTargets: { id: number; score: number }[] = [];
    let openCount = 0, pressure = 0, nearA = 0, nearB = 0;
    let presserIds: number[] = [];
    let freeId: number | null = null, freeSpaceM = 0;
    const nearIds: number[] = [];
    const overA: number[] = [], overB: number[] = [];
    const attackTeam = holder ?? this.fsm.lastHolder;
    if (ball) {
      for (const p of players) {
        if (p.teamMargin < 0.55) continue;   // uncertain team: never counted
        if (withinMetres(ball, p.foot, this.o.nearBallRadiusM, persp, ball[1])) {
          nearIds.push(p.id);
          if (p.team === 'A') nearA++; else nearB++;
        }
        if (withinMetres(ball, p.foot, this.o.overloadRadiusM, persp, ball[1])) (p.team === 'A' ? overA : overB).push(p.id);
      }
    }
    facts.nearBall = { A: nearA, B: nearB, ids: nearIds, radiusM: this.o.nearBallRadiusM };
    if (holder && carrier) {
      const opp = P[holder === 'A' ? 'B' : 'A'];
      const known = opp.filter((o) => o.teamMargin >= 0.55);
      const pressers = known.filter((o) => withinMetres(o.foot, carrier.foot, this.o.pressRadiusM, persp, carrier.foot[1]));
      pressure = pressers.length;
      presserIds = pressers.map((o) => o.id);
      const ax = attackAxis(holder);
      const scored = P[holder].filter((m) => m.id !== carrier.id && m.teamMargin >= 0.55).map((m) => {
        const nearOpp = nearest(m.foot, known);
        const spaceM = nearOpp ? distMetres(m.foot, nearOpp.track.foot, persp, m.foot[1]) : 99;
        const open = clamp(spaceM / 2.5, 0, 1);
        const minLane = Math.min(9, ...opp.map((o) => segDist(o.foot, carrier.foot, m.foot)));
        const lane = clamp(minLane / (this.o.laneClearH * 2 * H), 0, 1);
        const prog = clamp(0.5 + (ax * (m.foot[0] - carrier.foot[0]) * ASPECT) / (6 * H), 0, 1);
        return { id: m.id, score: Math.round((0.4 * open + 0.35 * lane + 0.25 * prog) * 100) / 100, clear: minLane > this.o.laneClearH * H, spaceM };
      }).sort((a, b) => b.score - a.score);
      optTargets = scored.slice(0, 3).map(({ id, score }) => ({ id, score }));
      openCount = scored.filter((s) => s.clear).length;
      const bestFree = scored.find((s) => s.spaceM >= this.o.freeRadiusM);
      if (bestFree) { freeId = bestFree.id; freeSpaceM = bestFree.spaceM; }

      // press trap: at least two known opponents within ~5 m of the carrier, held briefly.
      const pressOk = pressure >= 2 && cBall >= 0.35;
      const pressHeld = this.hold('press:' + carrier.id, pressOk, t);
      facts.press = {
        valid: pressOk && pressHeld >= 0.5,
        confidence: cBall * clamp(0.45 + 0.15 * pressure, 0, 1),
        sinceS: pressHeld, targets: [carrier.id, ...presserIds], carrierId: carrier.id, pressers: pressure, team: holder,
      };
      // passing lanes from the carrier; only options the rules scored.
      const passOk = optTargets.length > 0 && cBall >= 0.35;
      const passHeld = this.hold('pass:' + carrier.id, passOk, t);
      facts.passing = {
        valid: passOk,
        confidence: cBall * clamp(0.5 + (optTargets[0]?.score ?? 0) * 0.5, 0, 1),
        sinceS: passHeld, targets: [carrier.id, ...optTargets.map((s) => s.id)], carrierId: carrier.id, options: optTargets, team: holder,
      };
      // free player: the best option with no opponent within ~4 m.
      const freeOk = freeId !== null && cBall >= 0.35;
      const freeHeld = this.hold('free:' + carrier.id + ':' + freeId, freeOk, t);
      facts.freePlayer = {
        valid: freeOk,
        confidence: cBall * clamp(freeSpaceM / 8, 0.4, 1),
        sinceS: freeHeld, targets: freeId !== null ? [carrier.id, freeId] : [carrier.id], carrierId: carrier.id,
        freeId, spaceM: Math.round(freeSpaceM * 10) / 10, team: holder,
      };
    }

    // switch of play, ball speed index
    let ballSpeed = String(this.stats.ballSpeed.value || 'slow');
    if (ball) {
      this.ballHist.push({ t, x: ball[0] });
      while (this.ballHist.length && t - this.ballHist[0]!.t > 2) this.ballHist.shift();
      if (holder && this.ballHist.length > 3) {
        const xs = this.ballHist.map((h) => h.x);
        const dx = Math.max(...xs) - Math.min(...xs);
        if (dx > 0.4 && this.cooled('switch_of_play', t, 3)) {
          this.switches++;
          ev('switch_of_play', holder, cBall, { side: ball[0] > this.ballHist[0]!.x ? 'right' : 'left', span: Math.round(dx * 100) / 100 });
          this.switchAt = t;
          this.switchTarget = optTargets[0]?.id ?? null;
        }
      }
      if (this.prevBall && f.ball.state === 'visible' && t > this.prevBall.t) {
        const dtb = t - this.prevBall.t;
        const vx = (ball[0] - this.prevBall.xy[0]) / dtb - f.globalMotion[0], vy = (ball[1] - this.prevBall.xy[1]) / dtb - f.globalMotion[1];
        const sp = Math.hypot(vx * ASPECT, vy);
        ballSpeed = sp < 0.25 ? 'slow' : sp < 0.7 ? 'fast' : 'driven';
      }
      this.prevBall = { t, xy: ball };
    } else { this.ballHist = []; this.prevBall = null; }

    // field tilt: credited time with the ball in the opponent half of the shot
    if (ball && holder && aDir !== 'unknown') {
      const inOppHalf = attackAxis(holder) > 0 ? ball[0] > 0.5 : ball[0] < 0.5;
      if (inOppHalf) this.tilt[holder] += dt;
    }

    // momentum: EWMA of possession share, tempo and line height (the components that are known)
    const hA = this.lineHeightOf(P.A, players, dirOf('A')), hB = this.lineHeightOf(P.B, players, dirOf('B'));
    let mom = this.momentumEwma.v ?? 0;
    if (ball) mom = this.momentumEwma.push(holder === 'A' ? 1 : holder === 'B' ? -1 : 0, dt);
    const tempoTerm = Math.tanh((tempoOf('A') - tempoOf('B')) / 8);
    const lineTerm = hA !== null && hB !== null ? hA - hB : 0;
    mom = clamp(0.7 * mom + 0.15 * tempoTerm + 0.15 * lineTerm, -1, 1);
    if (ball) {
      const sgn = mom > 0.12 ? 1 : mom < -0.12 ? -1 : 0;
      if (sgn !== 0 && this.momentumSign !== 0 && sgn !== this.momentumSign) ev('momentum_flip', sgn > 0 ? 'A' : 'B', cBall, { momentum: Math.round(mom * 100) / 100 });
      if (sgn !== 0) this.momentumSign = sgn;
    }

    if (ballAbsent) {
      for (const k of BALL_DEPENDENT) this.stats[k] = this.pause('s.' + k, this.stats[k]);
      this.match.possession = this.pause('possession', this.match.possession);
      this.match.passOptions = this.pause('passOptions', this.match.passOptions);
      this.match.momentum = this.pause('momentum', this.match.momentum);
      this.possHist = [];   // a ball gap breaks the 30 s swing history
    } else {
      const cur: Team | 'NONE' = holder ?? 'NONE';
      const pConf = cBall * clamp(credTotal / 2, 0, 1);
      this.match.possession = this.setStat('possession', { A: pct.A, B: pct.B, current: cur }, pConf, t);
      this.put('possession', AB(pct.A, pct.B), pConf, t);
      // possession swing: change in share over the last 30 s, only with enough credited time.
      this.possHist.push({ t, A: pct.A });
      while (this.possHist.length && t - this.possHist[0]!.t > 60) this.possHist.shift();      const ref = this.possHist.find((h) => h.t >= t - 30) ?? this.possHist[0];
      const delta = ref ? pct.A - ref.A : 0;
      const swingTeam: 'A' | 'B' | null = delta >= 8 ? 'A' : delta <= -8 ? 'B' : null;
      const swingOk = credTotal >= 15 && swingTeam !== null;
      const swingHeld = this.hold('swing:' + (swingTeam ?? '-'), swingOk, t);
      facts.swing = {
        valid: swingOk && swingHeld >= 2,
        confidence: clamp(credTotal / 30, 0, 1) * clamp(Math.abs(delta) / 25, 0, 1),
        sinceS: swingHeld, targets: [], team: swingTeam, deltaPct: Math.round(delta * 10) / 10, windowS: 30,
      };
      this.put('spell', Math.round(this.fsm.spellS * 10) / 10, cBall * (holder ? 1 : 0.4), t);
      this.put('passes', AB(this.passes.A, this.passes.B), cBall, t);
      this.put('tempo', AB(tempoOf('A'), tempoOf('B'), 1), cBall * clamp(credTotal / 30, 0, 1), t);
      this.put('turnovers', AB(detail.teamNumbers.A.lost, detail.teamNumbers.B.lost), cBall, t);   // balls lost per team, last 5 min
      this.put('pressure', pressure, cBall * (holder ? 1 : 0.4), t);
      this.put('numbersNearBall', AB(nearA, nearB), cBall, t);
      this.put('openOptions', openCount, cBall * (holder ? 1 : 0.4), t);
      const tiltPct = (tm: 'A' | 'B') => (this.fsm.credited[tm] > 0 ? (100 * this.tilt[tm]) / this.fsm.credited[tm] : 0);
      this.put('fieldTilt', AB(tiltPct('A'), tiltPct('B')), cBall * dirConf * 0.8, t);
      this.put('switches', this.switches, cBall, t);
      this.put('ballSpeed', ballSpeed, cBall, t);
      this.put('timeToPressure', 0, 0, t);   // not computed yet: published at zero confidence (intended: seconds from gaining the ball to the first opponent within ~3 m)
      this.match.passOptions = this.setStat('passOptions', { carrierId: carrier?.id ?? -1, targets: optTargets }, cBall * (holder ? 1 : 0), t);
      const mConf = cBall * clamp(credTotal / 10, 0, 1);
      this.match.momentum = this.setStat('momentum', Math.round(mom * 1000) / 1000, mConf, t);
      this.put('momentum', Math.round(mom * 1000) / 1000, mConf, t);
    }

    // ---- ball-independent stats (keep running while the ball is absent)
    const sConf = cBase * (P.A.length >= 3 && P.B.length >= 3 ? 1 : 0);
    const shape: Record<'A' | 'B', { lines: number[][]; label: string | undefined }> = { A: { lines: [], label: undefined }, B: { lines: [], label: undefined } };
    const groups: Record<'A' | 'B', TrackedShape> = { A: null as never, B: null as never };
    for (const tm of ['A', 'B'] as const) {
      const ps = P[tm];
      const ax = attackAxis(tm) as 1 | -1;
      const g = this.lineTracker[tm].update(ps.map((p) => ({ id: p.id, foot: p.foot, boxH: bodyH(p) })), { t, dt, H, attackAxis: ax, horizon, canLabel: ps.length >= 8 });
      groups[tm] = g;
      shape[tm] = { lines: g.lines, label: g.label ?? undefined };   // lines hold track ids, back to front
      detail.shape[tm] = { confidence: g.confidence, lineConfidence: g.lineConfidence, stable: g.stable };
      const n = detail.teamNumbers[tm];
      if (ps.length >= 3) {
        const xs = ps.map((p) => p.foot[0] * ASPECT), ys = ps.map((p) => p.foot[1]);
        n.extentLenM = (Math.max(...xs) - Math.min(...xs)) * mPerH;
        n.extentWidM = (Math.max(...ys) - Math.min(...ys)) * mPerH;
        n.compactness = polygonArea(convexHull(ps.map((p) => p.foot))) / (ps.length * H * H);
      }
      const opp = P[tm === 'A' ? 'B' : 'A'];
      const oppKnown = opp.filter((o) => o.teamMargin >= 0.55);
      n.free = ps.filter((p) => {
        const n = nearest(p.foot, oppKnown);
        return !n || distMetres(p.foot, n.track.foot, persp, p.foot[1]) > this.o.freeRadiusM;
      }).length;
      detail.formation[tm] = g.label;
      // formation lines: only when the shape gate is actually shown and the pencil is stable.
      const lineConf = g.lineConfidence.length ? mean(g.lineConfidence) : 0;
      const formOk = this.match.shape[tm].gate === 'shown' && g.lines.length >= 2 && ps.length >= 6 && lineConf >= 0.35 && g.confidence >= 0.35;
      const formHeld = this.hold('formation:' + tm, formOk, t);
      facts.formation[tm] = {
        valid: formOk && formHeld >= 0.6,
        confidence: sConf * clamp(0.4 + 0.6 * lineConf, 0, 1),
        sinceS: formHeld,
        targets: g.lines.flat().slice(0, 11),
        team: tm,
        lines: g.lines.length,
        outfielders: ps.length,
        label: g.label,
      };
    }
    for (const tm of ['A', 'B'] as const) {
      const sh = shape[tm];
      const g = groups[tm];
      // Runtime shape value carries per-line confidence/stable flags for the renderer to fade unstable lines.
      const shapeValue = {
        lines: sh.lines, lineConfidence: g.lineConfidence, stable: g.stable,
        ...(sh.label ? { label: sh.label } : {}),
      };
      const lineConf = g.lineConfidence.length ? mean(g.lineConfidence) : 1;
      this.match.shape[tm] = this.setStat(
        'shape' + tm,
        shapeValue,
        sConf * clamp(0.35 + 0.65 * lineConf, 0, 1),
        t,
      );
      const h = tm === 'A' ? hA : hB;
      const lhConf = h === null ? 0 : sConf * dirConf;
      this.match.lineHeight[tm] = this.setStat('lh' + tm, h ?? this.match.lineHeight[tm].value, lhConf, t);
      // line_height_change: shown value moved >= 0.2 from the last reported baseline
      if (h !== null && this.match.lineHeight[tm].gate === 'shown') {
        const ref = this.lineRef[tm];
        if (ref === null) this.lineRef[tm] = h;
        else if (Math.abs(h - ref) >= 0.2 && this.cooled('line_height_change', t, 5)) { ev('line_height_change', tm, lhConf, { from: Math.round(ref * 100) / 100, to: Math.round(h * 100) / 100 }); this.lineRef[tm] = h; }
      }
      // formation_change: the tracker's label hysteresis (3 s stable, 10 s dwell) promoted a different formation
      if (g.label) {
        const prev = this.formationEmitted[tm];
        if (prev === null) this.formationEmitted[tm] = g.label;   // first label adopted silently
        else if (g.changed && prev !== g.label && sConf >= 0.75) { ev('formation_change', tm, sConf, { from: prev, to: g.label }); this.formationEmitted[tm] = g.label; }
      }
    }
    const nA = detail.teamNumbers.A, nB = detail.teamNumbers.B;
    this.put('freePlayers', AB(nA.free, nB.free), sConf, t);
    this.put('teamExtent', AB(nA.extentLenM, nB.extentLenM), sConf, t);   // block length in ~m (width stays in detail.teamNumbers)
    this.put('compactness', AB(nA.compactness, nB.compactness, 2), sConf, t);
    const cen = (ps: Track[]): Pt => [mean(ps.map((p) => p.foot[0])), mean(ps.map((p) => p.foot[1]))];
    this.put('blockGap', Math.round(P.A.length && P.B.length ? distMetres(cen(P.A), cen(P.B), persp) : 0), sConf, t);
    this.put('lineHeight', AB(hA ?? this.match.lineHeight.A.value, hB ?? this.match.lineHeight.B.value, 2), sConf * dirConf, t);
    // sprints: pan-compensated speed above ~7 m/s, counted on the rising edge per track (extra tier: kept below the gate on purpose)
    for (const p of players) {
      const v = Math.hypot((p.vel[0] - f.globalMotion[0]) * ASPECT, p.vel[1] - f.globalMotion[1]) * mPerH;
      if (v > 7 && p.hits >= 6) { if (!this.sprintActive.has(p.id)) { this.sprintActive.add(p.id); this.sprints++; } } else if (v < 5) this.sprintActive.delete(p.id);
    }
    this.put('sprints', this.sprints, sConf * 0.7, t);
    this.put('detectorHealth', `q${f.quality} ball ${fix((100 * this.frames.visible) / this.frames.n, 0)}%`, 1, t);   // quality and ball visibility only; loop rate and cycle time are measured outside the engine
    this.put('kimiCalls', '-', 0, t);    // placeholder: prediction hits and resolved calls come from the prediction resolver
    this.put('kimiSpeed', '-', 0, t);    // placeholder: TTFT is measured by the LLM governor, not here
    this.match.attackDir = { A: aDir, confidence: dirConf };

    // marking pairs: each attacker's nearest unclaimed defender within ~5 m, greedy by distance
    if (attackTeam) {
      const def = P[attackTeam === 'A' ? 'B' : 'A'], usedDef = new Set<number>(), usedAtt = new Set<number>();
      const cand: MarkingPair[] = [];
      for (const a of P[attackTeam]) for (const d of def) {
        const dm = distMetres(a.foot, d.foot, persp);
        if (dm <= this.o.markingRadiusM) cand.push({ attacker: a.id, defender: d.id, distM: Math.round(dm * 10) / 10 });
      }
      cand.sort((x, y) => x.distM - y.distM);
      for (const c of cand) if (!usedDef.has(c.defender) && !usedAtt.has(c.attacker)) { usedDef.add(c.defender); usedAtt.add(c.attacker); detail.marking.push(c); }
    }

    // ---- overload fact: the team on the ball has more players near it, and has held that for >= 1 s.
    const overAtt = holder === 'A' ? overA.length : holder === 'B' ? overB.length : 0;
    const overDef = holder === 'A' ? overB.length : holder === 'B' ? overA.length : 0;
    const overOk = holder !== null && overAtt >= 2 && overAtt > overDef && overAtt + overDef <= 12 && cBall >= 0.35;
    const overHeld = this.hold('overload:' + (holder ?? '-'), overOk, t);
    const overNear = holder === 'A' ? [...overA, ...overB] : [...overB, ...overA];
    facts.overload = {
      valid: overOk && overHeld >= 1,
      confidence: cBall * clamp(0.55 + 0.1 * (overAtt - overDef) + 0.15 * clamp(overHeld / 3, 0, 1), 0, 1),
      sinceS: overHeld, targets: overNear.slice(0, 12), team: holder, attackers: overAtt, defenders: overDef, near: overNear,
    };

    // ---- marking links fact (after the greedy pair pass)
    const linksOk = holder !== null && detail.marking.length >= 2 && this.match.shape[holder].gate !== 'hidden';
    const linksHeld = this.hold('links:' + (holder ?? '-'), linksOk, t);
    facts.links = {
      valid: linksOk && linksHeld >= 0.5,
      confidence: sConf * clamp(detail.marking.length / 5, 0.3, 1),
      sinceS: linksHeld, targets: detail.marking.slice(0, 8).flatMap((p) => [p.attacker, p.defender]),
      team: holder, pairs: detail.marking.slice(0, 8),
    };

    // ---- key player candidates over the last 60 s (involvement, never a hard-coded callout)
    this.trackInvolvement(step, holder, carrier, t, dirOf(holder ?? 'A'));
    facts.keyPlayer = this.keyPlayerFact(t, this.fsm.carrierId);

    // ---- switch arc, counter run, space pocket
    const switchAge = t - this.switchAt;
    const swTarget = this.switchTarget;
    const swOk = switchAge <= 6 && carrier !== null && swTarget !== null && swTarget !== carrier.id && cBall >= 0.35;
    facts.switchArc = {
      valid: swOk, confidence: cBall * 0.8 * clamp(1 - switchAge / 6, 0, 1),
      sinceS: swOk ? switchAge : 0, targets: carrier && swTarget !== null ? [carrier.id, swTarget] : [],
      carrierId: carrier?.id ?? -1, targetId: swTarget, team: holder,
    };
    const counterAge = t - this.counterAt;
    const runId = this.counterRunner;
    const counterOk = counterAge <= 6 && runId !== null && dirConf > 0.3 && cBall >= 0.35;
    facts.counter = {
      valid: counterOk, confidence: cBall * dirConf * clamp(1 - counterAge / 6, 0, 1),
      sinceS: counterOk ? counterAge : 0, targets: runId !== null ? [runId] : [], runnerId: runId, team: holder,
    };
    const cenA = cen(P.A), cenB = cen(P.B);
    const gapM = P.A.length && P.B.length ? distMetres(cenA, cenB, persp) : 0;
    const pocketOk = groups.A.k >= 2 && groups.B.k >= 2 && gapM >= 12 && P.A.length >= 5 && P.B.length >= 5;
    const pocketHeld = this.hold('pocket', pocketOk, t);
    const mid: Pt = [(cenA[0] + cenB[0]) / 2, (cenA[1] + cenB[1]) / 2];
    const nearA2 = nearest(mid, P.A), nearB2 = nearest(mid, P.B);
    facts.pocket = {
      valid: pocketOk && pocketHeld >= 1 && !!nearA2 && !!nearB2,
      confidence: sConf * clamp(gapM / 25, 0, 1), sinceS: pocketHeld,
      targets: nearA2 && nearB2 ? [nearA2.track.id, nearB2.track.id] : [], gapM: Math.round(gapM),
    };

    // ---- remaining events (ball-dependent; none fire while the ball is absent)
    if (ball && holder) {
      const opp: 'A' | 'B' = holder === 'A' ? 'B' : 'A';
      if (pressure >= 3 && this.cooled('high_press', t, 8)) ev('high_press', opp, cBall, { pressers: pressure, carrierId: carrier?.id ?? -1 });
      if (facts.overload.valid && this.cooled('overload', t, 8)) ev('overload', holder, cBall, { near: `${overAtt} v ${overDef}`, attackers: overAtt, defenders: overDef });
    }
    if (this.counter && ball) {
      if (t - this.counter.t0 > 6 || this.fsm.lastHolder !== this.counter.team) this.counter = null;
      else if (aDir !== 'unknown' && attackAxis(this.counter.team) * (ball[0] - this.counter.x0) > 0.25) {
        ev('counter_attack', this.counter.team, cBall * dirConf, { dx: Math.round((ball[0] - this.counter.x0) * 100) / 100 });
        this.counterAt = t;
        this.counterRunner = carrier?.id ?? optTargets[0]?.id ?? null;
        this.counter = null;
      }
    }
    // prediction_hit / prediction_miss are emitted by the prediction resolver, not by this engine.

    detail.gateToggles = [...this.gates.values()].reduce((s, g) => s + g.toggles, 0);
    this.detail = detail;
    this.match = { ...this.match, liveness: 'LIVE', stats: { ...this.stats } };
    return { match: this.match, events, detail };
  }

  /** Seconds a condition has held. The key includes the holder, so a change of carrier or team resets the clock. */
  private hold(key: string, ok: boolean, t: number): number {
    if (!ok) { this.held.delete(key); return 0; }
    const since = this.held.get(key);
    if (since === undefined) { this.held.set(key, t); return 0; }
    return Math.max(0, t - since);
  }

  /** Involvement over the last 60 s: touches, carries into the final third, passes received. */
  private trackInvolvement(step: PossessionStep, holder: 'A' | 'B' | null, carrier: Track | null, t: number, dir: 'left' | 'right' | 'unknown'): void {
    for (const [id, r] of this.kp) if (t - r.lastT > 60) this.kp.delete(id);
    if (carrier && holder) {
      let r = this.kp.get(carrier.id);
      if (!r) {
        r = { team: holder, touches: 0, carries: 0, received: 0, firstT: t, lastT: t, margin: carrier.teamMargin };
        this.kp.set(carrier.id, r);
      }
      // A touch is a new carrier, or the same carrier after a real gap; sub-second FSM chatter is not a touch.
      if (carrier.id !== this.lastCarrier || t - this.lastTouchT > 1.5) {
        r.touches++; this.lastCarrier = carrier.id; this.lastTouchT = t;
      }
      r.lastT = t; r.margin = carrier.teamMargin;
      const third = dir === 'right' ? carrier.foot[0] > 0.667 : dir === 'left' ? carrier.foot[0] < 0.333 : false;
      if (third && !this.inThird.has(carrier.id)) { r.carries++; this.inThird.add(carrier.id); }
      else if (!third) this.inThird.delete(carrier.id);
    }
    if (step.pass) {
      const r = this.kp.get(step.pass.to);
      if (r) { r.received++; r.lastT = t; }
      else this.kp.set(step.pass.to, { team: step.pass.team, touches: 0, carries: 0, received: 1, firstT: t, lastT: t, margin: 0.8 });
    }
  }

  /** Ranked key-player candidates (top 5) with per-candidate confidence. The rule no longer fires a callout. */
  private keyPlayerFact(t: number, carrierId: number | null): KeyPlayerFact {
    const candidates: KeyPlayerCandidate[] = [];
    for (const [id, r] of this.kp) {
      const score = r.touches + 3 * r.carries + 2 * r.received;
      if (score <= 0) continue;
      candidates.push({
        id, team: r.team, score, touches: r.touches, carries: r.carries, received: r.received,
        // A single touch is already a usable, low-stakes tag; the gate only has to be honest, not rare.
        confidence: clamp(0.3 + score / 10, 0, 1) * clamp(r.margin / 0.7, 0, 1),
      });
    }
    // The player on the ball is the key player of the moment. Others stay as ranked alternatives.
    candidates.sort((a, b) =>
      (b.id === carrierId ? 1 : 0) - (a.id === carrierId ? 1 : 0)
      || b.score - a.score || a.id - b.id);
    const top = candidates.slice(0, 5);
    const lead = top[0];
    const sinceS = lead ? t - (this.kp.get(lead.id)?.firstT ?? t) : 0;
    return {
      valid: !!lead && lead.score >= 1 && lead.confidence >= 0.3,
      confidence: lead?.confidence ?? 0, sinceS, carrierId,
      targets: top.slice(0, 3).map((c) => c.id), candidates: top,
    };
  }

  /** Line height index 0 (own goal) .. 1 (opp goal): mean of the three deepest outfielders against the visible span. null if direction unknown. */
  private lineHeightOf(ps: Track[], all: Track[], dir: 'left' | 'right' | 'unknown'): number | null {
    if (dir === 'unknown' || ps.length < 4 || all.length < 8) return null;
    const xs = all.map((p) => p.foot[0]);
    const lo = Math.min(...xs), hi = Math.max(...xs), span = hi - lo;
    if (span < 0.1) return null;
    const mine = ps.map((p) => p.foot[0]).sort((a, b) => (dir === 'right' ? a - b : b - a)).slice(0, 3);
    const deep = mean(mine);
    return clamp(dir === 'right' ? (deep - lo) / span : (hi - deep) / span, 0, 1);
  }
}
