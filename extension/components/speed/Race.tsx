// Cerebras vs GPU race: one identical prompt, two live streams, a shared stopwatch, TPS per lane and
// a "xN faster" badge. Both lanes are driven by the real race harness (or lib/speed/mock.ts offline).
// TTFT is always a separate number from TPS; the footnote says what the multiplier means.
import type { JSX } from 'preact';
import { useRef } from 'preact/hooks';
import type { RaceLaneView, RaceStore } from '../../lib/speed/store';
import type { RacePrep } from '../../lib/speed/race-live';
import { fmt, useRace, useSmooth } from './hooks';
import { SPEED_CSS } from './speed-css';

const watch = (ms: number): string => `${(ms / 1000).toFixed(2)} s`;

function Lane({ side, v, win, blocked, reason }: { side: 'a' | 'b'; v: RaceLaneView; win: boolean; blocked?: string | null; reason?: string | null }): JSX.Element {
  const tps = useSmooth(v.tps, 0.4);
  const box = useRef<HTMLDivElement>(null);
  // Reasoning tokens count before any visible text arrives: keep "THINKING..." until the answer starts.
  const waiting = v.started && v.text === '' && !v.done && !blocked;
  return (
    <div class="tls-card tls-lane" data-side={side} data-win={win ? '1' : '0'} data-blocked={blocked ? '1' : '0'}>
      <div class="tls-lhead">
        <span class="tls-lname">{v.label}</span>
        <span class="tls-lsub">{v.sub}</span>
      </div>
      {blocked ? (
        <div class="tls-blocked" data-testid={`race-blocked-${side}`}>
          <b>{blocked}</b>
          {reason && <span>{reason}</span>}
          <span>No numbers are shown for a provider that cannot run.</span>
        </div>
      ) : (
        <>
          <div class="tls-big">{v.started ? fmt(tps) : '--'}<small>TOK/S</small></div>
          <div class="tls-meta">
            <span class="tls-watch">{v.started ? watch(v.elapsedMs) : 'not started'}</span>
            <span class="tls-k">{v.ttftMs != null ? `TTFT ${fmt(v.ttftMs)} ms` : v.started ? 'waiting for first token' : 'TTFT --'}</span>
            <span class="tls-k">{fmt(v.tokens)} tokens</span>
          </div>
          <div class="tls-text" ref={box}>
            <div class="in">
              {waiting ? <span class="tls-wait">THINKING...</span> : v.text}
              {!v.done && v.started && !waiting && <span class="cur" />}
            </div>
          </div>
          {v.done && win && <div class="tls-done">DONE</div>}
          {v.error && <div class="tls-laneerr" data-testid={`race-error-${side}`}>{v.error}</div>}
        </>
      )}
    </div>
  );
}

export interface RaceProps {
  race: RaceStore;
  prep: RacePrep | null;
  racing?: boolean;
  /** Transport-level error from the last race (HTTP body is already trimmed). */
  error?: string | null;
  hideControls?: boolean;
  onStart?: () => void;
}

export function Race({ race, prep, racing, error, hideControls, onStart }: RaceProps): JSX.Element {
  const v = useRace(race);
  const x = useSmooth(Math.min(v.speedup, 999) * 10, 0.3) / 10;
  const aWins = v.a.done && (!v.b.done || (v.final && v.a.elapsedMs <= v.b.elapsedMs));
  const blockedA = prep && !prep.a.configured ? 'Cerebras key not configured' : null;
  const blockedB = prep && !prep.b.configured ? 'GPU baseline not configured' : null;
  const status = racing ? 'Racing now' : prep == null ? 'Checking providers...' : !prep.ready ? prep.note ?? 'Provider not ready' : 'Ready - same prompt, same token cap';
  return (
    <div class="tls-spc">
      <style>{SPEED_CSS}</style>
      <div class="tls-race" data-testid="race">
        <Lane side="a" v={v.a} win={!!aWins} blocked={blockedA} reason={prep?.a.reason} />
        <Lane side="b" v={v.b} win={false} blocked={blockedB} reason={prep?.b.reason} />
        {x >= 1.05 && !blockedA && !blockedB && (
          <div class="tls-vs">
            <span class="tls-x" data-final={v.final ? '1' : '0'}>{x >= 10 ? Math.round(x) : x.toFixed(1)}x<small>FASTER</small></span>
          </div>
        )}
        <div class="tls-racefoot">
          <span class="tls-racesub" data-error={error ? '1' : '0'}>{error ?? status}</span>
          {!hideControls && prep?.ready && onStart && (
            <button type="button" class="tls-start" disabled={racing} onClick={onStart} data-testid="race-start">
              {racing ? 'Racing...' : 'Race'}
            </button>
          )}
          <span class="tls-racek">TTFT is to the first token; tokens/s is decode only; the multiplier uses wall-clock time.</span>
        </div>
      </div>
    </div>
  );
}
