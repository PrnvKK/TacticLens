// Offline data sources for ?mock=1 so the speed wall and the race can be recorded with no API.
// Timestamps are ideal (computed from the target rate), so the official TPS maths reproduces the
// target exactly regardless of timer jitter. Seeded: the same seed gives the same film.
import type { SpeedStore, RaceStore } from './store';

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MockWallOptions {
  seed?: number;
  /** Mean gap between call starts, ms. */
  gapMs?: number;
  tpsMin?: number; tpsMax?: number;
  /** One call in `peakEvery` runs at tpsPeak. 0 disables. */
  peakEvery?: number; tpsPeak?: number;
}

interface MockCall { id: string; lane: string; tStart: number; tFirst: number; tps: number; total: number; emitted: number }

/** Several concurrent Reflex/Watch-like calls at Cerebras speed. Returns a stop function. */
export function startMockWall(store: SpeedStore, o: MockWallOptions = {}): () => void {
  const r = rng(o.seed ?? 7);
  const gap = o.gapMs ?? 230;
  const lo = o.tpsMin ?? 1500;
  const hi = o.tpsMax ?? 2500;
  const peakEvery = o.peakEvery ?? 23;
  const peak = o.tpsPeak ?? 3280;
  const calls: MockCall[] = [];
  let n = 0;
  let nextStart = store.now();
  const stopSampler = store.start();
  const timer = setInterval(() => {
    const now = store.now();
    while (now >= nextStart) {
      n++;
      const watch = n % 4 === 0;
      const tps = peakEvery && n % peakEvery === 0 ? peak : lo + r() * (hi - lo);
      const c: MockCall = {
        id: `mock-${n}`, lane: watch ? 'watch' : 'reflex', tStart: nextStart,
        tFirst: nextStart + (watch ? 190 : 110) + r() * 90, tps,
        total: watch ? 140 + Math.floor(r() * 120) : 36 + Math.floor(r() * 50), emitted: 0,
      };
      calls.push(c);
      store.tracker.begin(c.id, c.tStart, c.lane, 'cerebras');
      nextStart += gap * (0.5 + r());
    }
    for (let i = calls.length - 1; i >= 0; i--) {
      const c = calls[i]!;
      if (now < c.tFirst) continue;
      const due = Math.min(c.total, 1 + Math.floor(((now - c.tFirst) / 1000) * c.tps));
      if (due > c.emitted) {
        const tIdeal = c.tFirst + ((due - 1) / c.tps) * 1000;
        store.tracker.delta(c.id, tIdeal, due - c.emitted);
        c.emitted = due;
      }
      if (c.emitted >= c.total) {
        store.tracker.usage(c.id, c.total);
        store.tracker.end(c.id, c.tFirst + ((c.total - 1) / c.tps) * 1000);
        calls.splice(i, 1);
      }
    }
  }, 16);
  return () => { clearInterval(timer); stopSampler(); };
}

export const MOCK_RACE_TEXT =
  'Turnover on the halfway line. Ballack steps onto the loose ball, Lahm is already overlapping and the far-side channel is open. ' +
  'Switch the play left: three players in the box against two, Klose drifting between the centre-backs. Press the keeper on the back-pass, ' +
  'force it wide, then close the lane to the full-back. Expect the cross inside four seconds; the near post is the target.';

export interface MockRaceOptions { tpsA?: number; tpsB?: number; ttftA?: number; ttftB?: number; text?: string; chunkChars?: number }

/** Streams the same text into both lanes at different speeds. Returns a stop function. */
export function startMockRace(race: RaceStore, o: MockRaceOptions = {}): () => void {
  const text = o.text ?? MOCK_RACE_TEXT;
  const size = o.chunkChars ?? 4;
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  const cfg = { a: { tps: o.tpsA ?? 2100, ttft: o.ttftA ?? 180 }, b: { tps: o.tpsB ?? 72, ttft: o.ttftB ?? 900 } };
  const sent = { a: 0, b: 0 };
  const ended = { a: false, b: false };
  const t0 = race.now();
  race.begin(t0);
  const timer = setInterval(() => {
    const now = race.now();
    for (const s of ['a', 'b'] as const) {
      const { tps, ttft } = cfg[s];
      const tFirst = t0 + ttft;
      if (now < tFirst || ended[s]) continue;
      const due = Math.min(chunks.length, 1 + Math.floor(((now - tFirst) / 1000) * tps));
      if (due > sent[s]) {
        const tIdeal = tFirst + ((due - 1) / tps) * 1000;
        race.delta(s, chunks.slice(sent[s], due).join(''), due - sent[s], tIdeal);
        sent[s] = due;
      }
      if (sent[s] >= chunks.length) {
        race.usage(s, chunks.length);
        race.end(s, tFirst + ((chunks.length - 1) / tps) * 1000);
        ended[s] = true;
      }
    }
    if (ended.a && ended.b) clearInterval(timer);
  }, 16);
  return () => clearInterval(timer);
}
