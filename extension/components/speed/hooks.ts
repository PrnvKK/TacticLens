import { useEffect, useRef, useState } from 'preact/hooks';
import type { SpeedStore, RaceStore, RaceView } from '../../lib/speed/store';
import type { SpeedSnapshot } from '../../lib/speed/tps';

/** Snapshot refreshed every ~50 ms (the stores also emit on events; this just keeps clocks live). */
export function useSpeed(store: SpeedStore, everyMs = 50): SpeedSnapshot {
  const [s, setS] = useState<SpeedSnapshot>(() => store.snapshot());
  useEffect(() => {
    const id = setInterval(() => setS(store.snapshot()), everyMs);
    return () => clearInterval(id);
  }, [store, everyMs]);
  return s;
}

export function useRace(race: RaceStore, everyMs = 33): RaceView {
  const [v, setV] = useState<RaceView>(() => race.view());
  useEffect(() => {
    const id = setInterval(() => setV(race.view()), everyMs);
    return () => clearInterval(id);
  }, [race, everyMs]);
  return v;
}

/** Eases a displayed number toward its target each frame, so digits roll instead of jumping. */
export function useSmooth(target: number, rate = 0.3): number {
  const [v, setV] = useState(target);
  const cur = useRef(target);
  const tgt = useRef(target);
  tgt.current = target;
  useEffect(() => {
    let raf = 0;
    const tick = (): void => {
      const d = tgt.current - cur.current;
      cur.current = Math.abs(d) < 0.5 ? tgt.current : cur.current + d * rate;
      setV(cur.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rate]);
  return v;
}

export const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
