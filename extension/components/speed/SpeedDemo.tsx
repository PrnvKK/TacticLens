// Theatre speed overlay. Views (URL: ?speed=...):
//   (none)   compact wall in the top-right, clear of the scorebug and the subtitle
//   wall     full-size wall for a demo shot
//   race     Cerebras vs GPU, both streams real (?autorace=1 starts it when both presets are ready)
//   burst    intro burst that rolls up to the real session peak, then the compact wall
// ?mock=1 still swaps every data source for the seeded offline stream; ?record=1 hides the controls.
import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { llmKeys, llmRace } from '../../lib/llm/client';
import { getSettings } from '../../lib/llm/storage';
import { startMockRace as startMockRaceStream, startMockWall } from '../../lib/speed/mock';
import { driveRace, raceLabels, racePrep, type RaceHandle, type RacePrep } from '../../lib/speed/race-live';
import { resolveBurstTarget, speedParams, type SpeedView } from '../../lib/speed/params';
import { RaceStore, SpeedStore } from '../../lib/speed/store';
import { SpeedWall } from './SpeedWall';
import { CompactWall } from './CompactWall';
import { Race } from './Race';
import { SpeedBurst } from './Burst';

export { speedParams } from '../../lib/speed/params';

interface BurstTarget { value: number; ttftMs: number }

export function SpeedDemo({ store, hideControls = false, showStats = false }: { store?: SpeedStore; hideControls?: boolean; showStats?: boolean }): JSX.Element {
  const p = useMemo(() => speedParams(typeof location !== 'undefined' ? location.search : ''), []);
  const s = useMemo(() => store ?? new SpeedStore(), [store]);
  const race = useMemo(() => new RaceStore(), []);
  const [view, setView] = useState<SpeedView>(p.view);
  const [prep, setPrep] = useState<RacePrep | null>(null);
  const [racing, setRacing] = useState(false);
  const [raceError, setRaceError] = useState<string | null>(null);
  const [burst, setBurst] = useState<BurstTarget | null>(null);
  const [burstDone, setBurstDone] = useState(p.view !== 'burst');
  const handle = useRef<RaceHandle | null>(null);
  const autoStarted = useRef(false);

  // The 100 ms sampler (sparkline, aggregate peak). The store itself is shared by the Theatre.
  useEffect(() => s.start(), [s]);

  // Offline wall source.
  useEffect(() => {
    if (!p.mock) return undefined;
    return startMockWall(s, { seed: p.seed });
  }, [p.mock, p.seed, s]);

  const mockRace = useCallback((): void => {
    race.reset();
    race.setLabels(['CEREBRAS (MOCK)', 'simulated'], ['GPU BASELINE (MOCK)', 'simulated']);
    startMockRaceStream(race);
  }, [race]);

  // The offline race view has no keys to check: it starts with the view.
  useEffect(() => { if (p.mock && view === 'race') mockRace(); }, [p.mock, view, mockRace]);

  // Real providers: ask the background which presets have keys, then label the race from core's presets.
  useEffect(() => {
    if (p.mock || view !== 'race') return undefined;
    let live = true;
    void Promise.all([getSettings(), llmKeys()]).then(([settings, keys]) => {
      if (!live) return;
      const next = racePrep(keys, settings.kimiModel);
      setPrep(next);
      const labels = raceLabels(next);
      race.setLabels(labels.a, labels.b);
    }).catch((e: unknown) => { if (live) setRaceError(String((e as Error)?.message ?? e)); });
    return () => { live = false; };
  }, [p.mock, view, race]);

  const start = useCallback((): void => {
    if (!prep?.ready || racing) return;
    setRaceError(null);
    setRacing(true);
    race.reset();
    const labels = raceLabels(prep);
    race.setLabels(labels.a, labels.b);
    handle.current?.cancel();
    handle.current = driveRace(race, {
      start: (a, b, request, onEvent) => llmRace(a, b, request, { onEvent }),
    }, prep, {
      onError: (m) => { if (m) setRaceError(m); },
      onSettled: () => setRacing(false),
    });
  }, [prep, race, racing]);

  useEffect(() => () => handle.current?.cancel(), []);

  // ?autorace=1: start once both providers are actually ready. Nothing is ever started with a fake lane.
  useEffect(() => {
    if (p.mock || !p.autorace || view !== 'race' || !prep?.ready || racing || autoStarted.current) return;
    autoStarted.current = true;
    start();
  }, [p.autorace, p.mock, prep, racing, start, view]);

  const openRace = useCallback((): void => {
    setView('race');
    if (p.mock) mockRace();
  }, [p.mock, mockRace]);

  // Burst: only mount it once there is a real peak (or a real value supplied on the URL).
  useEffect(() => {
    if (p.view !== 'burst' || burst != null) return undefined;
    const read = (): BurstTarget | null => {
      const snap = s.snapshot();
      const value = resolveBurstTarget(p.peak, snap.peakTps);
      return value == null ? null : { value, ttftMs: snap.peakTtftMs };
    };
    const first = read();
    if (first) { setBurst(first); return undefined; }
    const id = setInterval(() => {
      const next = read();
      if (next) { setBurst(next); clearInterval(id); }
    }, 120);
    return () => clearInterval(id);
  }, [p.view, p.peak, burst, s]);

  if (view === 'race') {
    const mockPrep: RacePrep = {
      a: { preset: 'mock', label: 'CEREBRAS (MOCK)', sub: 'simulated', configured: true, reason: null },
      b: { preset: 'mock', label: 'GPU BASELINE (MOCK)', sub: 'simulated', configured: true, reason: null },
      ready: true, note: null,
    };
    return (
      <Race
        race={race} prep={p.mock ? mockPrep : prep} racing={p.mock ? false : racing} error={raceError}
        hideControls={p.record} onStart={p.mock ? mockRace : start}
      />
    );
  }
  if (view === 'wall') return <SpeedWall store={s} onRace={openRace} hideControls={p.record} />;
  return (
    <>
      <CompactWall store={s} onRace={openRace} hideControls={p.record || hideControls} showStats={showStats} />
      {view === 'burst' && !burstDone && burst && (
        <SpeedBurst target={burst.value} ttftMs={burst.ttftMs} onDone={() => setBurstDone(true)} />
      )}
    </>
  );
}
