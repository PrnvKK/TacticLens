// Offline fixture recorder: replays a synthetic session through the real engine and stores the compact
// bridge states the extension would have posted. Run:
//   node --no-warnings --experimental-transform-types --import ./tools/replay/register.mjs tools/bridge/scripts/record-fixture.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Engine } from '../../../core/src/engine/index';
import { parseSession } from '../../../core/src/replay/reader';
import { toFrameStates } from '../../../core/src/replay/run';
import type { StatKey, StatValue } from '../../../core/src/types';
import { factsFromEngine } from '../src/factmap';
import type { BridgeState, EventLite, StatLite } from '../src/protocol';

const STAT_KEYS: StatKey[] = [
  'possession', 'passes', 'turnovers', 'tempo', 'momentum', 'lineHeight', 'fieldTilt',
  'pressure', 'switches', 'sprints', 'freePlayers', 'compactness',
];

const src = process.argv[2] ?? 'fixtures/synth-balanced.jsonl';
const out = process.argv[3] ?? 'tools/bridge/fixtures/synth-balanced.recorded.json';
const session = parseSession(readFileSync(resolve(src), 'utf8'));
const { frames } = toFrameStates(session);
const engine = new Engine();
const states: BridgeState[] = [];
let pending: EventLite[] = [];
let emitted = -1;

const clockOf = (t: number): string => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

for (let i = 0; i < frames.length; i++) {
  const f = frames[i]!;
  const r = engine.update(f);
  for (const e of r.events) {
    pending.push({
      type: e.type, t: Math.round(e.t * 10) / 10, team: e.team,
      confidence: Math.round(e.confidence * 100) / 100,
      detail: Object.fromEntries(Object.entries(e.detail).filter(([, v]) => typeof v === 'number' || typeof v === 'string')),
    });
  }
  if (i - emitted < 10 && i !== frames.length - 1) continue;
  emitted = i;
  const stats: Partial<Record<StatKey, StatLite>> = {};
  for (const k of STAT_KEYS) {
    const st = r.match.stats[k];
    if (!st) continue;
    stats[k] = { value: st.value as StatValue, gate: st.gate, confidence: Math.round(st.confidence * 100) / 100, paused: st.paused };
  }
  states.push({
    t: Math.round(f.t * 10) / 10,
    tMedia: Math.round(f.tMedia * 10) / 10,
    wallMs: i * 200,
    clock: r.match.scout?.clock ?? clockOf(f.t),
    liveness: r.match.liveness,
    scene: f.scene.kind,
    paused: false,
    playing: true,
    halfTime: false,
    ball: { state: f.ball.state, coastingS: f.ball.coastingS, visibility: f.ball.visibility, xy: f.ball.xy },
    possession: r.match.possession.value,
    stats,
    facts: factsFromEngine(r.detail.facts),
    teamNames: { A: 'Arsenal', B: 'Chelsea' },
    kitColours: { A: '#e30613', B: '#034694' },
    score: null,
    events: pending,
    director: { onScreen: null, lastGraphicS: null },
  });
  pending = [];
}

const fixture = {
  name: 'synth-balanced.recorded',
  note: 'Recorded from fixtures/synth-balanced.jsonl through core Engine; compact states every ~2 s.',
  states,
};
mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(resolve(out), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
console.log(`wrote ${states.length} states to ${out}`);
