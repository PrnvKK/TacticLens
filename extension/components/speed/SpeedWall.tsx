// Speed wall: huge live TPS, peak marker, per-call ticker, aggregate sparkline, decisions/s.
// TPS is the official per-call decode speed ((tokens-1)/(t_last-t_first)); the label says so.
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SpeedStore } from '../../lib/speed/store';
import { fmt, useSmooth, useSpeed } from './hooks';
import { SPEED_CSS } from './speed-css';

export function SpeedStyle(): JSX.Element { return <style>{SPEED_CSS}</style>; }

export function Spark({ data, peak }: { data: number[]; peak: number }): JSX.Element {
  const W = 300;
  const H = 60;
  const max = Math.max(1000, peak, ...data);
  const n = Math.max(2, data.length);
  const pts = data.map((v, i) => `${((i / (n - 1)) * W).toFixed(1)},${(H - 3 - (v / max) * (H - 8)).toFixed(1)}`);
  const line = pts.join(' ');
  return (
    <svg class="tls-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="aggregate tokens per second">
      <defs>
        <linearGradient id="tls-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#d7ff3e" stop-opacity=".55" /><stop offset="1" stop-color="#d7ff3e" stop-opacity="0" />
        </linearGradient>
      </defs>
      {pts.length > 1 && <polygon points={`0,${H} ${line} ${W},${H}`} fill="url(#tls-g)" />}
      {pts.length > 1 && <polyline points={line} fill="none" stroke="#d7ff3e" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" />}
    </svg>
  );
}

export interface SpeedWallProps {
  store: SpeedStore;
  /** Ticker rows. */
  calls?: number;
  /** Provider label under the number. */
  label?: string;
  /** Open the Cerebras-vs-GPU race view. */
  onRace?: () => void;
  /** Record mode: hide the race button. */
  hideControls?: boolean;
}

export function SpeedWall({ store, calls = 6, label = 'Kimi K3.1 Pro on Cerebras', onRace, hideControls }: SpeedWallProps): JSX.Element {
  const s = useSpeed(store);
  const big = useSmooth(s.headlineTps, 0.4);
  const agg = useSmooth(s.aggregateTps, 0.25);
  const [newPeak, setNewPeak] = useState(0);
  const lastPeak = useRef(0);
  useEffect(() => {
    if (s.peakTps > lastPeak.current * 1.001 && lastPeak.current > 0) setNewPeak((k) => k + 1);
    lastPeak.current = s.peakTps;
  }, [s.peakTps]);
  const hot = s.peakTps > 0 && s.headlineTps >= s.peakTps * 0.97;
  const rows = s.calls.slice(0, calls);
  const barMax = Math.max(1, s.peakTps);
  return (
    <div class="tls-spc">
      <style>{SPEED_CSS}</style>
      <div class="tls-sp" data-testid="speed-wall">
        <div class="tls-card tls-hero">
          <div class="tls-row">
            <span class="tls-k tls-live">Output speed per call</span>
            <span class="tls-rowend">
              {onRace && !hideControls && <button type="button" class="tls-racebtn" onClick={onRace}>Race GPU <span>&rarr;</span></button>}
              <span class="tls-peak" key={newPeak} data-new={newPeak ? '1' : '0'}><i>PEAK</i>{fmt(s.peakTps)}</span>
            </span>
          </div>
          <div>
            <div class="tls-num" data-hot={hot ? '1' : '0'} key={hot ? 'h' : 'n'}>{fmt(big)}</div>
            <div class="tls-unit">TOKENS / SECOND<small>{label}</small></div>
          </div>
          <div>
            <div class="tls-stats">
              <div class="tls-stat"><span>ALL CALLS</span><b>{fmt(agg)}<small> tok/s</small></b></div>
              <div class="tls-stat"><span>P50</span><b>{fmt(s.p50Tps)}</b></div>
              <div class="tls-stat" data-testid="ttft-stat"><span>TTFT P50</span><b>{fmt(s.ttftP50Ms)}<small> ms</small></b></div>
              <div class="tls-stat"><span>TOKENS</span><b>{fmt(s.tokensTotal)}</b></div>
            </div>
            <Spark data={s.history} peak={s.peakAggregateTps} />
            <div class="tls-foot">
              <b>Measured live</b><span class="dot">&middot;</span>official TPS formula
              <small>TPS = (tokens - 1) / (last token - first token) &middot; TTFT shown separately</small>
            </div>
          </div>
        </div>
        <div class="tls-card">
          <div class="tls-k" style="margin-bottom:.4em">Decisions per second</div>
          <div class="tls-dps">{s.decisionsPerS.toFixed(1)}<small>{fmt(s.decisionsTotal)} CALLS - {s.active} LIVE</small></div>
        </div>
        <div class="tls-card tls-ticker" style="grid-column:2">
          <div class="tls-k">Last calls</div>
          {rows.map((c) => (
            <div class="tls-call" key={c.id}>
              <div class="bar" style={`width:${Math.min(100, (c.tps / barMax) * 100).toFixed(1)}%`} />
              <span class="ln">{c.lane || 'call'}</span>
              <span class="tt">TTFT {fmt(c.ttftMs)} ms - {fmt(c.tokens)} tok</span>
              <span class="tp">{fmt(c.tps)}<small>tok/s</small></span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
