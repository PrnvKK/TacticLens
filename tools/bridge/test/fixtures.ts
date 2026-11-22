import { fileURLToPath } from 'node:url';
import { loadFixture } from '../src/dryrun';
import type { BridgeState, LiveStateRecord } from '../src/protocol';

export const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/synth-balanced.recorded.json', import.meta.url));
export const fixture = loadFixture(FIXTURE_PATH);
export const states: BridgeState[] = fixture.states;

export function liveState(t: number, receivedAt: number, over: Partial<BridgeState> = {}): LiveStateRecord {
  const base = states.find((s) => s.liveness === 'LIVE') ?? states[0]!;
  return {
    ...base,
    t,
    tMedia: t,
    wallMs: receivedAt,
    liveness: 'LIVE',
    scene: 'WIDE',
    paused: false,
    playing: true,
    halfTime: false,
    ball: { ...base.ball, state: 'visible', coastingS: 0 },
    events: [],
    receivedAt,
    ...over,
  };
}
