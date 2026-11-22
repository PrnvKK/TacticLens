import { describe, expect, it } from 'vitest';
import type { OverlaySnapshot } from '@tacticlens/core';
import { CALM_CONFIG } from '../lib/render/calm';
import { OverlayEngine } from '../lib/render/engine';
import { MarkerCutPolicy } from '../lib/render/marker-lifecycle';

/** A canvas whose 2D context accepts every call and property; the engine only needs it to run. */
function fakeCanvas(): HTMLCanvasElement {
  const gradient = { addColorStop: (): void => undefined };
  const noop = (): unknown => gradient;
  const ctx = new Proxy({}, {
    get: (_t, p) => (p === 'canvas' ? null : noop),
    set: () => true,
  });
  return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

const clock = (): { currentTime: number; paused: boolean; playbackRate: number; duration: number; play(): void; pause(): void } =>
  ({ currentTime: 5, paused: false, playbackRate: 1, duration: 100, play: () => undefined, pause: () => undefined });

function track(o: { id?: number; age?: number; score?: number } = {}): OverlaySnapshot['tracks'][number] {
  return {
    id: o.id ?? 1, cls: 'player', score: o.score ?? 0.9,
    box: [0.4, 0.4, 0.46, 0.6], age: o.age ?? 1.2, hits: 4, timeSinceUpdate: 0.01, tMedia: 5,
    foot: [0.43, 0.6], vel: [0, 0], team: 'A', teamMargin: 0.8,
  };
}

function snapshot(o: { tMedia?: number; tracks?: OverlaySnapshot['tracks']; cut?: boolean } = {}): OverlaySnapshot {
  const tMedia = o.tMedia ?? 5;
  return {
    tMedia, playbackRate: 1, globalMotion: [0, 0], liveness: 'LIVE', scene: 'WIDE',
    tracks: (o.tracks ?? [track()]).map((tr) => ({ ...tr, tMedia })),
    ball: { xy: [0.43, 0.6], visibility: 1, coastingS: 0, state: 'visible' },
    match: {} as OverlaySnapshot['match'], teamsCalibrated: true, cut: o.cut,
  };
}

function engine(): { e: OverlayEngine; c: ReturnType<typeof clock> } {
  const c = clock();
  const e = new OverlayEngine(fakeCanvas(), c);
  e.setLayout(1280, 720, 1280, 720, 1, 'full', false);
  e.setPlayersAll(true);
  e.setState('LIVE', 0);
  return { e, c };
}

describe('MarkerCutPolicy', () => {
  it('uses the strict rule in normal play and the fast window after a cut', () => {
    const p = new MarkerCutPolicy();
    expect(p.fastSpawn(0)).toBe(false);
    expect(p.minAgeS(0)).toBe(CALM_CONFIG.playerAgeS);
    expect(p.fadeInS(0)).toBe(CALM_CONFIG.markerFadeInS);

    p.noteCut(10, 50, 'detector');
    expect(p.staleFadeS).toBeLessThanOrEqual(0.08);       // <= 1-2 display frames of stale marker
    expect(p.fastSpawn(10.01)).toBe(true);
    expect(p.minAgeS(10.01)).toBe(CALM_CONFIG.fastSpawnAgeS);
    expect(p.minAgeS(10.01)).toBeLessThanOrEqual(0.25);   // 2-3 detections at ~12 Hz
    expect(p.fadeInS(10.01)).toBe(CALM_CONFIG.fastSpawnFadeInS);
    expect(p.birthAgeS(10.01)).toBeLessThanOrEqual(CALM_CONFIG.fastSpawnAgeS);
    expect(p.fadeInS(10.01)).toBeCloseTo(0.12, 5);

    // the marker layer may return on the frame after the cut, not half a second later
    expect(p.layerTarget(10, false)).toBe(0);
    expect(p.layerTarget(10.03, false)).toBe(1);
    expect(p.layerTarget(10.03, true)).toBe(0);           // a fast pan still hides it

    // after the 2 s window the stricter anti-flicker rule is back
    expect(p.fastSpawn(12.01)).toBe(false);
    expect(p.minAgeS(12.01)).toBe(CALM_CONFIG.playerAgeS);
    expect(p.fadeInS(12.01)).toBe(CALM_CONFIG.markerFadeInS);
    expect(p.info).toMatchObject({ count: 1, detector: 1, lastMedia: 50, lastSource: 'detector' });
  });
});

describe('OverlayEngine marker lifecycle', () => {
  it('drops old-shot snapshots after a renderer cut and spawns the new shot fast', () => {
    const { e, c } = engine();
    let now = 0;
    e.setSnapshot(snapshot({ tMedia: 5 }), now);
    for (let i = 0; i < 24; i++) {
      now += 1 / 60;
      c.currentTime = 5 + now;
      e.frame(now);
    }
    expect(e.markerDebug(1)?.markerAlpha).toBeGreaterThan(0.9);

    // The display detector sees the cut first.
    e.cut(1.0, 5.45, 'detector');
    expect(e.anchorCount).toBe(0);
    // A snapshot still describing the old shot must not rebuild anchors.
    e.setSnapshot(snapshot({ tMedia: 5.42, tracks: [track({ age: 1.4 })] }), 1.01);
    expect(e.anchorCount).toBe(0);
    now = 1.02;
    c.currentTime = 5.47;
    e.frame(now);
    expect(e.markerDebug(1)).toBeNull();

    // The brain's cut-aware FrameState releases the hold (empty tracks: the tracker reset).
    e.setSnapshot(snapshot({ tMedia: 5.47, tracks: [], cut: true }), 1.05);
    // Two or three detections into the new shot: age 0.21, confident, so the fast rule admits it.
    e.setSnapshot(snapshot({ tMedia: 5.53, tracks: [track({ age: 0.21 })] }), 1.1);
    now = 1.1;
    for (let i = 0; i < 9; i++) {
      now += 1 / 60;
      c.currentTime = 5.53 + i / 60;
      e.frame(now);
    }
    const m = e.markerDebug(1);
    expect(m?.state).toBe('on');
    expect(m?.markerAlpha).toBeGreaterThan(0.9);          // ~0.25 s after the cut
    expect(e.cutDebug.count).toBe(1);                     // the s.cut ack did not double-count
  });

  it('keeps the strict one-second rule outside the post-cut window', () => {
    const { e, c } = engine();
    let now = 10;
    e.cut(now, 5.1, 'detector');
    // Snapshots during the 220 ms hold are dropped.
    e.setSnapshot(snapshot({ tMedia: 5.15, tracks: [track({ age: 1.2 })] }), now + 0.1);
    expect(e.anchorCount).toBe(0);

    now = 12.2;                                             // > 2 s after the cut: normal window
    c.currentTime = 5.3;
    e.setSnapshot(snapshot({ tMedia: 5.3, tracks: [track({ age: 0.5 })] }), now);
    for (let i = 0; i < 12; i++) {
      now += 1 / 60;
      c.currentTime += 1 / 60;
      e.frame(now);
    }
    // The anchor is on (0.3 s birth), but the marker stays dark: not a full second of track yet.
    expect(e.markerDebug(1)?.state).toBe('on');
    expect(e.markerDebug(1)?.markerAlpha).toBe(0);

    e.setSnapshot(snapshot({ tMedia: 5.5, tracks: [track({ age: 1.1 })] }), now);
    for (let i = 0; i < 18; i++) {
      now += 1 / 60;
      c.currentTime += 1 / 60;
      e.frame(now);
    }
    expect(e.markerDebug(1)?.markerAlpha).toBeGreaterThan(0.9);
  });

  it('fades the player layer out within ~80 ms when the scene changes to CLOSE', () => {
    const { e, c } = engine();
    let now = 0;
    e.setSnapshot(snapshot({ tMedia: 5 }), now);
    for (let i = 0; i < 30; i++) {
      now += 1 / 60;
      c.currentTime = 5 + now;
      e.frame(now);
    }
    expect(e.markerDebug(1)?.alpha).toBeGreaterThan(0.5);

    e.setState('CLOSE_UP', now);
    for (let i = 0; i < 6; i++) {
      now += 1 / 60;
      c.currentTime += 1 / 60;
      e.frame(now);
    }
    // The track is still in the snapshot, but the layer alpha is gone in 100 ms (not a 300 ms coast).
    expect(e.markerDebug(1)?.alpha ?? 0).toBe(0);
  });

  it('shows the cut count and last-cut age in the perf detail', () => {
    const { e, c } = engine();
    e.cut(4, 5, 'detector');
    c.currentTime = 5.4;
    e.frame(4.3);
    expect(e.calmDetail).toContain('cuts 1');
    expect(e.calmDetail).toContain('det 1');
    expect(e.calmDetail).toContain('last cut 0.3s ago');
  });
});
