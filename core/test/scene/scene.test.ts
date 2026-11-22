import { describe, expect, it } from 'vitest';
import { GRID_H, GRID_W, SceneAnalyzer } from '../../src/scene/analyzer';

type RGB = [number, number, number];
function frame(fill: (x: number, y: number) => RGB): Uint8ClampedArray {
  const a = new Uint8ClampedArray(GRID_W * GRID_H * 4);
  for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
    const c = fill(x, y); const i = (y * GRID_W + x) * 4;
    a[i] = c[0]; a[i + 1] = c[1]; a[i + 2] = c[2]; a[i + 3] = 255;
  }
  return a;
}
let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const pitch = (shift = 0) => frame((x, y) => (y < 4 ? [30, 30, 30] : [50 + ((x + shift) % 7) * 2, 130 + rnd() * 6, 45]));
const crowd = () => frame(() => [90 + rnd() * 100, 60 + rnd() * 80, 50 + rnd() * 90]);
const heights = (n: number, h: number) => Array.from({ length: n }, () => h);

describe('SceneAnalyzer', () => {
  it('classifies WIDE, CLOSE and CROWD', () => {
    const s = new SceneAnalyzer();
    let r = s.update(0, pitch(), heights(10, 0.09));
    for (let k = 1; k < 6; k++) r = s.update(k * 0.125, pitch(k), heights(10, 0.09));
    expect(r.kind).toBe('WIDE');
    expect(r.greenRatio).toBeGreaterThan(0.5);
    for (let k = 6; k < 14; k++) r = s.update(k * 0.125, pitch(k), heights(2, 0.4));
    expect(r.kind).toBe('CLOSE');
    for (let k = 14; k < 22; k++) r = s.update(k * 0.125, crowd(), []);
    expect(r.kind).toBe('CROWD');
  });

  it('detects a hard cut, but not a slow pan', () => {
    const s = new SceneAnalyzer();
    let cuts = 0;
    for (let k = 0; k < 20; k++) if (s.update(k * 0.125, pitch(k), heights(10, 0.09)).cut) cuts++;
    expect(cuts).toBe(0);
    const r = s.update(20 * 0.125, crowd(), []);
    expect(r.cut).toBe(true);
    expect(r.kind).toBe('CROWD');           // commits immediately on a cut
  });

  it('latches REPLAY on a wipe only after the confirmation window, and the next wipe ends it', () => {
    const s = new SceneAnalyzer();
    let t = 0;
    for (; t < 2; t += 0.125) s.update(t, pitch(), heights(10, 0.09));
    s.update(t, crowd(), []); t += 0.125;                              // cut 1
    const r = s.update(t, pitch(), heights(10, 0.09)); t += 0.125;     // cut 2 = wipe
    expect(r.wipe).toBe(true);
    expect(s.isReplay).toBe(false);                                    // proposed, not latched yet
    // replay close-up: no live-wide evidence inside the window -> latch (then the 0.3 s kind commit)
    let k = 0;
    for (; k < 10; k++, t += 0.125) s.update(t, pitch(t), heights(2, 0.4));
    expect(s.isReplay).toBe(true);
    expect(s.update(t, pitch(t), heights(2, 0.4)).kind).toBe('REPLAY');
    // wide live play returns: releases after replayExitS of accumulated evidence
    for (t += 0.125; t < 2 + 4; t += 0.125) s.update(t, pitch(t), heights(10, 0.09));
    expect(s.isReplay).toBe(false);
    // the next wipe while latched (replay-out) exits immediately
    s.update(t, crowd(), []); t += 0.125;
    const out = s.update(t, pitch(t), heights(10, 0.09)); t += 0.125;
    expect(out.wipe).toBe(true);
    expect(s.isReplay).toBe(false);
  });

  it('a cut pair into live wide play never latches REPLAY (false-REPLAY case)', () => {
    const s = new SceneAnalyzer();
    let t = 0;
    for (; t < 2; t += 0.125) s.update(t, pitch(), heights(10, 0.09));
    s.update(t, crowd(), []); t += 0.125;                              // live cut 1: wide -> crowd
    let sawReplay = false;
    let wipes = 0;
    for (let k = 0; k < 6; k++, t += 0.125) {
      const r = s.update(t, pitch(k), heights(10, 0.09));              // cut 2 after 0.75 s: back to wide
      if (r.wipe) wipes++;
      if (r.kind === 'REPLAY') sawReplay = true;
    }
    for (let k = 0; k < 16; k++, t += 0.125) {
      const r = s.update(t, pitch(t), heights(10, 0.09));              // live play continues
      if (r.kind === 'REPLAY') sawReplay = true;
    }
    expect(wipes).toBe(1);                                             // the wipe pair was seen
    expect(sawReplay).toBe(false);                                     // but was not trusted
    expect(s.isReplay).toBe(false);
  });

  it('releases the replay latch when wide live play resumes, and caps at replayMaxS', () => {
    const s = new SceneAnalyzer({ replayMaxS: 15 });
    let t = 0;
    for (; t < 2; t += 0.125) s.update(t, pitch(), heights(10, 0.09));
    s.update(t, crowd(), []); t += 0.125;                              // cut 1
    expect(s.update(t, pitch(), heights(10, 0.09)).wipe).toBe(true); t += 0.125;   // cut 2
    // replay close-up: confirms the latch after replayConfirmS
    let r = s.update(t, pitch(t), heights(2, 0.4));
    for (t += 0.125; t < 8; t += 0.125) r = s.update(t, pitch(t), heights(2, 0.4));
    expect(r.kind).toBe('REPLAY');
    // wide live play returns: latch releases after replayExitS (0.6 s), not 45 s
    let exited = -1;
    const t0 = t;
    for (; t < t0 + 4; t += 0.125) {
      r = s.update(t, pitch(t), heights(10, 0.09));
      if (exited < 0 && r.kind === 'WIDE') exited = t - t0;
    }
    expect(exited).toBeGreaterThanOrEqual(0.5);
    expect(exited).toBeLessThanOrEqual(1.0);
    // hard cap: enter replay and feed only replay-like frames that never look like live wide play
    let u = t + 0.125;
    s.update(u, crowd(), []); u += 0.125;
    expect(s.update(u, pitch(u), heights(10, 0.09)).kind).toBe('WIDE');   // cut pair alone: no latch
    u += 0.125;
    const inAt = u;                                                    // confirmation starts here
    let capped = -1;
    let latchedAt = -1;
    for (; u < t + 25; u += 0.125) {
      r = s.update(u, pitch(u), heights(2, 0.4));
      if (latchedAt < 0 && r.kind === 'REPLAY') latchedAt = u - inAt;
      if (latchedAt >= 0 && capped < 0 && r.kind !== 'REPLAY') capped = u - inAt;
    }
    expect(latchedAt).toBeGreaterThanOrEqual(0.5);
    expect(latchedAt).toBeLessThanOrEqual(0.875);
    expect(capped).toBeGreaterThanOrEqual(15);   // the latch holds right up to replayMaxS
    expect(capped).toBeLessThanOrEqual(17);
    expect(s.isReplay).toBe(false);
    expect(s.update(u, pitch(u), heights(2, 0.4)).kind).not.toBe('REPLAY');
  });

  it('reset() clears the replay latch and cut-pairing memory', () => {
    const s = new SceneAnalyzer();
    let t = 0;
    for (; t < 2; t += 0.125) s.update(t, pitch(), heights(10, 0.09));
    s.update(t, crowd(), []); t += 0.125;                            // cut 1
    expect(s.isReplay).toBe(false);
    s.update(t, pitch(), heights(10, 0.09)); t += 0.125;             // cut 2
    for (let k = 0; k < 6; k++, t += 0.125) s.update(t, pitch(t), heights(2, 0.4));
    expect(s.isReplay).toBe(true);
    s.update(t, crowd(), []); t += 0.125;                            // lone cut inside the replay
    s.reset();
    expect(s.isReplay).toBe(false);
    t = 0;                                                           // fresh session
    for (; t < 2; t += 0.125) s.update(t, pitch(t), heights(10, 0.09));
    const r = s.update(2, crowd(), []);                               // lone cut: no stale pair -> no wipe
    expect(r.cut).toBe(true);
    expect(r.wipe).toBe(false);
    expect(r.kind).toBe('CROWD');
  });

  it('classifies a still, non-green frame without players as GRAPHIC and finds the static scorebug cells', () => {
    const s = new SceneAnalyzer();
    const bug = (x: number, y: number): RGB => (y < 5 && x < 20 ? [240, 240, 240] : [50, 130 + rnd() * 6, 45]);
    let t = 0;
    for (; t < 8; t += 0.125) s.update(t, frame(bug), heights(10, 0.09));
    const m = s.staticMask();
    expect(m[1 * GRID_W + 5]).toBe(1);
    expect(m[18 * GRID_W + 30]).toBe(0);
    const flat = frame(() => [20, 20, 120]);
    let r = s.update(t, flat, []);
    for (t += 0.125; t < 11; t += 0.125) r = s.update(t, flat, []);
    expect(r.kind).toBe('GRAPHIC');
  });
});
