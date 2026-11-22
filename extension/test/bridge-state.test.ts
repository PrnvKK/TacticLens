import type { FrameState } from '@tacticlens/core';
import { describe, expect, it } from 'vitest';
import { buildBridgeState } from '../lib/bridge/state';

// buildBridgeState only reads a handful of FrameState fields; a minimal frame is enough here.
const frame = {
  t: 12.34,
  tMedia: 12.34,
  scene: { kind: 'WIDE' },
  teamsCalibrated: true,
  teamColours: null,
  ball: { state: 'visible', coastingS: 0, visibility: 1, xy: [0.5, 0.5] },
} as unknown as FrameState;

describe('buildBridgeState teamLabels', () => {
  it('puts the jersey-colour labels on the wire state', () => {
    const s = buildBridgeState(frame, null, {
      paused: false, events: [], teamLabels: { A: 'Team Red', B: 'Team Yellow' },
    });
    expect(s.teamLabels).toEqual({ A: 'Team Red', B: 'Team Yellow' });
    // The JSON the client posts carries them too.
    expect(JSON.parse(JSON.stringify(s)).teamLabels).toEqual({ A: 'Team Red', B: 'Team Yellow' });
  });

  it('omits teamLabels when none are supplied and keeps the fallback team names', () => {
    const s = buildBridgeState(frame, null, { paused: false, events: [] });
    expect(s).not.toHaveProperty('teamLabels');
    expect(s.teamNames).toEqual({ A: 'Team A', B: 'Team B' });
  });

  it('prefers the resolved clip colours over the raw measurement', () => {
    const measured = { ...frame, teamColours: { A: '#00ff00', B: '#ff00ff', confidence: 0.9 } } as unknown as FrameState;
    const s = buildBridgeState(measured, null, {
      paused: false, events: [],
      teamLabels: { A: 'Team White', B: 'Team Blue' },
      teamColours: { A: '#f2f2f2', B: '#5aa9dd' },
    });
    expect(s.kitColours).toEqual({ A: '#f2f2f2', B: '#5aa9dd' });
    expect(JSON.parse(JSON.stringify(s)).teamLabels).toEqual({ A: 'Team White', B: 'Team Blue' });
  });

  it('carries the latest side-chat line for the Telegram ping', () => {
    const s = buildBridgeState(frame, null, {
      paused: false, events: [],
      commentary: { text: 'Team Blue are pinning Team Orange back.', t: 12.3 },
    });
    expect(s.commentary).toEqual({ text: 'Team Blue are pinning Team Orange back.', t: 12.3 });
    expect(JSON.parse(JSON.stringify(s)).commentary).toEqual({ text: 'Team Blue are pinning Team Orange back.', t: 12.3 });
    expect(buildBridgeState(frame, null, { paused: false, events: [], commentary: { text: '  ', t: 1 } })).not.toHaveProperty('commentary');
  });
});
