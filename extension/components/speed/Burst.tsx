// Opening "speed burst" (first ~2.2 s of the demo): flash, radial speed streaks, a screen-shaking
// count from 0 up to the target TPS, then a quick fade into the live overlay.
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fmt } from './hooks';
import { SPEED_CSS } from './speed-css';

export interface BurstProps {
  /** The number to land on: a real measured peak. Required, so nothing decorative can sneak in. */
  target: number;
  /** TTFT of the call that produced the peak, shown separately from tokens/s. */
  ttftMs?: number;
  label?: string;
  durationMs?: number;
  onDone?: () => void;
}

const STREAKS = Array.from({ length: 28 }, (_, i) => ({ r: (i / 28) * 360 + (i % 3) * 4, d: (i % 7) * 0.035 }));

export function SpeedBurst({ target, ttftMs, label = 'KIMI K3.1 PRO - CEREBRAS', durationMs = 2200, onDone }: BurstProps): JSX.Element {
  const [v, setV] = useState(0);
  const [out, setOut] = useState(false);
  useEffect(() => {
    const t0 = performance.now();
    const countMs = durationMs * 0.62;
    let raf = 0;
    const tick = (): void => {
      const t = performance.now() - t0;
      const k = Math.min(1, t / countMs);
      setV(target * (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k)));
      if (t >= durationMs - 350) setOut(true);
      if (t < durationMs) raf = requestAnimationFrame(tick);
      else onDone?.();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return (
    <div class="tls-spc">
      <style>{SPEED_CSS}</style>
      <div class="tls-burst" data-out={out ? '1' : '0'} data-testid="speed-burst">
        {STREAKS.map((s, i) => <div key={i} class="tls-streak" style={`--r:${s.r}deg;animation-delay:${s.d}s`} />)}
        <div style="position:relative;text-align:center">
          <div class="tls-bnum">{fmt(v)}</div>
          <div class="tls-bunit">TOKENS PER SECOND</div>
          <div class="tls-bsub">{label} - MEASURED LIVE</div>
          <div class="tls-bttft">{ttftMs != null && ttftMs > 0 ? `TTFT ${fmt(ttftMs)} ms - decode speed` : 'official TPS formula'}</div>
        </div>
        <div class="tls-flash" />
      </div>
    </div>
  );
}
