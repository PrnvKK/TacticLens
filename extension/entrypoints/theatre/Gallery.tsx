// ?gallery=1: every primitive, HUD element and state on one scrollable page, for screenshot review.
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { GraphicType, KimiLane, KimiLine, Prediction } from '@tacticlens/core';
import { StatusPill } from '../../components/Hud';
import { Stage } from '../../components/Stage';
import { HUD_CSS } from '../../components/hud-css';
import { initGlass } from '../../components/glass';
import { injectCss } from '../../lib/render/loop';
import { carrierAt, snapshotAt } from '../../lib/mock';
import type { Phase } from '../../lib/mock/world';
import type { OverlayController } from '../../lib/render/controller';
import { HudStore } from '../../lib/render/hud-store';
import type { ViewState } from '../../lib/render/ui-types';
import { VirtualClock } from '../../lib/video';

interface Helpers {
  ctl: OverlayController;
  st: number;
  car: number;
  intent(type: GraphicType, ids: number[], o?: { team?: 'A' | 'B'; label?: string; source?: 'rules' | 'kimi' }): string;
  line(text: string, o?: { lane?: KimiLane; final?: boolean; id?: string }): void;
  later(ms: number, fn: () => void): void;
}
interface CellDef {
  id: string;
  title: string;
  note: string;
  st: number;
  phase?: Partial<Phase>;
  wide?: boolean;
  live?: boolean;
  force?: ViewState;
  setup?: (h: Helpers) => void;
  slow?: boolean;
}

const calls = (h: Helpers, ms = 220): void => { for (let i = 0; i < 30; i++) h.ctl.message({ kind: 'call', ms: ms * (0.7 + ((i * 37) % 10) / 16), lane: 'watch' }); };
const pred = (h: Helpers, status: Prediction['status'], target = 9): void => {
  const p: Prediction = { id: 'pg', kind: 'pass_to', targetId: target, madeAt: h.st, windowS: 5, status: 'open' };
  h.later(0, () => {
    h.ctl.message({ kind: 'prediction', prediction: p });
    h.ctl.message({ kind: 'intent', intent: { id: 'pg', type: 'prediction', ids: [h.car, target], enteredAt: h.st, ttlS: 999, source: 'kimi' } });
  });
  if (status !== 'open') h.later(1700, () => h.ctl.message({ kind: 'prediction', prediction: { ...p, status, resolvedAt: h.st + 3.2 } }));
};

const CELLS: { section: string; cells: CellDef[] }[] = [
  {
    section: 'Overlay states',
    cells: [
      { id: 'st-cal', title: 'CALIBRATING', note: 'Scan line, neutral rings pop as it passes, pill "Locking on".', st: 1.3, setup: (h) => h.ctl.message({ kind: 'perf', hz: 7.8, device: 'Intel iGPU (mock)', level: 3, eye: false }) },
      { id: 'st-lockon', title: 'LOCK-ON', note: 'Calibration resolves: the scan passes, rings pop in sequence and cross-fade to kit colours.', st: 2.55, live: true, wide: true, setup: (h) => h.ctl.message({ kind: 'perf', hz: 8.2, device: 'Intel iGPU (mock)', level: 3, eye: true }) },
      {
        id: 'st-live', title: 'LIVE', note: 'Team rings, ball with trail, carrier chevron, possession bar with scout names (Kimi mark), rail, Kimi line, pulse.', st: 8.4, live: true, wide: true,
        setup: (h) => {
          h.ctl.message({ kind: 'perf', hz: 7.8, device: 'Intel iGPU (mock)', level: 3, eye: true });
          h.ctl.message({ kind: 'tiles', keys: ['pressure', 'openOptions', 'compactness'] });
          calls(h);
          h.line('[[8]] has time, and [[9]] is the free man on the left.', { lane: 'reflex' });
          h.intent('spotlight', [9], { source: 'kimi' });
          h.intent('tag', [9], { label: 'free man', source: 'kimi' });
        },
      },
      { id: 'st-out', title: 'LIVE / BALL OUT', note: 'Ball marker gone, pill "Ball out of shot", ball stats desaturate with a pause glyph; rings and hull carry on.', st: 28.2, wide: true,
        setup: (h) => { h.ctl.message({ kind: 'tiles', keys: ['pressure', 'openOptions', 'compactness'] }); h.intent('hull', [], { team: 'A' }); } },
      { id: 'st-replay', title: 'REPLAY', note: 'Branded wipe in, stats dimmed and locked, breakdown card, REPLAY pill.', st: 43, wide: true,
        setup: (h) => { h.ctl.message({ kind: 'tiles', keys: ['pressure', 'openOptions', 'compactness'] }); h.ctl.message({ kind: 'replay_card', steps: [{ text: '[[8]] draws the full-back wide' }, { text: '[[9]] finds the pocket behind' }, { text: 'The finish comes off the second ball' }] }); } },
      { id: 'st-close', title: 'CLOSE-UP', note: 'Rings and lanes exit, rail collapses to the pill; a close-up line is allowed.', st: 52, setup: (h) => h.line('Close-up: the keeper is organising the wall.') },
      { id: 'st-paused', title: 'FREEZE FRAME', note: 'The still dims 18%, graphics stay exactly where they were, ask bar rises above the subtitle zone.', st: 8.4, force: 'PAUSED', wide: true, setup: (h) => { h.intent('lanes', [h.car, 6, 9, 4], { team: 'A', source: 'kimi' }); } },
      { id: 'st-ask', title: 'TELESTRATOR', note: 'Pause, ask, and the answer draws rings, a tag and a lane onto the frozen frame.', st: 8.4, force: 'ASK', wide: true,
        setup: (h) => { h.ctl.hud.message({ kind: 'ask_state', question: "Who's free?" }); h.line('[[9]] is free: nobody within a body length, and the lane from [[5]] is open.', { lane: 'ask' }); h.intent('spotlight', [9], { source: 'kimi' }); h.intent('tag', [9], { label: 'free man', source: 'kimi' }); h.intent('lanes', [h.car, 9], { source: 'kimi' }); } },
      { id: 'st-comm', title: 'COMMENTARY', note: 'No WebGPU: world graphics gone, Kimi line and stamps only.', st: 56, setup: (h) => { h.line('Commentary mode: no tracking, Kimi is reading the frames only.'); calls(h); } },
      { id: 'st-unsup', title: 'UNSUPPORTED', note: 'One notice, pointing at the Theatre page.', st: 60 },
    ],
  },
  {
    section: 'On-pitch primitives',
    cells: [
      { id: 'p1', title: 'Rings, ball + trail, carrier', note: 'Live glide: feet-anchored ellipses, 0.6 s comet trail, chevron on the carrier.', st: 6, live: true },
      { id: 'p4', title: 'Spotlight + Tag', note: 'Rest of the picture dims 35%; bright ring draws as a stroke; tag on a leader line.', st: 8.4, setup: (h) => { h.intent('spotlight', [9, 10], { source: 'kimi' }); h.intent('tag', [9], { label: 'free man', source: 'kimi' }); } },
      { id: 'p6', title: 'Pass lanes', note: 'Thickness = score; blocked lanes are broken with a cross.', st: 8.4, setup: (h) => h.intent('lanes', [h.car, 6, 9, 4], { team: 'A' }) },
      { id: 'p7a', title: 'Prediction ghost (open)', note: 'Dashes march along the path for the whole countdown; chip with countdown ring.', st: 8.4, setup: (h) => pred(h, 'open') },
      { id: 'p7b', title: 'Prediction: CALLED IT', note: 'Dashes fuse solid, stamp slams in, scoreboard ticks.', st: 8.4, setup: (h) => { h.ctl.message({ kind: 'scoreboard', hits: 6, total: 10 }); pred(h, 'hit'); } },
      { id: 'p7c', title: 'Prediction: MISSED', note: 'Desaturate and fade in 300 ms; honest miss.', st: 8.4, setup: (h) => { h.ctl.message({ kind: 'scoreboard', hits: 6, total: 10 }); pred(h, 'miss'); } },
      { id: 'p8', title: 'Shape hull', note: 'Translucent 12% fill, outline draws; follows smoothed ring positions.', st: 8.4, setup: (h) => { h.intent('hull', [], { team: 'A' }); h.intent('hull', [], { team: 'B' }); } },
      { id: 'p13', title: 'Formation lines', note: 'Catmull-Rom curves through each line; deeper lines are faded by confidence.', st: 8.4, setup: (h) => { h.intent('line', [], { team: 'B' }); h.intent('line', [], { team: 'A' }); } },
      { id: 'p9', title: 'Pressure ring', note: 'One lit segment per opponent near the carrier.', st: 8.4, setup: (h) => h.intent('pressure', [h.car]) },
      { id: 'p10', title: 'Overload box', note: 'Corners snap in; "n v m" counted from the rings inside.', st: 8.4, setup: (h) => h.intent('overload', [6, 7, 9, 10], { team: 'A' }) },
      { id: 'p11', title: 'Marking links', note: 'Thin dashed links with an approximate distance tag; unmarked attackers pulse.', st: 8.4, setup: (h) => h.intent('links', [], { team: 'A' }) },
      { id: 'p12', title: 'Run arrow', note: 'Ahead of a player sprinting relative to the group.', st: 8.4, live: true, setup: (h) => h.intent('run', [11]) },
      { id: 'p15', title: 'Switch arc', note: 'Curved arrow from the carrier to the far-side free player.', st: 8.4, setup: (h) => h.intent('switch', [h.car, 11], { source: 'kimi' }) },
      { id: 'p18', title: 'Space pocket', note: 'Soft highlight between two players.', st: 8.4, setup: (h) => h.intent('pocket', [10, 9], { source: 'kimi' }) },
      { id: 'p20', title: 'Lag ghost (race)', note: 'Where the ball was when the slow answer landed, thin line to where it is now.', st: 8.4, live: true,
        setup: (h) => { h.ctl.message({ kind: 'lag', id: 'lagg', ballXY: [0.42, 0.55], lateS: 2.4 }); h.intent('lag_ghost', []); } },
    ],
  },
  {
    section: 'HUD elements',
    cells: [
      { id: 'h-kimi', title: 'Kimi line, stamp, pulse', note: 'Chips are team coloured and never show the tracker id; stamp counts up to the measured figure.', st: 8.4, wide: true,
        setup: (h) => { calls(h); h.line('[[8]] has time, and [[9]] is the free man on the left.', { lane: 'reflex' }); } },
      { id: 'h-stream', title: 'Streaming (partial)', note: 'Caret while tokens arrive, stamp reads "streaming".', st: 8.4, setup: (h) => h.line('Redstone sit deep; the gap between their', { lane: 'watch', final: false }) },
      { id: 'h-late', title: 'Race: late, greyed', note: 'Slow side: answer arrives after the play moved on.', st: 8.4, slow: true,
        setup: (h) => { h.line('[[8]] has time, and [[9]] is the free man on the left.', { lane: 'watch' }); h.ctl.message({ kind: 'late', lineId: 'gl', lateS: 2.4 }); h.ctl.message({ kind: 'race', label: 'GPU baseline', onTime: 3, other: 0, otherLabel: '' }); h.ctl.message({ kind: 'lag', id: 'lagg', ballXY: [0.42, 0.55], lateS: 2.4 }); h.intent('lag_ghost', []); } },
      { id: 'h-think', title: 'Race: thinking shimmer', note: 'Running clock while the slow provider has not answered.', st: 8.4, slow: true,
        setup: (h) => { h.ctl.message({ kind: 'race', label: 'GPU baseline', onTime: 3, other: 0, otherLabel: '' }); h.ctl.message({ kind: 'thinking', on: true, since: performance.now() / 1000 - 1.3 }); } },
      { id: 'h-poss', title: 'Possession, rail, toast', note: 'Names from the scorebug read carry the Kimi mark; one toast with event-to-graphic time.', st: 8.4, wide: true,
        setup: (h) => { h.ctl.message({ kind: 'tiles', keys: ['numbersNearBall', 'tempo', 'lineHeight'] }); h.ctl.message({ kind: 'event', event: { type: 'turnover', t: h.st, team: 'B', confidence: 0.9, detail: {} }, eventToGraphicMs: 310 }); } },
      { id: 'h-sum', title: 'End-of-clip summary tile', note: 'The number people quote.', st: 63.5, setup: (h) => h.ctl.message({ kind: 'summary', summary: { calls: 184, p50: 240, p95: 410, dropped: 0, provider: 'Kimi K3.1 Pro on Cerebras (mock)' } }) },
      { id: 'h-perf', title: 'Perf chip', note: 'On in the demo, off by default.', st: 8.4, setup: (h) => { h.ctl.hud.setPerfVisible(true); h.ctl.message({ kind: 'perf', hz: 7.8, device: 'Intel iGPU - WebGPU', level: 3, eye: true, captureDropped: 2 }); } },
      { id: 'h-pillside', title: 'Layout: pill swaps to top-left', note: 'When the scorebug mask says top-right is occupied.', st: 8.4, setup: (h) => h.ctl.hud.setPillSide('left') },
    ],
  },
];

function Cell({ def }: { def: CellDef }): JSX.Element {
  const clock = useMemo(() => {
    const c = new VirtualClock(70, false, !def.live);
    c.currentTime = def.st;
    return c;
  }, [def.id]);
  const done = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { timers.current.forEach(clearTimeout); if (poll.current) clearInterval(poll.current); }, []);

  const ready = (ctl: OverlayController): void => {
    if (done.current) return;
    done.current = true;
    ctl.hud.hold = true;
    if (def.force) ctl.forceState = def.force;
    const push = (): void => {
      const st = clock.currentTime;
      const s = snapshotAt(st, st - (def.live ? 0.13 : 0), true, { forcePhase: def.phase });
      if (def.live) s.tMedia = st - 0.13;
      ctl.snapshot(s);
    };
    push();
    poll.current = setInterval(push, def.live ? 110 : 500);
    let n = 0;
    // graphics wait until the rings are born (frame rate may be low in a background pane)
    const queued: (() => void)[] = [];
    let go = false;
    const afterReady = (fn: () => void): void => { if (go) fn(); else queued.push(fn); };
    const waiter = setInterval(() => {
      if (ctl.engine.ringCount < 12 && !(def.st >= 50 && def.st < 62)) return;
      go = true;
      clearInterval(waiter);
      queued.splice(0).forEach((f) => f());
    }, 150);
    timers.current.push(waiter as unknown as ReturnType<typeof setTimeout>);
    const h: Helpers = {
      ctl, st: def.st, car: carrierAt(def.st).id,
      intent: (type, ids, o = {}) => {
        const id = `${def.id}-${++n}`;
        afterReady(() => timers.current.push(setTimeout(() => ctl.message({ kind: 'intent', intent: { id, type, ids, team: o.team, label: o.label, enteredAt: clock.currentTime, ttlS: 999, source: o.source ?? 'rules' } }), 200)));
        return id;
      },
      line: (text, o = {}) => {
        const lane = o.lane ?? 'watch';
        const line: KimiLine = {
          id: o.id ?? 'gl', text, mentions: [...text.matchAll(/\[\[(\d+)\]\]/g)].map((m) => Number(m[1])), phase: 'build_up', lane, snapshotT: def.st,
          stamp: { provider: def.slow ? 'GPU baseline' : 'Cerebras', lane, ttftMs: def.slow ? 2400 : 212, totalMs: o.final === false ? 0 : def.slow ? 2700 : 260, tokensIn: 5200, tokensOut: 24, tokPerS: o.final === false ? 0 : def.slow ? 70 : 1840, framesSent: 4 },
        };
        ctl.message({ kind: 'line', line });
      },
      later: (ms, fn) => { afterReady(() => { timers.current.push(setTimeout(fn, ms)); }); },
    };
    def.setup?.(h);
  };

  return (
    <figure class="gl-cell" data-wide={!!def.wide} id={def.id}>
      <div class="gl-frame">
        <Stage clock={clock} controllerOpts={{ ignorePause: true }} showcase={BIG_CELLS} pinGlass onController={ready} />
      </div>
      <figcaption><b>{def.title}</b><span>{def.note}</span></figcaption>
    </figure>
  );
}

/** Gallery cells are design previews: use the recording scale on desktop, the phone scale at 375. */
const BIG_CELLS = typeof window !== 'undefined' && window.innerWidth >= 900;

const PILL_STATES: { s: ViewState; ball?: boolean; eye?: boolean }[] = [
  { s: 'CALIBRATING' }, { s: 'LIVE', eye: true }, { s: 'LIVE', ball: true, eye: true }, { s: 'REPLAY' }, { s: 'CLOSE_UP' },
  { s: 'PAUSED' }, { s: 'ASK', eye: true }, { s: 'COMMENTARY' }, { s: 'UNSUPPORTED' },
];

function PillStrip(): JSX.Element {
  // Snapshot the initial model, then dispose: the store's 8 s tile-rotation interval must not outlive the strip.
  const base = useMemo(() => {
    const s = new HudStore();
    try { return s.m; } finally { s.dispose(); }
  }, []);
  return (
    <div class="gl-pills">
      {PILL_STATES.map((p, i) => (
        <div class="gl-pill tl-hud" key={i} style={`--fs:${'14px'}`}>
          <div style={{ position: 'relative', height: '3em' }}>
            <StatusPill m={{ ...base, state: p.s, ballOut: !!p.ball, eye: !!p.eye, hz: p.s === 'COMMENTARY' ? null : 7.8, pillSide: 'left' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Gallery(): JSX.Element {
  useEffect(() => { injectCss(HUD_CSS); initGlass(); }, []);
  return (
    <div class="gl-root">
      <header class="gl-head">
        <h1>TacticLens gallery</h1>
        <p>Every overlay state, on-pitch primitive and HUD element on the synthetic stadium feed (mock data, no video). Recording sequence: <code>?showcase=1</code>. Interactive mock: <code>?mock=1</code>.</p>
        <nav>{CELLS.map((g) => <a key={g.section} href={`#${g.section.split(' ')[0]!.toLowerCase()}`}>{g.section.split(' (')[0]}</a>)}<a href="#pills">Status pill states</a><a href="?mock=1">Theatre (mock)</a><a href="?showcase=1">Showcase</a><a href="?mock=1&perf=1">Perf chip</a></nav>
      </header>
      {CELLS.map((g) => (
        <section key={g.section} id={g.section.split(' ')[0]!.toLowerCase()}>
          <h2>{g.section}</h2>
          <div class="gl-grid">{g.cells.map((c) => <Cell key={c.id} def={c} />)}</div>
        </section>
      ))}
      <section id="pills">
        <h2>Status pill states</h2>
        <div class="gl-pillbg"><PillStrip /></div>
      </section>
    </div>
  );
}
