// Default Theatre view: the live tokens/sec card in the top-right corner. Built to be read in one glance:
// a huge number, the unit spelled out ("tokens per second"), and three plainly labelled facts underneath.
// It sits clear of the top-left LIVE pill, the top-centre stat cards and the left side chat, and says on its
// face that the numbers are measured. Everything scales with the stage width.
import type { JSX } from 'preact';
import type { SpeedStore } from '../../lib/speed/store';
import { fmt, useSmooth, useSpeed } from './hooks';
import { Spark } from './SpeedWall';
import { SPEED_CSS } from './speed-css';

export interface CompactWallProps {
  store: SpeedStore;
  label?: string;
  onRace?: () => void;
  hideControls?: boolean;
  /** First-token / decisions / session-peak figures and the "Measured live" foot: perf mode only (the Theatre Perf toggle). */
  showStats?: boolean;
}

export function CompactWall({ store, label = 'Kimi on Cerebras', onRace, hideControls, showStats = false }: CompactWallProps): JSX.Element {
  const s = useSpeed(store);
  const big = useSmooth(s.headlineTps, 0.45);
  const idle = s.decisionsTotal === 0 && s.active === 0;
  const hot = s.peakTps > 0 && s.headlineTps >= s.peakTps * 0.97;
  return (
    <div class="tls-spc">
      <style>{SPEED_CSS}</style>
      <div class="tls-mini" data-idle={idle ? '1' : '0'} data-testid="speed-mini">
        <div class="tls-mini-head">
          <span class="tls-k tls-live">Live</span>
          <span class="tls-mini-brand">{label}</span>
          {onRace && !hideControls && (
            <button type="button" class="tls-mini-race" onClick={onRace} aria-label="Race Cerebras against the GPU baseline">Race</button>
          )}
        </div>
        <div class="tls-mini-body">
          <div class="tls-mini-num" data-hot={hot ? '1' : '0'}>{idle ? '--' : fmt(big)}</div>
          <div class="tls-mini-unit">
            <span class="u-long">tokens<br />per second</span>
            <span class="u-short">tok/s</span>
          </div>
        </div>
        <Spark data={s.history} peak={s.peakAggregateTps} />
        {!idle && (
          <div class="tls-mini-agg" data-testid="speed-mini-agg">
            <span>All lanes</span><b>{fmt(s.aggregateTps)}</b><span>tok/s</span>
          </div>
        )}
        {idle ? (
          <div class="tls-mini-wait">Waiting for Kimi&hellip;</div>
        ) : showStats && (
          <div class="tls-mini-stats">
            <div><b>{fmt(s.ttftP50Ms)}<small>ms</small></b><span>first token in</span></div>
            <div><b>{s.decisionsPerS.toFixed(1)}<small>/s</small></b><span>decisions</span></div>
            <div><b>{fmt(s.peakTps)}</b><span>session peak</span></div>
          </div>
        )}
        {showStats && <div class="tls-mini-foot">Measured live</div>}
      </div>
    </div>
  );
}
