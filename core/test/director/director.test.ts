import { describe, expect, it } from 'vitest';
import type { FrameState, MatchState, Track } from '../../src/types';
import type { EngineOutput } from '../../src/engine';
import { Engine, emptyFacts } from '../../src/engine';
import {
  DIRECTOR_SYSTEM_PROMPT, Director, buildMenu, streamChat, resolveProvider, type DirectorCaller, type DirectorContext,
} from '../../src/index';

function facts() {
  const f = emptyFacts();
  f.overload = {
    ...f.overload, valid: true, confidence: 0.82, sinceS: 4, team: 'A', attackers: 3, defenders: 2,
    near: [1, 2, 3, 11, 12], targets: [1, 2, 3, 11, 12],
  };
  f.keyPlayer = {
    ...f.keyPlayer, valid: true, confidence: 0.7, sinceS: 30, carrierId: 1, targets: [1],
    candidates: [{ id: 1, team: 'A', score: 6, confidence: 0.7, touches: 2, carries: 1, received: 1 }],
  };
  return f;
}

const match = {
  possession: { value: { A: 57, B: 43, current: 'A' } },
  scout: null,
  liveness: 'LIVE',
} as unknown as MatchState;

const output = (): EngineOutput => ({ match, events: [], detail: { facts: facts() } } as unknown as EngineOutput);

const ctx = (nowS: number, onScreen: DirectorContext['onScreen'] = null): DirectorContext => ({
  nowS, t: 100, playbackRate: 1, liveness: 'LIVE', scene: 'WIDE', ballState: 'visible', ballXY: [0.31, 0.6],
  match, out: output(), events: [], liveIds: [1, 2, 3, 11, 12],
  onScreen, sinceLastGraphicS: onScreen ? 4 : 12, calm: { ready: true, reason: 'calm ready' },
});

/** The real streaming client, the real mock SSE provider, the real schema parser. */
const mockCaller = (): { call: DirectorCaller; requests: unknown[] } => {
  const requests: unknown[] = [];
  const profile = { ttftMs: 1, tokPerS: 20000 };
  const call: DirectorCaller = async (req, onEvent) => {
    requests.push(req);
    const r = await streamChat({ provider: resolveProvider('mock', ''), request: req, mockProfile: profile, onEvent });
    return { status: r.ok ? 'ok' : 'error', parsed: r.parsed, timing: r.timing, error: r.error };
  };
  return { call, requests };
};

describe('director lane end to end (mock provider)', () => {
  it('builds the cached prompt + compact payload, shows a valid menu graphic and logs its latency', async () => {
    const { call, requests } = mockCaller();
    let wall = 100;
    const d = new Director(call, { now: () => wall, intervalS: 2 });
    const out = await d.tick(ctx(100));
    expect(out).not.toBeNull();
    expect(out!.accepted).toBe(true);
    expect(out!.decision!.action).toBe('show');
    expect(out!.decision!.graphic).toBe('overload');
    expect(out!.decision!.targets.every((id) => [1, 2, 3, 11, 12].includes(id))).toBe(true);
    expect(out!.log.accepted).toBe(true);
    expect(out!.log.ttftMs).toBeGreaterThanOrEqual(0);
    expect(out!.log.totalMs).toBeGreaterThan(0);
    expect(d.log).toHaveLength(1);
    expect(d.shown.get('overload')).toBe(100);
    // The payload carries only valid menu items and the static prefix is separate for caching.
    const req = requests[0] as { messages: { role: string; content: string }[]; schema: { name: string }; maxCompletionTokens: number };
    expect(req.messages[0]!.role).toBe('system');
    expect(req.messages[0]!.content).toBe(DIRECTOR_SYSTEM_PROMPT);
    expect(req.schema.name).toBe('director_decision');
    expect(req.maxCompletionTokens).toBe(400);
    const payload = JSON.parse(req.messages[1]!.content);
    expect(payload.menu.map((m: { id: string }) => m.id)).toEqual(['overload', 'spotlight', 'key_player']);
    expect(payload.possession.A).toBe(57);
  });

  it('keeps an on-screen graphic when the mock returns keep, and refuses to overlap', async () => {
    const { call } = mockCaller();
    let wall = 100;
    const d = new Director(call, { now: () => wall, intervalS: 2 });
    const first = await d.tick(ctx(100));
    expect(first!.decision!.action).toBe('show');
    wall = 102;
    const second = await d.tick(ctx(102, { id: 'overload', sinceS: 2 }));
    expect(second!.accepted).toBe(true);
    expect(second!.decision!.action).toBe('keep');
    expect(second!.decision!.graphic).toBe('overload');
    expect(d.log).toHaveLength(2);
  });

  it('honours the 2 s cadence and the min gap for event triggers', async () => {
    const { call } = mockCaller();
    let wall = 100;
    const d = new Director(call, { now: () => wall, intervalS: 2, minGapS: 0.8 });
    expect(d.due(ctx(100), false)).toBe(true);
    await d.tick(ctx(100));
    expect(d.due(ctx(101), false)).toBe(false);
    expect(d.due(ctx(100.9), true)).toBe(true);       // event trigger after the min gap
    expect(d.due(ctx(100.5), true)).toBe(false);      // burst guard
    expect(d.due(ctx(102), false)).toBe(true);
  });

  it('runs on a real engine output: the menu comes from measured facts, then the mock picks a valid show', async () => {
    const frameAt = (t: number, tracks: Track[], ball: [number, number]): FrameState => ({
      t, tMedia: t, playbackRate: 1, globalMotion: [0, 0], quality: 3, frameIdx: Math.round(t * 10),
      scene: { kind: 'WIDE', confidence: 1 }, tracks,
      ball: { xy: ball, visibility: 1, coastingS: 0, state: 'visible' }, teamsCalibrated: true,
    });
    const mk = (id: number, team: 'A' | 'B', x: number, y: number): Track => {
      const h = 0.02 + 0.2 * y;
      return {
        id, cls: 'player', score: 0.92, box: [x - 0.012, y - h, x + 0.012, y], age: 8, hits: 30, timeSinceUpdate: 0,
        tMedia: 0, foot: [x, y], vel: [0, 0], team, teamMargin: 0.9,
      };
    };
    const tracks: Track[] = [
      mk(1, 'A', 0.30, 0.60), mk(2, 'A', 0.33, 0.62), mk(3, 'A', 0.275, 0.575), mk(4, 'A', 0.35, 0.57),
      mk(31, 'A', 0.06, 0.22), mk(32, 'A', 0.17, 0.22), mk(33, 'A', 0.82, 0.22), mk(34, 'A', 0.93, 0.22),
      mk(11, 'B', 0.316, 0.586), mk(12, 'B', 0.36, 0.62),
      mk(41, 'B', 0.86, 0.22), mk(42, 'B', 0.75, 0.25), mk(43, 'B', 0.08, 0.28), mk(44, 'B', 0.65, 0.24),
    ];
    const ball: [number, number] = [0.30, 0.60];
    const e = new Engine();
    let out = e.update(frameAt(0, tracks, ball));
    for (let t = 0.1; t <= 3.2; t += 0.1) out = e.update(frameAt(t, tracks, ball));
    const f = frameAt(3.2, tracks, ball);
    const live = new Set(tracks.map((t) => t.id));
    const menu = buildMenu(out, f.t, live);
    expect(menu.items[0]!.id).toBe('overload');
    const liveIds = [...live];
    const c: DirectorContext = {
      nowS: 100, t: f.t, playbackRate: 1, liveness: 'LIVE', scene: 'WIDE', ballState: 'visible', ballXY: ball,
      match: out.match, out, events: [], liveIds, onScreen: null, sinceLastGraphicS: 12,
      calm: { ready: true, reason: 'calm ready' },
    };
    const { call } = mockCaller();
    const d = new Director(call, { now: () => 100, intervalS: 2 });
    const res = await d.tick(c);
    expect(res!.accepted).toBe(true);
    expect(res!.decision!.action).toBe('show');
    expect(res!.decision!.graphic).toBe('overload');
    expect(res!.payload.menu.some((m) => m.id === 'overload')).toBe(true);
  });
});
