import { describe, expect, it } from 'vitest';
import { TeamAssigner, kmeans2 } from '../../src/teams/assigner';
import { isGrass, rgbToLab, sampleTorso, type Lab } from '../../src/teams/lab';
import type { Track } from '../../src/types';

function track(id: number, cls: Track['cls'] = 'player'): Track {
  return { id, cls, score: 0.9, box: [0, 0, 0.02, 0.08], age: 5, hits: 20, timeSinceUpdate: 0, tMedia: 0, foot: [0, 0], vel: [0, 0], team: 'OTHER', teamMargin: 0 };
}
const jitter = (i: number) => (((i * 7919) % 11) - 5) / 5;   // deterministic noise in [-1, 1]

describe('lab / grass / torso', () => {
  it('classifies grass and kit colours', () => {
    expect(isGrass(60, 140, 50)).toBe(true);
    expect(isGrass(200, 30, 30)).toBe(false);
    expect(isGrass(240, 240, 240)).toBe(false);
    expect(isGrass(20, 20, 20)).toBe(false);
    expect(rgbToLab(255, 255, 255)[0]).toBeCloseTo(100, 0);
  });
  it('samples the torso and masks grass', () => {
    const W = 40, H = 80, px = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) { px[i * 4] = 60; px[i * 4 + 1] = 140; px[i * 4 + 2] = 50; px[i * 4 + 3] = 255; }
    for (let y = 10; y < 40; y++) for (let x = 10; x < 30; x++) { const i = (y * W + x) * 4; px[i] = 200; px[i + 1] = 20; px[i + 2] = 20; }
    const s = sampleTorso(px, W, H, [8, 8, 32, 72])!;
    expect(s.lab[1]).toBeGreaterThan(40);                // red
    expect(sampleTorso(px, W, H, [0, 50, 40, 80])).toBeNull();   // pure grass box
  });
  it('keeps the kit colour when a white line crosses the torso', () => {
    const W = 40, H = 80, px = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) { px[i * 4] = 60; px[i * 4 + 1] = 140; px[i * 4 + 2] = 50; px[i * 4 + 3] = 255; }
    // Sky-blue City torso, with a bright white touchline through it (a minority of the pixels).
    for (let y = 10; y < 44; y++) for (let x = 10; x < 30; x++) { const i = (y * W + x) * 4; px[i] = 108; px[i + 1] = 171; px[i + 2] = 221; }
    for (let y = 26; y < 29; y++) for (let x = 8; x < 32; x++) { const i = (y * W + x) * 4; px[i] = 246; px[i + 1] = 246; px[i + 2] = 246; }
    const s = sampleTorso(px, W, H, [8, 8, 32, 72])!;
    expect(s.lab[2]).toBeLessThan(-15);                  // stays blue, not washed to white
    expect(Math.abs(s.lab[1]) + Math.abs(s.lab[2])).toBeGreaterThan(15);
  });
});

describe('TeamAssigner', () => {
  const red = rgbToLab(200, 30, 30), blue = rgbToLab(30, 50, 190), gk = rgbToLab(230, 220, 40), ref = rgbToLab(10, 10, 10);
  const mk = (base: Lab, i: number): Lab => [base[0] + jitter(i) * 3, base[1] + jitter(i + 3) * 3, base[2] + jitter(i + 5) * 3];

  function run(nFrames = 40) {
    const ta = new TeamAssigner();
    const tracks: Track[] = [];
    for (let i = 1; i <= 8; i++) tracks.push(track(i));
    tracks.push(track(9, 'referee'), track(10, 'player'));   // 10 = goalkeeper in yellow
    let out: Track[] = [];
    for (let f = 0; f < nFrames; f++) {
      const t = f * 0.125;
      for (const tr of tracks) {
        const base = tr.id === 9 ? ref : tr.id === 10 ? gk : tr.id <= 4 ? red : blue;
        ta.observe(tr.id, mk(base, tr.id * 100 + f), t);
      }
      out = ta.assign(tracks, t, true);
    }
    return { ta, out, tracks };
  }

  it('splits two kits, leaves referee and goalkeeper as OTHER', () => {
    const { ta, out } = run();
    expect(ta.calibrated).toBe(true);
    const team = (id: number) => out.find((o) => o.id === id)!;
    const a = team(1).team;
    expect(a).not.toBe('OTHER');
    for (const id of [2, 3, 4]) expect(team(id).team).toBe(a);
    const b = team(5).team;
    expect(b).not.toBe('OTHER');
    expect(b).not.toBe(a);
    for (const id of [6, 7, 8]) expect(team(id).team).toBe(b);
    expect(team(9).team).toBe('OTHER');
    expect(team(10).team).toBe('OTHER');
    expect(team(10).cls).toBe('goalkeeper');
    expect(team(1).teamMargin).toBeGreaterThan(0.5);
  });

  it('does not calibrate outside WIDE scenes, and keeps centres once frozen', () => {
    const ta = new TeamAssigner();
    const tracks = Array.from({ length: 8 }, (_, i) => track(i + 1));
    for (let f = 0; f < 40; f++) {
      tracks.forEach((tr) => ta.observe(tr.id, mk(tr.id <= 4 ? red : blue, tr.id * 50 + f), f * 0.125));
      ta.assign(tracks, f * 0.125, false);
    }
    expect(ta.calibrated).toBe(false);
    for (let f = 40; f < 80; f++) {
      tracks.forEach((tr) => ta.observe(tr.id, mk(tr.id <= 4 ? red : blue, tr.id * 50 + f), f * 0.125));
      ta.assign(tracks, f * 0.125, true);
    }
    expect(ta.calibrated).toBe(true);
    const c = ta.centres;
    ta.assign([], 100, false);
    expect(ta.centres).toBe(c);
  });

  it('supports swap', () => {
    const { ta, out } = run();
    const before = out.find((o) => o.id === 1)!.team;
    ta.swap();
    const after = ta.assign(out, 6, true).find((o) => o.id === 1)!.team;
    expect(after).not.toBe(before);
  });

  it('exposes a robust median kit colour per team in sRGB hex', () => {
    const { ta, out } = run();
    expect(ta.kitColours).not.toBeNull();
    const c = ta.kitColours!;
    expect(c.A).toMatch(/^#[0-9a-f]{6}$/);
    expect(c.B).toMatch(/^#[0-9a-f]{6}$/);
    expect(c.confidence).toBeGreaterThan(0.3);
    // A is the lighter red cluster; B is blue. Median torso colours preserve that ordering.
    const rgb = (hex: string): [number, number, number] => [
      parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
    ];
    const a = rgb(c.A), b = rgb(c.B);
    expect(a[0]).toBeGreaterThan(a[1] + 40);
    expect(a[0]).toBeGreaterThan(a[2] + 40);
    expect(b[2]).toBeGreaterThan(b[0] + 40);
    ta.assign(out, 6, true);
    ta.swap();
    const after = ta.kitColours!;
    expect(after.A).toBe(c.B);
    expect(after.B).toBe(c.A);
  });

  it('kmeans2 separates two blobs', () => {
    const a = Array.from({ length: 6 }, (_, i) => [50 + i, 10, 10] as Lab);
    const b = Array.from({ length: 6 }, (_, i) => [50 + i, -10, -40] as Lab);
    const r = kmeans2([...a, ...b])!;
    expect(new Set(r.assign.slice(0, 6)).size).toBe(1);
    expect(r.assign[0]).not.toBe(r.assign[6]);
  });

  it('separates a white kit from a pale sky-blue kit (EA FC)', () => {
    const white = rgbToLab(242, 242, 242), sky = rgbToLab(108, 171, 221);
    const ta = new TeamAssigner();
    const tracks: Track[] = Array.from({ length: 8 }, (_, i) => track(i + 1));
    let out: Track[] = [];
    for (let f = 0; f < 40; f++) {
      const t = f * 0.125;
      for (const tr of tracks) ta.observe(tr.id, mk(tr.id <= 4 ? white : sky, tr.id * 50 + f), t, true);
      out = ta.assign(tracks, t, true);
    }
    expect(ta.calibrated).toBe(true);
    const team = (id: number) => out.find((o) => o.id === id)!;
    expect(team(1).team).not.toBe('OTHER');
    expect(team(5).team).not.toBe('OTHER');
    expect(team(1).team).not.toBe(team(5).team);
    const c = ta.kitColours!;
    const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const a = rgb(c.A), b = rgb(c.B);
    expect(Math.max(...a) - Math.min(...a)).toBeLessThan(20);   // white is neutral
    expect(b[2]! - b[0]!).toBeGreaterThan(60);                  // the other is clearly blue
    expect(c.confidence).toBeGreaterThan(0.3);
  });

  it('calibrates from players seen across camera cuts', () => {
    const white = rgbToLab(242, 242, 242), sky = rgbToLab(108, 171, 221);
    const ta = new TeamAssigner();
    let nextId = 1;
    let t = 0;
    // Each shot shows only five players, then the director cuts and the tracker gets new ids.
    for (let shot = 0; shot < 3; shot++) {
      const tracks: Track[] = Array.from({ length: 5 }, () => track(nextId++));
      for (let f = 0; f < 20; f++) {
        for (const [i, tr] of tracks.entries()) ta.observe(tr.id, mk(i % 2 ? sky : white, tr.id * 20 + f), t, true);
        ta.assign(tracks, t, true);
        t += 0.125;
      }
    }
    expect(ta.calibrated).toBe(true);
    expect(ta.kitColours).not.toBeNull();
    const c = ta.kitColours!;
    expect(c.confidence).toBeGreaterThan(0.2);
    expect(c.A).not.toBe(c.B);
  });

  it('ignores close-up observations instead of turning both kits white', () => {
    const red = rgbToLab(200, 30, 30), blue = rgbToLab(30, 50, 190);
    const ta = new TeamAssigner();
    const tracks: Track[] = Array.from({ length: 8 }, (_, i) => track(i + 1));
    for (let f = 0; f < 40; f++) {
      for (const tr of tracks) ta.observe(tr.id, mk(tr.id <= 4 ? red : blue, tr.id * 50 + f), f * 0.125, true);
      ta.assign(tracks, f * 0.125, true);
    }
    const before = { ...ta.kitColours! };
    // A close-up / white wall / crowd: gated observations must not reach the per-track EMA.
    const white = rgbToLab(246, 246, 246);
    for (let f = 40; f < 80; f++) {
      for (const tr of tracks) ta.observe(tr.id, mk(white, f), f * 0.125, false);
      const out = ta.assign(tracks, f * 0.125, false);
      for (const tr of out) expect(tr.team).not.toBe('OTHER');
    }
    expect(ta.kitColours!.A).toBe(before.A);
    expect(ta.kitColours!.B).toBe(before.B);
  });
});
