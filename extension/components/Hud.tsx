// Broadcast HUD. DOM only: nothing here runs a render loop except
// small, local count-up/stream tickers. Every panel is kept mounted and animated by data-show,
// so entries stagger in and exits are quick without React presence hacks.
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { FeedItem, HudModel, HudStore, LineView, TileView } from '../lib/render/hud-store';
import type { ViewState } from '../lib/render/ui-types';
import { glassQuality } from './glass';

export function useHud(store: HudStore): HudModel {
  const [m, setM] = useState<HudModel>(store.m);
  useEffect(() => {
    setM(store.m);
    return store.subscribe(() => setM(store.m));
  }, [store]);
  return m;
}

const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');
const fmtFixed = (n: number, d = 1): string => n.toFixed(d);

/** Count-up/down that tweens to `to` in 360 ms; tabular digits never reflow. */
function useTween(to: number, ms = 360, restartKey: unknown = null): number {
  const [v, setV] = useState(to);
  const cur = useRef(to);
  useEffect(() => {
    const from = restartKey !== null ? 0 : cur.current;
    const t0 = performance.now();
    let raf = 0;
    const tick = (): void => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      cur.current = from + (to - from) * e;
      setV(cur.current);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, restartKey, ms]);
  return v;
}

function useNow(active: boolean, interval = 100): number {
  const [now, setNow] = useState(() => performance.now() / 1000);
  useEffect(() => {
    if (!active) return;
    setNow(performance.now() / 1000);
    const id = setInterval(() => setNow(performance.now() / 1000), interval);
    return () => clearInterval(id);
  }, [active, interval]);
  return now;
}

function Num({ value, dec = 0 }: { value: number | string; dec?: number }): JSX.Element {
  const isNum = typeof value === 'number';
  const v = useTween(isNum ? value : 0);
  if (!isNum) return <>{value}</>;
  return <>{dec > 0 ? fmtFixed(v, dec) : fmtInt(v)}</>;
}

// ---------------------------------------------------------------------------
// Identity / team plates
// ---------------------------------------------------------------------------

function KimiMark({ small = false }: { small?: boolean }): JSX.Element {
  return (
    <span class={`tl-kmark${small ? ' is-small' : ''}`} title="Read by Kimi" aria-label="Read by Kimi">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3 2.5h2.6v4.1L9.1 2.5h3.2L8 8.2l4.4 5.3H9.1L5.6 9.1v4.4H3z" fill="currentColor" />
      </svg>
    </span>
  );
}

function TeamPlate({ m, team, small = false }: { m: HudModel; team: 'A' | 'B'; small?: boolean }): JSX.Element {
  const c = team === 'A' ? m.kit.A : m.kit.B;
  const ink = team === 'A' ? m.kitInk.A : m.kitInk.B;
  const deep = team === 'A' ? m.kitDeep.A : m.kitDeep.B;
  const edge = team === 'A' ? m.kitEdge.A : m.kitEdge.B;
  return (
    <span class={`tl-plate${small ? ' is-small' : ''}`} data-team={team} style={`--c:${c};--ink:${ink};--deep:${deep};--edge:${edge}`}>
      <i />
      <b>{m.abbr[team]}</b>
    </span>
  );
}

const STATE_LABEL: Record<ViewState, string> = {
  OFF: '', CALIBRATING: 'Locking on', LIVE: 'Live', REPLAY: 'Replay', CLOSE_UP: 'Close-up',
  PAUSED: 'Freeze frame', ASK: 'Telestrator', COMMENTARY: 'Commentary', UNSUPPORTED: 'Unsupported',
};
const STATE_COLOUR: Record<ViewState, string> = {
  OFF: 'var(--tl-dim)', CALIBRATING: 'var(--tl-warn)', LIVE: 'var(--tl-live)', REPLAY: 'var(--tl-replay)',
  CLOSE_UP: '#9dc1ff', PAUSED: 'var(--tl-accent)', ASK: 'var(--tl-accent)', COMMENTARY: 'var(--tl-warn)',
  UNSUPPORTED: 'var(--tl-danger)',
};

const Eye = (): JSX.Element => (
  <svg class="tl-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Kimi is watching">
    <path d="M1.8 12S5.7 5.2 12 5.2 22.2 12 22.2 12 18.3 18.8 12 18.8 1.8 12 1.8 12z" />
    <circle cx="12" cy="12" r="3.1" fill="currentColor" stroke="none" />
  </svg>
);

// ---------------------------------------------------------------------------
// Top strip
// ---------------------------------------------------------------------------

export function StatusPill({ m }: { m: HudModel }): JSX.Element {
  const show = m.state !== 'OFF';
  const label = m.state === 'LIVE' && m.ballOut ? 'Ball out' : STATE_LABEL[m.state];
  const colour = m.state === 'LIVE' && m.ballOut ? 'var(--tl-warn)' : STATE_COLOUR[m.state];
  const secondary = m.state === 'REPLAY' ? 'Multi-angle' : m.state === 'PAUSED' ? 'Telestrator' : m.state === 'ASK' ? 'Draw mode' : '';
  return (
    <div class="tl-z tl-pill tl-glass" data-show={show} data-side={m.pillSide} data-state={m.state} data-ballout={m.ballOut} style={`--c:${colour}`}>
      <i class="tl-pill-edge" />
      <span class="dot" />
      <span class="txt">{label}</span>
      {secondary && <span class="sub">{secondary}</span>}
      {m.hz !== null && m.state !== 'COMMENTARY' && m.state !== 'UNSUPPORTED' && (
        <span class="hz"><b>{m.hz.toFixed(1)}</b> Hz</span>
      )}
      {m.eye && <Eye />}
    </div>
  );
}

export function Toast({ m }: { m: HudModel }): JSX.Element {
  const t = m.toast;
  return (
    <div class="tl-z tl-toast tl-glass" data-show={!!t} key={t?.key ?? 0}>
      <i class="tl-toast-edge" />
      <span class="tl-toast-icon" aria-hidden="true">!</span>
      <b>{t?.label ?? ''}</b>
      {t?.sub && <small>{t.sub}</small>}
    </div>
  );
}

function PossessionSplit({ m }: { m: HudModel }): JSX.Element {
  const p = m.poss;
  const hidden = !p.have || p.gate === 'hidden';
  const paused = p.paused || m.ballOut;
  const a = hidden ? 50 : p.A;
  const b = hidden ? 50 : p.B;
  return (
    <div class="tl-poss" data-paused={paused} data-hidden={hidden} aria-label="Possession">
      <div class="tl-poss-head">
        <span class="plate-row"><TeamPlate m={m} team="A" small /><span class="nm">{m.names.A}</span></span>
        <span class="tl-poss-kicker">Possession</span>
        <span class="plate-row right"><span class="nm">{m.names.B}</span><TeamPlate m={m} team="B" small /></span>
      </div>
      <div class="tl-split">
        <div class="tl-split-track">
          <i class="a" style={`width:${a}%`} />
          <i class="b" style={`width:${b}%`} />
          <i class="tl-split-cut" style={`left:${a}%`} />
          {paused && <span class="tl-split-pattern" />}
        </div>
        <div class="tl-split-meta">
          <b class="a">{hidden ? '--' : paused ? <span class="tl-pauseglyph">||</span> : <><Num value={a} />%</>}</b>
          <span class="tl-poss-state">{paused ? 'Ball out - paused' : hidden ? 'Reading' : 'Live share'}</span>
          <b class="b">{hidden ? '--' : paused ? <span class="tl-pauseglyph">||</span> : <><Num value={b} />%</>}</b>
        </div>
      </div>
    </div>
  );
}

/** Top-centre broadcast strip: team plates, score, clock and the animated possession split. */
export function PossessionBar({ m }: { m: HudModel }): JSX.Element {
  const s = m.state;
  const show = !(s === 'OFF' || s === 'CALIBRATING' || s === 'COMMENTARY' || s === 'UNSUPPORTED');
  const score = m.score;
  return (
    <div class="tl-z tl-scorebar tl-glass tl-glass-sheen" data-show={show}>
      <i class="tl-scorebar-edge" />
      <div class="tl-scorebar-top">
        <span class="tl-sb-identity left"><TeamPlate m={m} team="A" /><b class="name">{m.names.A}</b></span>
        <span class="tl-sb-centre">
          <b class="score">{score ? <>{score[0]}<span>:</span>{score[1]}</> : 'VS'}</b>
          <span class="clock">{m.clock ?? 'LIVE'}</span>
        </span>
        <span class="tl-sb-identity right"><b class="name">{m.names.B}</b><TeamPlate m={m} team="B" /></span>
      </div>
      <PossessionSplit m={m} />
      {m.kimiMark && <span class="tl-sb-read"><KimiMark small /><span>Scorebug read</span></span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

function fmtVal(t: TileView, m: HudModel): JSX.Element {
  if (t.paused) return <span class="tl-pauseglyph" aria-label="paused">||</span>;
  const v = t.value;
  if (typeof v === 'number') return <Num value={v} dec={Number.isInteger(v) ? 0 : 1} />;
  if (typeof v === 'object') {
    const dec = t.key === 'compactness' || t.key === 'lineHeight' || t.key === 'momentum' ? 2 : Number.isInteger(v.A) && Number.isInteger(v.B) ? 0 : 1;
    return (
      <span class="tl-pair">
        <TeamPlate m={m} team="A" small />
        <Num value={v.A} dec={dec} />
        <span class="tl-pair-sep">{t.key === 'numbersNearBall' ? 'v' : ':'}</span>
        <Num value={v.B} dec={dec} />
        <TeamPlate m={m} team="B" small />
      </span>
    );
  }
  return <>{v}</>;
}

export function StatRail({ m }: { m: HudModel }): JSX.Element {
  const s = m.state;
  const show = !(s === 'OFF' || s === 'CALIBRATING' || s === 'CLOSE_UP' || s === 'COMMENTARY' || s === 'UNSUPPORTED');
  return (
    <div class="tl-z tl-rail" data-show={show && m.tiles.length > 0} data-lock={s === 'REPLAY'}>
      <div class="tl-rail-head"><i /><span>Match numbers</span></div>
      {m.tiles.map((t, i) => (
        <div class="tl-tile tl-glass" key={t.key} data-paused={t.paused || (t.ball && m.ballOut)} style={`--i:${i}`}>
          <i class="tl-tile-edge" />
          <div class="lbl"><span>{t.label}</span>{t.paused && <small>paused</small>}</div>
          <div class="val">{fmtVal(t, m)}{t.unit && !t.paused && <small class="unit">{t.unit}</small>}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kimi lower third
// ---------------------------------------------------------------------------

const LANE_LABEL: Record<LineView['lane'], string> = {
  reflex: 'Reflex', watch: 'Watch', ask: 'Ask', replay: 'Replay', director: 'Director',
};
const PHASE_LABEL: Record<LineView['phase'], string> = {
  build_up: 'Build-up', press: 'Press', transition: 'Transition', settled: 'Settled', set_piece: 'Set piece', none: '',
};

/**
 * Team references in feed text always use the jersey colour: "Team Red", never the club name, the scorebug
 * abbreviation or the letters A/B (Kimi is told to do the same; this catches the director's and scripted lines).
 */
export function jerseyText(text: string, m: HudModel): string {
  const lab = { A: `Team ${m.jersey.A}`, B: `Team ${m.jersey.B}` };
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let t = text.replace(/\bteam\s*A\b/gi, lab.A).replace(/\bteam\s*B\b/gi, lab.B);
  for (const k of ['A', 'B'] as const) {
    const name = m.names[k].trim();
    if (name.length < 3 || /^team\b/i.test(name)) continue;
    t = t.replace(new RegExp(`(?<!\\bteam\\s)\\b${esc(name)}(?:'s)?\\b`, 'gi'), (hit) => (/'s$/i.test(hit) ? `${lab[k]}'s` : lab[k]));
  }
  return t;
}

/**
 * Feed text never shows player chips: we cannot identify individual players, so a `[[id]]` mention becomes
 * "a Team <colour> player" (known team) or "a player" (unknown). Sentence-initial mentions are capitalised.
 * Display only: the ids stay in `line.mentions` for the pitch rings.
 */
export function genericMentions(text: string, m: HudModel): string {
  return text.replace(/\[\[(\d+)\]\]/g, (_hit: string, id: string, offset: number, whole: string) => {
    const team = m.teamOf[Number(id)];
    const phrase = team === 'A' || team === 'B' ? `a Team ${m.jersey[team]} player` : 'a player';
    const atStart = /(^\s*|[.!?]\s+|\n\s*)$/.test(whole.slice(0, offset));
    return atStart ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : phrase;
  });
}

/** `full`: label player chips with the jersey colour ("Red") instead of the scorebug abbreviation ("HFC"); the feed has the room. */
function Chips({ text, m, full = false }: { text: string; m: HudModel; full?: boolean }): JSX.Element {
  const parts = text.split(/\[\[(\d+)\]\]/g);
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) {
          if (!p) return null;
          return (
            <span class="tl-words">
              {p.split(/(\s+)/g).map((w, j) => (w.trim() ? <span class="tl-word" key={j}>{w}</span> : w))}
            </span>
          );
        }
        const id = Number(p);
        const team = m.teamOf[id];
        const side: 'A' | 'B' = team === 'B' ? 'B' : 'A';
        const colour = team === 'A' ? m.kit.A : team === 'B' ? m.kit.B : 'var(--tl-neutral)';
        const ink = team === 'A' ? m.kitInk.A : team === 'B' ? m.kitInk.B : '#0a0e12';
        const short = team === 'A' ? m.abbr.A : team === 'B' ? m.abbr.B : 'PLAYER';
        // Feed layout: a player chip reads as the jersey colour ("Red"), the same word the chat uses for the team.
        const name = full ? (team === 'A' ? m.jersey.A : team === 'B' ? m.jersey.B : 'Player') : short;
        return (
          <span class="tl-chip" key={i} data-team={side} style={`--c:${colour};--ink:${ink}`}>
            <i />{name}
          </span>
        );
      })}
    </>
  );
}

function StreamingText({ text, m, live }: { text: string; m: HudModel; live: boolean }): JSX.Element {
  return <div class="tl-l3-text"><Chips text={text} m={m} />{live && <span class="tl-caret" />}</div>;
}

/** Live latency badge. While streaming it ticks the TTFT upper bound and estimates tok/s from
 *  the words on screen; once the line is final it counts up to the measured TTFT and tokens/s.
 *  Never rounds down. */
function SpeedBadge({ l }: { l: LineView }): JSX.Element {
  const live = !l.final;
  const now = useNow(live);
  const ttft = useTween(l.final ? Math.max(1, Math.ceil(l.ttftMs)) : 0, 340, `${l.id}:${l.final}`);
  const tps = useTween(l.final ? Math.max(1, Math.round(l.tokPerS)) : 0, 420, `${l.id}:${l.final}`);
  if (live) {
    const elapsed = Math.max(0.05, now - l.shownAt);
    const estTok = Math.max(1, Math.round(l.text.length / 4));
    const estTps = Math.max(1, Math.round(estTok / elapsed));
    return (
      <span class="tl-speed tl-glass tl-glass-soft" data-live="true" aria-label="Kimi streaming speed">
        <i class="tl-eq"><b /><b /><b /></i>
        <span><b>{estTps}</b> tok/s</span>
        <span class="dim">TTFT &le; {elapsed.toFixed(2)} s</span>
      </span>
    );
  }
  return (
    <span class="tl-speed tl-glass tl-glass-soft" aria-label="Kimi latency">
      <i class="tl-eq done" />
      <span><b>{Math.round(ttft)}</b> ms TTFT</span>
      <span><b>{fmtInt(l.totalMs)}</b> ms total</span>
      <span><b>{fmtInt(tps)}</b> tok/s</span>
    </span>
  );
}

function Thinking({ m }: { m: HudModel }): JSX.Element {
  const since = m.race?.thinkingSince ?? performance.now() / 1000;
  const now = useNow(true);
  return (
    <div class="tl-l3 tl-l3-think tl-glass tl-glass-sheen">
      <div class="tl-l3-mark"><span class="glyph">K</span><span class="word">Kimi</span></div>
      <div class="tl-l3-main">
        <div class="tl-l3-kicker"><span class="tl-live-orb" /><b>Thinking</b><span class="lane">{m.race?.label ?? 'provider'}</span></div>
        <div class="tl-shimmer" style="width:88%" />
        <div class="tl-shimmer" style="width:54%" />
        <div class="tl-l3-foot"><span>waiting {Math.max(0, now - since).toFixed(1)} s</span></div>
      </div>
    </div>
  );
}

export function KimiLine({ m }: { m: HudModel }): JSX.Element {
  const s = m.state;
  const l = m.line;
  const race = m.race;
  const waiting = !!race?.thinking && (!l || l.late !== null);
  const show = s !== 'OFF' && s !== 'UNSUPPORTED' && (!!l || waiting);
  const asking = s === 'PAUSED' || s === 'ASK';
  const [leaving, setLeaving] = useState<LineView | null>(null);
  const lastId = useRef<string | null>(null);
  const cache = useRef<LineView | null>(null);
  useEffect(() => {
    if (l && lastId.current && lastId.current !== l.id && cache.current) {
      setLeaving(cache.current);
      const t = setTimeout(() => setLeaving(null), 190);
      lastId.current = l.id;
      cache.current = l;
      return () => clearTimeout(t);
    }
    lastId.current = l?.id ?? null;
    cache.current = l;
  }, [l?.id]);
  useEffect(() => { cache.current = l; }, [l]);
  return (
    <div class="tl-z tl-kcol" data-show={show} data-asking={asking} data-late={!!l && l.late !== null}>
      {asking && <div class="tl-freeze tl-glass tl-glass-soft"><i />Freeze frame<span>drawing on the still</span></div>}
      {m.askQuestion && asking && <div class="tl-ask-q tl-glass tl-glass-soft"><span>You asked</span>{m.askQuestion}</div>}
      {waiting && <Thinking m={m} />}
      {leaving && l && leaving.id !== l.id && (
        <div class="tl-l3 tl-l3-leaving tl-glass" aria-hidden="true">
          <div class="tl-l3-mark"><span class="glyph">K</span><span class="word">Kimi</span></div>
          <div class="tl-l3-main"><div class="tl-l3-text">{leaving.text.replace(/\[\[\d+\]\]/g, '')}</div></div>
        </div>
      )}
      {l && !(waiting && l.late === null) && (
        <div class="tl-l3 tl-glass tl-glass-sheen" key={l.id} data-late={l.late !== null} data-lane={l.lane}>
          <div class="tl-l3-mark"><span class="glyph">K</span><span class="word">Kimi</span></div>
          <div class="tl-l3-main">
            <div class="tl-l3-kicker">
              <span class="tl-live-orb" data-live={!l.final} />
              <b>{l.final ? 'Live analysis' : 'Reading the play'}</b>
              <span class="lane">{LANE_LABEL[l.lane]}</span>
              {l.phase !== 'none' && <span class="phase">{PHASE_LABEL[l.phase]}</span>}
              <SpeedBadge l={l} />
            </div>
            <StreamingText text={l.text} m={m} live={!l.final} />
            <div class="tl-l3-foot">
              <span class="provider">{l.provider}</span>
              {l.eventToGraphicMs ? <span>event &rarr; graphic <b>{(l.eventToGraphicMs / 1000).toFixed(2)} s</b></span> : null}
              {l.late !== null && <span class="late">{l.late.toFixed(1)} s late - play moved on</span>}
            </div>
          </div>
        </div>
      )}
      <PulseStrip m={m} />
    </div>
  );
}

export function PulseStrip({ m }: { m: HudModel }): JSX.Element {
  const show = m.pulse.length > 0;
  return (
    <div class="tl-pulse tl-glass tl-glass-soft" data-show={show} aria-label="Kimi call pulse">
      <span class="tl-pulse-label">Kimi pulse</span>
      <span class="tl-pulse-ticks">{m.pulse.slice(-34).map((ms, i) => (
        <i key={`${m.pulse.length - 34 + i}:${Math.round(ms)}`} data-fat={ms > 800} style={`--h:${Math.min(100, 14 + (ms / 700) * 86)}%`} />
      ))}</span>
      <span class="tl-pulse-stats"><b>{m.callsPerMin}</b> calls/min<span class="sep">/</span>p50 <b>{m.p50}</b> ms</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prediction, ask, replay, summary
// ---------------------------------------------------------------------------

export function PredictionChip({ m, feed = false }: { m: HudModel; feed?: boolean }): JSX.Element {
  const p = m.prediction;
  const s = m.state;
  // Only the open call is shown. The "Called it / Missed" stamp and the hits/total counter are gone on purpose.
  const show = !(s === 'OFF' || s === 'COMMENTARY' || s === 'UNSUPPORTED' || s === 'CLOSE_UP') && !!p && p.status === 'open';
  let text: JSX.Element = <></>;
  if (p) {
    if (p.kind === 'pass_to') {
      const team = p.targetId !== undefined ? m.teamOf[p.targetId] : undefined;
      const side: 'A' | 'B' = team === 'B' ? 'B' : 'A';
      const chipName = feed ? (team === 'B' ? m.jersey.B : m.jersey.A) : (team === 'B' ? m.abbr.B : m.abbr.A);
      text = <>next ball <span class="tl-chip mini" data-team={side} style={`--c:${team === 'B' ? m.kit.B : m.kit.A};--ink:${team === 'B' ? m.kitInk.B : m.kitInk.A}`}><i />{chipName}</span></>;
    } else if (p.kind === 'switch') text = <>switch to the {p.side ?? 'left'}</>;
    else text = <>a turnover</>;
  }
  return (
    <div class="tl-z tl-pred" data-show={show}>
      {p && p.status === 'open' && (
        <div class="tl-predcard tl-glass tl-glass-sheen" key={p.key}>
          <i class="tl-pred-edge" />
          <div class="tl-pred-top"><span class="tl-live-orb" /><b>Kimi calls</b>
            <svg class="tl-ring" viewBox="0 0 24 24" data-paused={s === 'PAUSED'} style={`--dur:${p.durMs}ms`}>
              <circle class="bg" cx="12" cy="12" r="9" /><circle class="fg" cx="12" cy="12" r="9" />
            </svg>
          </div>
          <div class="tl-pred-text">{text}</div>
          <div class="tl-pred-foot"><span>window</span><b>{p.windowS.toFixed(1)} s</b></div>
        </div>
      )}
    </div>
  );
}

const QUICK = ["Who's free?", "What's the shape?", 'Where is the press?', 'Recap'];

export function AskBar({ m, store }: { m: HudModel; store: HudStore }): JSX.Element {
  const [q, setQ] = useState('');
  const open = m.state === 'PAUSED' || m.state === 'ASK';
  return (
    <div class="tl-z tl-ask tl-glass tl-glass-sheen" data-show={open} data-answering={m.state === 'ASK'}>
      <div class="tl-ask-head"><span class="tl-live-orb" /><b>{m.state === 'ASK' ? 'Telestrator' : 'Freeze frame'}</b><span>draw on the still</span></div>
      <form onSubmit={(e) => { e.preventDefault(); store.submitAsk(q); setQ(''); }}>
        <input value={q} placeholder="Ask Kimi about this frame" onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="Ask Kimi" />
        <button class="go" type="submit" aria-label="Ask">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h10.5M8.5 3.5L13 8l-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
      </form>
      <div class="chips">{QUICK.map((c) => <button key={c} type="button" onClick={() => store.submitAsk(c)}>{c}</button>)}</div>
    </div>
  );
}

export function ReplayCard({ m, feed = false }: { m: HudModel; feed?: boolean }): JSX.Element {
  const steps = m.replayCard;
  const show = m.state === 'REPLAY' && !!steps;
  return (
    <div class="tl-z tl-replay tl-glass tl-glass-sheen" data-show={show}>
      <div class="tl-replay-head"><i><span /><span /><span /></i><b>Replay breakdown</b><span class="multi">Multi-angle</span></div>
      <ol>
        {(steps ?? []).map((s, i) => (
          <li key={i} style={`--i:${i}`}><i>{i + 1}</i><span><Chips text={feed ? jerseyText(genericMentions(s.text, m), m) : s.text} m={m} full={feed} /></span></li>
        ))}
      </ol>
    </div>
  );
}

export function SummaryTile({ m }: { m: HudModel }): JSX.Element {
  const s = m.summary;
  return (
    <div class="tl-z tl-summary tl-glass tl-glass-strong tl-glass-sheen" data-show={!!s}>
      <div class="tl-summary-brand"><span class="mark">T</span><b>TacticLens</b><span>Live match intelligence</span></div>
      <div class="tl-summary-kicker">Kimi watched this clip</div>
      <div class="tl-summary-hero"><em><Num value={s?.calls ?? 0} /></em><span>calls</span><i />
        <em><Num value={s?.p50 ?? 0} /></em><span>ms p50</span>
      </div>
      <div class="tl-summary-row"><span>p95 <b>{s?.p95 ?? 0} ms</b></span><span>{s?.dropped ?? 0} dropped</span><span>{(s?.provider ?? '').replace(' (mock)', '')}</span></div>
    </div>
  );
}

export function Notice({ m }: { m: HudModel }): JSX.Element {
  return (
    <div class="tl-z tl-notice tl-glass tl-glass-strong" data-show={m.state === 'UNSUPPORTED'}>
      <b>This source cannot be read.</b>
      <span>DRM or a tainted video blocks capture. Open the file in the Theatre page instead.</span>
    </div>
  );
}

export function PerfChip({ m }: { m: HudModel }): JSX.Element {
  const show = m.showPerf && m.hz !== null;
  const over = m.renderMs > 4;
  return (
    <div class="tl-z tl-perf tl-glass tl-glass-soft" data-show={show} data-over={over}>
      <span class="tl-perf-live" />
      <span class="tl-perf-main"><b>{m.renderMs.toFixed(2)}</b> ms/frame<span class="sep">/</span><b>{m.fps.toFixed(0)}</b> fps</span>
      <span class="tl-perf-sub">detect {m.hz?.toFixed(1) ?? '--'} Hz<span class="sep">/</span>Q{m.level}<span class="sep">/</span>glass {glassQuality()}{m.dropped ? <><span class="sep">/</span>{m.dropped} dropped</> : null}</span>
      {m.perfDetail && <span class="tl-perf-sub">{m.perfDetail}</span>}
      {m.showPerf && m.director.map((d, i) => (
        <span class="tl-perf-sub" key={`${d.at}:${i}`}>
          dir {d.action} {d.graphic} <b>{d.ttftMs}</b>/<b>{d.totalMs}</b> ms {d.accepted ? 'ok' : 'rej'}{d.reason ? ` - ${d.reason}` : ''}
        </span>
      ))}
    </div>
  );
}

/** "KIMI . 3.0 decisions/s . 650 ms . 92% cached" with the degrade level; more detail under ?perf=1. */
export function KimiSpeed({ m }: { m: HudModel }): JSX.Element {
  const s = m.speed;
  const degraded = !!s && s.level > 0;
  return (
    <div class="tl-z tl-kimispeed tl-glass tl-glass-soft" data-show={!!s && m.state !== 'OFF'} data-degraded={degraded}>
      {s && (
        <>
          <span class="tl-ks-main">
            <i>KIMI</i><span class="sep">.</span><b>{s.decisionsPerS.toFixed(1)}</b> decisions/s<span class="sep">.</span><b>{s.ttftP50}</b> ms<span class="sep">.</span><b>{s.cachedPct}%</b> cached
            {degraded && <><span class="sep">.</span><em>{s.levelName}</em></>}
          </span>
          {m.showPerf && (
            <span class="tl-perf-sub">
              uncached {(s.uncachedPerMin / 1000).toFixed(1)}k/{(s.uncachedLimit / 1000).toFixed(0)}k per min<span class="sep">/</span>
              {s.requestsPerMin} req/min<span class="sep">/</span>total {(s.totalPerMin / 1000).toFixed(0)}k/min<span class="sep">/</span>
              {s.inFlight} in flight<span class="sep">/</span>watch {s.watchFps} fps<span class="sep">/</span>L{s.level}
              <span class="sep">/</span>qfull {s.queueFull}<span class="sep">/</span>429 {s.rateLimited}<span class="sep">/</span>retry {s.retrySuccessPct}%<span class="sep">/</span>cong {s.queueCongestionPct}%
            </span>
          )}
        </>
      )}
    </div>
  );
}

export function PaneLabel({ m, kind }: { m: HudModel; kind: 'fast' | 'slow' }): JSX.Element {
  return (
    <div class="tl-z tl-label tl-glass tl-glass-soft" data-show={!!m.race} data-kind={kind}>
      <i />{m.race?.label ?? ''}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feed layout (Theatre): a glanceable, TikTok-readable HUD.
//   top-left   LIVE pill        top-centre  key stats        top-right  tok/s card (speed layer)
//   left       rolling Kimi side chat (liquid glass)         bottom-right  Kimi's call
// No team plates and no possession bar: Kimi says who has the ball in the chat when it matters.
// New containers here are deliberately NOT `.tl-z`: that class carries will-change:filter, which makes
// a backdrop root and would stop the glass inside from blurring the video behind it.
// ---------------------------------------------------------------------------

const feedLabel = (it: FeedItem): string => {
  if (it.late !== null) return 'Play moved on';
  if (it.lane === 'ask') return 'Answer';
  if (it.phase !== 'none') return PHASE_LABEL[it.phase];
  return '';
};

function ChatBubble({ it, age, m }: { it: FeedItem; age: number; m: HudModel }): JSX.Element {
  const you = it.kind === 'you';
  const sys = it.kind === 'sys';
  const tag = you ? 'You asked' : sys ? 'Kimi' : feedLabel(it);
  return (
    <div class="tl-msgrow" data-you={you} data-newest={age === 0}>
      <div class="tl-msgclip">
        <div class="tl-msg tl-glass tl-glass-soft" data-you={you} data-sys={sys} data-late={it.late !== null} data-live={!it.final} style={`--age:${age}`}>
          {tag && <span class="tl-msg-tag">{tag}</span>}
          <div class="tl-msg-text">
            {you || sys ? it.text : <Chips text={jerseyText(genericMentions(it.text, m), m)} m={m} full />}
            {!it.final && <span class="tl-caret" />}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Right-hand badge of the chat header: the one place the feed layout says what mode the picture is in. */
const CHAT_BADGE: Record<ViewState, string> = {
  OFF: 'Live', CALIBRATING: 'Locking on', LIVE: 'Live', REPLAY: 'Replay', CLOSE_UP: 'Close-up',
  PAUSED: 'Paused', ASK: 'Asking', COMMENTARY: 'Live', UNSUPPORTED: 'Live',
};
function chatBadge(m: HudModel): string {
  return m.state === 'LIVE' && m.ballOut ? 'Ball out' : CHAT_BADGE[m.state];
}

/** Rolling Kimi commentary: newest at the bottom, older bubbles drift up and fade. */
export function SideChat({ m }: { m: HudModel }): JSX.Element {
  const s = m.state;
  const show = s !== 'OFF' && s !== 'UNSUPPORTED';
  const items = m.feed;
  // The typing bubble means a real Kimi call is in flight (or a question is waiting for its answer), never just "empty".
  const typing = m.typing || m.askPending || !!m.race?.thinking;
  return (
    <div class="tl-f tl-chat" data-show={show} data-state={s} aria-label="Kimi live commentary" aria-live="polite">
      <div class="tl-chat-head tl-glass">
        <span class="tl-chat-avatar"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h2.6v4.1L9.1 2.5h3.2L8 8.2l4.4 5.3H9.1L5.6 9.1v4.4H3z" fill="currentColor" /></svg></span>
        <span class="tl-chat-name"><b>Kimi</b><small>watching the match</small></span>
        <span class="tl-chat-live" data-state={s} data-ballout={m.ballOut}><i />{chatBadge(m)}</span>
      </div>
      <div class="tl-chat-list">
        {items.map((it, i) => <ChatBubble key={it.id} it={it} age={items.length - 1 - i + (typing ? 1 : 0)} m={m} />)}
        {typing && (
          <div class="tl-msgrow tl-typing-row" data-newest="true">
            <div class="tl-msgclip"><div class="tl-msg tl-glass tl-glass-soft tl-typing" aria-label="Kimi is thinking"><i /><i /><i /></div></div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ t, m, i }: { t: TileView; m: HudModel; i: number }): JSX.Element {
  const v = t.value;
  const pair = typeof v === 'object';
  const dec = pair ? (t.key === 'compactness' || t.key === 'lineHeight' ? 2 : Number.isInteger(v.A) && Number.isInteger(v.B) ? 0 : 1)
    : typeof v === 'number' ? (Number.isInteger(v) ? 0 : 1) : 0;
  const sum = pair ? v.A + v.B : 0;
  const aPct = pair && sum > 0 ? Math.round((v.A / sum) * 100) : 50;
  const paused = t.paused || (t.ball && m.ballOut);
  return (
    <div class="tl-stat tl-glass" data-paused={paused} data-pair={pair} style={`--i:${i}`}>
      <div class="tl-stat-label">{t.label}</div>
      <div class="tl-stat-val">
        {paused ? <span class="tl-pauseglyph" aria-label="paused">||</span>
          : pair ? (
            <>
              <b class="a"><Num value={v.A} dec={dec} /></b>
              <span class="vs">{t.key === 'numbersNearBall' ? 'v' : ':'}</span>
              <b class="b"><Num value={v.B} dec={dec} /></b>
            </>
          ) : <><b><Num value={typeof v === 'number' ? v : 0} dec={dec} /></b>{t.unit && <small class="unit">{t.unit}</small>}</>}
      </div>
      {pair && !paused && (
        <div class="tl-stat-bar" aria-hidden="true"><i class="a" style={`width:${aPct}%`} /><i class="b" style={`width:${100 - aPct}%`} /></div>
      )}
    </div>
  );
}

/** Kimi-chosen match numbers (free players, compactness...): small, quiet cards that pop up, linger a few seconds, then fade slowly. */
export function KeyStats({ m }: { m: HudModel }): JSX.Element {
  const show = m.tilesOn && m.shownTiles.length > 0;
  return (
    <div class="tl-f tl-keystats" data-show={show} data-lock={m.state === 'REPLAY'} data-n={m.shownTiles.length}>
      {m.shownTiles.map((t, i) => <StatCard key={t.key} t={t} m={m} i={i} />)}
    </div>
  );
}

function GuideSeg({ m, team }: { m: HudModel; team: 'A' | 'B' }): JSX.Element {
  return (
    <span class="tl-guide-seg" data-team={team} style={`--c:${m.kit[team]};--deep:${m.kitDeep[team]}`}>
      <small>Team {team}</small>
      <i aria-hidden="true" />
      <b>{m.jersey[team]}</b>
    </span>
  );
}

/** Top-right team-colour key ("TEAM A (swatch) Red | TEAM B (swatch) Yellow"). Replaces the old status pill in the feed layout. */
export function TeamGuide({ m }: { m: HudModel }): JSX.Element {
  const show = m.state !== 'OFF' && m.state !== 'UNSUPPORTED' && m.state !== 'CALIBRATING';
  return (
    <div class="tl-f tl-guide" data-show={show} aria-label="Team colours">
      <div class="tl-guide-pill tl-glass tl-glass-soft">
        <GuideSeg m={m} team="A" />
        <i class="tl-guide-div" aria-hidden="true" />
        <GuideSeg m={m} team="B" />
      </div>
    </div>
  );
}

function FeedHud({ m, store, raceLabelKind }: { m: HudModel; store: HudStore; raceLabelKind: 'fast' | 'slow' }): JSX.Element {
  return (
    <>
      <TeamGuide m={m} />
      <Toast m={m} />
      <KeyStats m={m} />
      <SideChat m={m} />
      <ReplayCard m={m} feed />
      <PredictionChip m={m} feed />
      <AskBar m={m} store={store} />
      <SummaryTile m={m} />
      <Notice m={m} />
      <PerfChip m={m} />
      {m.showPerf && <KimiSpeed m={m} />}
      {m.race && m.state !== 'OFF' && <PaneLabel m={m} kind={raceLabelKind} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export type HudVariant = 'classic' | 'feed';

export function Hud({ store, variant = 'classic' }: { store: HudStore; variant?: HudVariant }): JSX.Element {
  const m = useHud(store);
  const raceLabelKind = m.race?.thinking !== undefined && m.race.label.toLowerCase().includes('gpu') ? 'slow' : 'fast';
  const vars = [
    `--tl-a:${m.kit.A}`, `--tl-b:${m.kit.B}`,
    `--tl-a-ink:${m.kitInk.A}`, `--tl-b-ink:${m.kitInk.B}`,
    `--tl-a-deep:${m.kitDeep.A}`, `--tl-b-deep:${m.kitDeep.B}`,
  ].join(';');
  if (variant === 'feed') {
    return (
      <div class="tl-hud-root tl-feed" data-state={m.state} data-ballout={m.ballOut} data-tier={m.tier} style={vars}>
        <FeedHud m={m} store={store} raceLabelKind={raceLabelKind} />
      </div>
    );
  }
  return (
    <div class="tl-hud-root" data-state={m.state} data-ballout={m.ballOut} data-tier={m.tier} style={vars}>
      <PossessionBar m={m} />
      <StatusPill m={m} />
      <Toast m={m} />
      <StatRail m={m} />
      <ReplayCard m={m} />
      <KimiLine m={m} />
      <PredictionChip m={m} />
      <AskBar m={m} store={store} />
      <SummaryTile m={m} />
      <Notice m={m} />
      <PerfChip m={m} />
      <KimiSpeed m={m} />
      {m.race && m.state !== 'OFF' && <PaneLabel m={m} kind={raceLabelKind} />}
    </div>
  );
}

export function RaceFooter({ left, right }: { left: HudModel; right: HudModel }): JSX.Element | null {
  const l = left.race, r = right.race;
  if (!l && !r) return null;
  return (
    <div class="tl-racefooter">
      <div class="count">
        <b>{l?.label ?? 'Left'}</b> <em>{l?.onTime ?? 0}</em> on time <span class="sep">-</span> <b>{r?.label ?? 'Right'}</b> <em>{r?.onTime ?? 0}</em> on time
      </div>
      <div class="fair">{l?.fairness ?? 'Same model, same prompt, same reasoning setting, same token cap.'} One pinned provider each; counts are answers that landed inside the staleness window.</div>
    </div>
  );
}
