import { describe, expect, it } from 'vitest';
import type { FrameState, MatchState, Track } from '../../src/types';
import { packMatch, packStats, packTracking, payloadToString, estimateJsonTokens } from '../../src/llm/packer';
import { annotationSpec } from '../../src/llm/annotate';

function track(id: number, team: 'A' | 'B', x: number, y: number, vx = 0.02): Track {
  return {
    cls: 'player', score: 0.9, box: [x - 0.01, y - 0.06, x + 0.01, y], id, age: 5, hits: 50, timeSinceUpdate: 0,
    tMedia: 0, foot: [x, y], vel: [vx, 0], team, teamMargin: 0.9,
  };
}
function frame(tMedia: number, ids: number[], ball: [number, number] | null): FrameState {
  return {
    t: tMedia, tMedia, playbackRate: 1, globalMotion: [0, 0], quality: 3, frameIdx: Math.round(tMedia * 8),
    scene: { kind: 'WIDE', confidence: 1 },
    tracks: ids.map((id, i) => track(id, i % 2 ? 'B' : 'A', 0.3 + 0.02 * tMedia + i * 0.05, 0.5)),
    ball: { xy: ball, visibility: ball ? 0.9 : 0, coastingS: 0, state: ball ? 'visible' : 'absent' },
    teamsCalibrated: true,
  };
}

describe('packer', () => {
  const hist = [0, 0.2, 0.4, 0.6, 0.8, 1.0].map((t) => frame(t, [7, 12], t === 0.6 ? null : [0.3 + 0.02 * t, 0.5]));

  it('matches the expected columnar payload (snapshot)', () => {
    const p = packTracking(hist, { seconds: 1, hz: 5, includeVelocity: true });
    expect(payloadToString(p)).toBe(
      '{"t":1,"hz":5,"ball":[[30,50],[31,50],null,[32,50],[32,50]],' +
      '"tracks":{"7":{"team":"A","xy":[[30,50],[31,50],[31,50],[32,50],[32,50]],"v":[2,0]},' +
      '"12":{"team":"B","xy":[[35,50],[36,50],[36,50],[37,50],[37,50]],"v":[2,0]}},"carrier":7}',
    );
  });
  it('drops young tracks and uses null for missing slots', () => {
    const h = hist.map((f) => ({ ...f, tracks: f.tracks.map((t) => (t.id === 12 ? { ...t, age: 0.1 } : t)) }));
    expect(Object.keys(packTracking(h, { seconds: 1 })!.tracks)).toEqual(['7']);
    const p = packTracking(hist, { seconds: 2, hz: 5 })!; // history is only 1 s long
    expect(p.ball.length).toBe(10);
    expect(p.ball[0]).toBeNull();
  });
  it('packs stats: shown only, paused as "paused"', () => {
    const s = (value: number | string, gate: 'shown' | 'held' | 'hidden', paused = false) => ({ value, confidence: 1, updatedAt: 0, gate, paused });
    const match = { stats: { possession: s(0.5123, 'shown'), tempo: s(3, 'held'), pressure: s(9, 'shown', true) }, attackDir: { A: 'right', B: 'left', confidence: 1 }, teamNames: { A: 'Home', B: 'Away' }, scout: null } as unknown as MatchState;
    expect(packStats(match)).toEqual({ possession: 0.51, pressure: 'paused' });
    const m = packMatch(hist, match, { seconds: 1, said: ['a', 'b', 'c', 'd'] })!;
    expect(m.said).toEqual(['b', 'c', 'd']);
    expect(m.scout?.A).toBe('Home');
  });
  it('token estimate for a typical Watch payload (22 tracks x 25 points)', () => {
    const ids = Array.from({ length: 22 }, (_, i) => i + 1);
    const big = Array.from({ length: 26 }, (_, i) => frame(i * 0.2, ids, [0.4, 0.5]));
    const watch = payloadToString(packTracking(big, { seconds: 5 }));
    const reflex = payloadToString(packTracking(big, { seconds: 2 }));
    const tw = estimateJsonTokens(watch);
    const tr = estimateJsonTokens(reflex);
    expect(tw).toBeLessThan(2500);
    expect(tr).toBeLessThan(tw);
  });
});

describe('annotationSpec', () => {
  it('emits ellipse + tag + id text per confirmed player, ball marker, >= 14 px font', () => {
    const f = frame(1, [7, 12], [0.5, 0.5]);
    f.tracks.push({ ...track(99, 'A', 0.9, 0.9), age: 0.05 });
    const { width, height, cmds } = annotationSpec(f);
    expect([width, height]).toEqual([768, 432]);
    expect(cmds.filter((c) => c.op === 'ellipse')).toHaveLength(2);
    const texts = cmds.filter((c) => c.op === 'text') as Extract<(typeof cmds)[number], { op: 'text' }>[];
    expect(texts.map((t) => t.text).sort()).toEqual(['12', '7']);
    expect(texts.every((t) => t.fontPx >= 14)).toBe(true);
    expect(cmds.filter((c) => c.op === 'circle')).toHaveLength(1);
  });
});
