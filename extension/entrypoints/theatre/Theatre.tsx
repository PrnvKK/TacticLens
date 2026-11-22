// Theatre: the demo page. Plays a local video full-bleed with the overlay on top.
import type { JSX } from 'preact';
import { HudStore } from '../../lib/render/hud-store';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { RaceFooter, jerseyText, useHud } from '../../components/Hud';
import { Stage } from '../../components/Stage';
import { SpeedDemo } from '../../components/speed';
import { attachSpeedTap, theatreSpeed } from '../../lib/speed/live';
import { connectBrain } from '../../lib/brain-bridge';
import { SessionRecorder, parseSourceKind, resolveProfile, type SourceKind, type SourceProfile } from '@tacticlens/core';
import { Capturer } from '../../lib/capture';
import { CommentaryDriver } from '../../lib/live/commentary';
import { DirectorDriver } from '../../lib/live/director';
import { MockKimiLoad } from '../../lib/live/speed-sim';
import { LiveSource } from '../../lib/live/source';
import { captureComposite } from '../../lib/bridge/capture';
import { BridgeClient } from '../../lib/bridge/client';
import { getBridgeEnabled, onBridgeEnabledChange } from '../../lib/bridge/settings';
import { buildBridgeState } from '../../lib/bridge/state';
import { getSettings } from '../../lib/llm/storage';
import { MockSource } from '../../lib/mock';
import { ShowcaseSource } from '../../lib/mock/showcase';
import type { OverlayController } from '../../lib/render/controller';
import type { MediaClock } from '../../lib/video';
import { VirtualClock, fmtTime } from '../../lib/video';

const params = new URLSearchParams(location.search);
const SRC_PARAM = params.get('src');   // dev/verification: ?src=<url> loads a video by URL instead of the file picker
const SOURCE_KIND: SourceKind = parseSourceKind(params.get('source'));   // ?source=broadcast|game|auto
const flag = (k: string): boolean => params.has(k) && params.get(k) !== '0';
const SPEED_VIEW = params.get('speed');   // ?speed=wall|race|burst (compact is the default when any speed view is on)
const RECORD = flag('record');   // ?record=1: save the brain's FrameStates of the played video as a session JSONL (for `pnpm replay`)
/** ?speed=...&record=1: clean capture surface. No dev toolbar, no cursor, no session recorder. */
const CLEAN_RECORD = RECORD && SPEED_VIEW != null;
const SHOWCASE_AT = Number(params.get('showcaseAt') ?? 0) || 0;  // dev/recording: start the 30 s showcase at this second

const JUMPS: [string, number][] = [
  ['Calibrating', 0.2], ['Live + scout', 5], ['Spotlight + lanes', 5.6], ['Hull + line', 9.2], ['Called it', 12.1],
  ['Overload', 17.1], ['Missed', 20.1], ['Ball out', 26.2], ['Press + links', 30.1], ['Switch arc', 34.1],
  ['Replay', 40.2], ['Close-up', 50.2], ['Commentary', 55.2], ['Unsupported', 59.2], ['Summary', 63.2],
];

function useClockState(clock: MediaClock | null): { t: number; paused: boolean; rate: number; dur: number } {
  const [s, setS] = useState({ t: 0, paused: true, rate: 1, dur: 0 });
  useEffect(() => {
    if (!clock) return;
    const id = setInterval(() => setS({ t: clock.currentTime, paused: clock.paused, rate: clock.playbackRate, dur: clock.duration }), 120);
    return () => clearInterval(id);
  }, [clock]);
  return s;
}

export function Theatre(): JSX.Element {
  const [fileUrl, setFileUrl] = useState<string | null>(SRC_PARAM);
  const [fileName, setFileName] = useState(SRC_PARAM ? SRC_PARAM.split('/').pop() ?? '' : '');
  const [brainMsg, setBrainMsg] = useState('');
  const [mock, setMock] = useState(flag('mock'));
  const [race, setRace] = useState(flag('race'));
  const [showcase, setShowcase] = useState(flag('showcase'));
  const [bigHud, setBigHud] = useState(false);
  const [perf, setPerf] = useState(flag('perf'));
  const [clean, setClean] = useState(flag('clean') || flag('showcase'));
  const [demoOpen, setDemoOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(flag('tools'));
  const [drag, setDrag] = useState(false);
  const [fs, setFs] = useState(false);
  const [idle, setIdle] = useState(false);
  const [ctl, setCtl] = useState<OverlayController | null>(null);
  const [ctl2, setCtl2] = useState<OverlayController | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const recRef = useRef<{ lines: string[]; rec: SessionRecorder } | null>(null);
  const [recCount, setRecCount] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  /** Renderer cut -> brain, once the perception link exists. */
  const cutSink = useRef<((mediaTime: number) => void) | null>(null);
  const handleCut = useCallback((mediaTime: number) => { cutSink.current?.(mediaTime); }, []);

  // ----- media -----
  const video = useMemo(() => {
    if (!fileUrl) return null;
    const v = document.createElement('video');
    v.src = fileUrl; v.playsInline = true; v.loop = true; v.preload = 'auto';
    return v;
  }, [fileUrl]);
  const video2 = useMemo(() => {
    if (!fileUrl || !race) return null;
    const v = document.createElement('video');
    v.src = fileUrl; v.muted = true; v.playsInline = true; v.loop = true;
    return v;
  }, [fileUrl, race]);
  const vclock = useMemo(() => new VirtualClock(70, true, false), []);
  const showcaseRef = useRef<ShowcaseSource | null>(null);
  const showcasePhase = useCallback(() => showcaseRef.current?.phase ?? 'live', []);
  /** A speed view is a demo surface: without a clip it plays the synthetic pitch instead of the file picker. */
  const speedOnly = SPEED_VIEW != null && !fileUrl;
  const clock: MediaClock | null = showcase ? vclock : (video ?? (mock || speedOnly ? vclock : null));
  const cs = useClockState(clock);

  // One shared speed store, fed from every real streamed call the background host makes.
  useEffect(() => attachSpeedTap(theatreSpeed), []);

  const openFile = useCallback((f: File | undefined | null) => {
    if (!f) return;
    setFileUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(f); });
    setFileName(f.name);
    // A loaded clip always starts with the perf chip off, even when the page URL carried ?perf=1
    // from a previous review pass. P / the Tools button turns it back on for this clip.
    setPerf(false);
  }, []);
  const setSource = useCallback((v: string) => {
    const q = new URLSearchParams(location.search);
    q.set('source', v);
    location.search = q.toString();   // reload with the new profile
  }, []);
  useEffect(() => {
    if (!video) return;
    void Promise.resolve(video.play()).catch(() => undefined);
  }, [video]);

  // race: second video follows the first
  useEffect(() => {
    if (!video || !video2) return;
    const id = setInterval(() => {
      video2.playbackRate = video.playbackRate;
      if (Math.abs(video2.currentTime - video.currentTime) > 0.12) video2.currentTime = video.currentTime;
      if (video.paused !== video2.paused) void (video.paused ? video2.pause() : Promise.resolve(video2.play()).catch(() => undefined));
    }, 100);
    return () => clearInterval(id);
  }, [video, video2]);

  // ----- sources -----
  // Mock (?mock=1 or the Mock button): scripted perception + scripted Kimi, fully offline.
  // Otherwise with a video: capture -> brain -> render engine, HUD line from the mock LLM provider via the lane runner.
  useEffect(() => {
    if (!ctl || !clock) return;
    ctl.hud.setPerfVisible(perf);
    // ?speed=... with no clip: the synthetic pitch is only a backdrop. No perception source, no scripted
    // HUD numbers; the wall and race still show real measurements (or an honest empty state).
    if (speedOnly && !mock) { ctl.setDirectorActive(false); return; }
    if (showcase) {
      const src = new ShowcaseSource({ clock, startAt: SHOWCASE_AT });
      showcaseRef.current = src;
      const prevAsk = ctl.hud.onAsk;
      ctl.hud.onAsk = (q) => { prevAsk?.(q); src.ask(q); };
      src.start(ctl);
      return () => { src.stop(); showcaseRef.current = null; ctl.hud.onAsk = prevAsk; };
    }
    if (mock || !video) {
      const src = new MockSource({ clock, variant: 'fast', race });
      src.start(ctl);
      const prevAsk = ctl.hud.onAsk;
      ctl.hud.onAsk = (q) => { prevAsk?.(q); src.ask(q); };
      const kimiLoad = new MockKimiLoad((s) => ctl.setKimiSpeed(s));
      kimiLoad.start();
      let cap: Capturer | null = null;
      let lastPerf = 0;
      if (video) {
        cap = new Capturer(video, src, 30, (s) => {
          const now = performance.now();
          if (now - lastPerf < 1000) return;
          lastPerf = now;
          ctl.message({ kind: 'perf', hz: s.hz || 7.8, device: 'capture + mock source', level: 3, eye: true, captureDropped: s.dropped });
        });
        cap.start();
      }
      return () => { src.stop(); cap?.stop(); kimiLoad.stop(); ctl.setKimiSpeed(null); ctl.hud.onAsk = prevAsk; };
    }
    const brain = connectBrain(SOURCE_KIND);
    // The display-rate cut detector runs ahead of the brain; this lets the tracker treat the cut as
    // hard on the next detection instead of waiting for its own scene histogram to commit.
    cutSink.current = (t) => brain.sendCut(t);
    const live = new LiveSource(brain, video);
    // Telegram bridge: only for the real live source, only when ?bridge=1 or the popup toggle is on.
    // The tap is synchronous and cheap; the client drops network work on failure and never throws here.
    let bridge: BridgeClient | null = null;
    const bridgeForced = flag('bridge');
    let bridgeWanted = bridgeForced;
    let bridgeOff: (() => void) | null = null;
    let lastBridgeEventT = -Infinity;
    let director: DirectorDriver | null = null;
    // Kimi's side chat: the commentary lane (a short line every few seconds) and pause-and-ask, both real Kimi calls.
    let commentary: CommentaryDriver | null = null;
    let prevAsk: typeof ctl.hud.onAsk = null;
    let askHooked = false;
    let cancelled = false;
    const attachBridge = (): void => {
      if (cancelled || bridge || !bridgeWanted) return;
      bridge = new BridgeClient({
        captureSnapshot: () => captureComposite(video, ctl.engine.canvas, ctl.engine.videoRect, video.currentTime),
        onCommand: (cmd) => director
          ? director.requestGraphic(cmd.graphic, cmd.targets, cmd.reason)
          : { accepted: false, reason: 'director is not ready yet' },
      });
      bridge.start();
    };
    const detachBridge = (): void => { bridge?.stop(); bridge = null; };
    bridgeOff = onBridgeEnabledChange((on) => {
      if (bridgeForced) return;
      bridgeWanted = on;
      if (on) attachBridge(); else detachBridge();
    });
    void getBridgeEnabled().then((on) => {
      if (cancelled) return;
      if (bridgeForced) { attachBridge(); return; }
      bridgeWanted = on;
      if (on) attachBridge();
    }).catch(() => undefined);

    // Renderer latency compensation follows the active profile. Explicit broadcast/game applies now;
    // auto starts at broadcast and follows the brain's resolution via onProfile.
    const applyExtrap = (p: SourceProfile): void => ctl.engine.setExtrap(p.extrapMaxS, p.extrapTau);
    if (SOURCE_KIND !== 'auto') applyExtrap(resolveProfile(SOURCE_KIND));
    live.onProfile = (p) => applyExtrap(resolveProfile(p));
    let recTimer: ReturnType<typeof setInterval> | null = null;
    if (RECORD && !SPEED_VIEW) {
      const lines: string[] = [];
      const rec = new SessionRecorder((l) => lines.push(l), {
        source: 'extension', maxFrames: 40_000,
        video: { name: fileName, w: video.videoWidth || undefined, h: video.videoHeight || undefined, durationS: Number.isFinite(video.duration) ? video.duration : undefined },
        meta: { note: 'recorded from the Theatre (?record=1)' },
      });
      recRef.current = { lines, rec };
      (window as unknown as Record<string, unknown>).__tlSession = () => `${lines.join('\n')}\n`;   // dev/verification hook
      setRecCount(0);
      live.onFrame = (f) => { if (!video.paused) rec.push(f); };
      recTimer = setInterval(() => setRecCount(rec.count), 500);
    }
    // Chain the bridge tap after the optional recorder so neither owns onFrame exclusively.
    const prevFrameTap = live.onFrame;
    live.onFrame = (f) => {
      prevFrameTap?.(f);
      if (!bridge) return;
      try {
        const fresh = live.measure.recent.filter((e) => e.t > lastBridgeEventT);
        if (fresh.length) lastBridgeEventT = Math.max(...fresh.map((e) => e.t));
        const lastKimi = [...ctl.hud.m.feed].reverse().find((it) => it.kind === 'kimi' && it.final && it.text.trim());
        const lineAgeS = lastKimi ? performance.now() / 1000 - lastKimi.at : Infinity;
        const commentary = lastKimi && lineAgeS <= 15
          ? { text: jerseyText(lastKimi.text, ctl.hud.m).replace(/\[\[\d*\]?\]?/g, '').replace(/\s{2,}/g, ' ').trim(), t: f.t }
          : null;
        bridge.onState(buildBridgeState(f, live.measure.last?.match ?? null, {
          paused: video.paused,
          events: fresh,
          facts: live.measure.last?.detail.facts,
          teamLabels: ctl.teamLabels,
          teamColours: ctl.teamColours ?? undefined,
          commentary,
        }));
      } catch { /* the bridge must never break perception */ }
    };
    // Kimi is the director: rules keep computing facts but stop firing callouts/graphics on their own.
    // The scripted ?mock=1 source above stays the offline rules-driven fallback.
    live.measure.rulesEnabled = false;
    ctl.setDirectorActive(true);
    live.start(ctl);
    void getSettings().then((s) => {
      if (cancelled) return;
      // ?kimi=off: perception only (debug/measurement). ?watch=off: director without the vision lane.
      if (params.get('kimi') === 'off') { live.measure.rulesEnabled = true; ctl.setDirectorActive(false); return; }
      const preset = params.get('preset') === 'mock' ? 'mock' : s.preset;
      director = new DirectorDriver({ controller: ctl, clock: video, source: live, preset, mockProfile: s.mockProfile, kimiModel: s.kimiModel, watch: params.get('watch') === 'on' });   // the vision lane (an annotated JPEG every ~2.5 s) is opt-in: it is the heaviest token spender
      director.start();
      // ?commentary=off: no chat commentary lane (and no ask handler), for debugging the director alone.
      if (params.get('commentary') !== 'off') {
        const cm = new CommentaryDriver({ controller: ctl, clock: video, video, source: live, preset, kimiModel: s.kimiModel, budget: director.budget });
        commentary = cm;
        cm.start();
        prevAsk = ctl.hud.onAsk;
        askHooked = true;
        ctl.hud.onAsk = (q) => { prevAsk?.(q); void cm.ask(q); };
      }
    }).catch(() => {
      // Settings unavailable: fall back to the honest rules layer rather than a blank overlay.
      live.measure.rulesEnabled = true;
      ctl.setDirectorActive(false);
    });
    const cap = new Capturer(video, live, 60, (s) => { live.captureDropped = s.dropped; });
    (window as unknown as Record<string, unknown>).__tlDebug = { cap, live, video };   // dev/verification hook
    setBrainMsg('Loading perception models...');
    brain.ready.then(() => { setBrainMsg(''); cap.start(); },
      (e: Error) => setBrainMsg(`Perception unavailable: ${e.message}`));
    return () => {
      cancelled = true; cutSink.current = null;
      bridgeOff?.();
      detachBridge();
      live.onFrame = prevFrameTap;
      commentary?.stop();
      if (askHooked) ctl.hud.onAsk = prevAsk;
      director?.stop(); cap.stop(); live.stop(); brain.stop(); setBrainMsg('');
      if (recTimer) clearInterval(recTimer);
    };
  }, [ctl, clock, race, video, mock, showcase, speedOnly]);

  const saveSession = useCallback(() => {
    const r = recRef.current;
    if (!r || !r.rec.count) return;
    const blob = new Blob([`${r.lines.join('\n')}\n`], { type: 'application/x-ndjson' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(fileName || 'session').replace(/\.[^.]+$/, '')}.jsonl`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, [fileName]);

  useEffect(() => {
    if (!ctl2 || !clock || !race) return;
    const src = new MockSource({ clock, variant: 'slow', race: true });
    src.start(ctl2);
    return () => src.stop();
  }, [ctl2, clock, race]);
  useEffect(() => { ctl?.hud.setPerfVisible(perf); ctl2?.hud.setPerfVisible(perf); }, [ctl, ctl2, perf]);

  // ask ends when the viewer presses play
  useEffect(() => { if (!cs.paused) { ctl?.askDone(); ctl2?.askDone(); } }, [cs.paused, ctl, ctl2]);

  // ----- keyboard, fullscreen, idle -----
  const toggle = useCallback(() => { if (!clock) return; if (clock.paused) void clock.play(); else clock.pause(); }, [clock]);
  const toggleFs = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      else if (e.key === 'f') toggleFs();
      else if (e.key === 's') setBigHud((v) => !v);
      else if (e.key === 'g') { setShowcase((v) => !v); setClean(true); }
      else if (e.key === 'p') setPerf((v) => !v);
      else if (e.key === 'h') setClean((v) => !v);
      else if (e.key === 'ArrowRight' && clock) clock.currentTime = clock.currentTime + 5;
      else if (e.key === 'ArrowLeft' && clock) clock.currentTime = Math.max(0, clock.currentTime - 5);
      else if (e.key === ']' && clock) clock.playbackRate = Math.min(4, clock.playbackRate * 2);
      else if (e.key === '[' && clock) clock.playbackRate = Math.max(0.25, clock.playbackRate / 2);
    };
    const onFs = (): void => setFs(!!document.fullscreenElement);
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFs);
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('fullscreenchange', onFs); };
  }, [clock, toggle, toggleFs]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const wake = (): void => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 2200); };
    window.addEventListener('pointermove', wake);
    wake();
    return () => { window.removeEventListener('pointermove', wake); clearTimeout(t); };
  }, []);

  const hud1 = useHud(ctl?.hud ?? EMPTY_STORE());
  const hud2 = useHud(ctl2?.hud ?? EMPTY_STORE());
  const chromeHidden = clean || (fs && idle) || CLEAN_RECORD;
  const showSpeed = !(mock && SPEED_VIEW == null);
  const compactSpeed = SPEED_VIEW == null || SPEED_VIEW === 'compact';
  const landing = !clock;

  const onDrop = (e: DragEvent): void => {
    e.preventDefault(); setDrag(false);
    openFile(e.dataTransfer?.files?.[0]);
  };

  return (
    <div
      ref={rootRef} class="th-root" data-hidden={chromeHidden} data-fs={fs}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
    >
      <header class="th-bar">
        <div class="th-brand"><span class="th-logo">T</span><b>TacticLens</b><span class="th-sub">Theatre</span></div>
        <div class="th-sp" />
        <button class="pri" onClick={() => fileRef.current?.click()}>Open video</button>
        <input ref={fileRef} type="file" accept="video/*" hidden onChange={(e) => openFile((e.target as HTMLInputElement).files?.[0])} />
        <button data-on={toolsOpen} aria-expanded={toolsOpen} onClick={() => setToolsOpen((v) => !v)} title="Demo and dev tools">Tools</button>
        <button onClick={() => setClean((v) => !v)} title="Hide the controls for recording (H)">Hide UI</button>
        <button onClick={toggleFs} title="Fullscreen (F)">{fs ? 'Exit full' : 'Fullscreen'}</button>
      </header>

      {toolsOpen && (
        <div class="th-tools">
          <select value={SOURCE_KIND} onChange={(e) => setSource((e.target as HTMLSelectElement).value)} aria-label="Source" title="Footage type: broadcast or game">
            <option value="broadcast">Broadcast</option>
            <option value="game">Game</option>
            <option value="auto">Auto</option>
          </select>
          <button data-on={mock} onClick={() => setMock((v) => !v)} title="Offline mock: scripted overlay data">Mock</button>
          <button data-on={race} disabled={!clock} onClick={() => setRace((v) => !v)}>Race</button>
          <button data-on={showcase} onClick={() => { setShowcase((v) => !v); setClean(true); }} title="30 s recording sequence (G)">Showcase</button>
          <button data-on={bigHud} onClick={() => setBigHud((v) => !v)} title="1.4x HUD for recording (S)">Big HUD</button>
          <button data-on={perf} onClick={() => setPerf((v) => !v)} title="Perf chip (P)">Perf</button>
          <button data-on={demoOpen} disabled={!mock} onClick={() => setDemoOpen((v) => !v)}>Demo states</button>
          {RECORD && !mock && <button data-on={recCount > 0} disabled={!recCount} onClick={saveSession} title="Download the recorded session (JSONL) for pnpm replay">{`Save session (${recCount} frames)`}</button>}
          <a class="th-btn" href="?gallery=1">Gallery</a>
        </div>
      )}

      {demoOpen && mock && clock && (
        <div class="th-demo">
          {JUMPS.map(([l, t]) => <button key={l} onClick={() => { clock.currentTime = t; void clock.play(); }}>{l}</button>)}
          <button onClick={() => { clock.pause(); }}>Pause (ask bar)</button>
        </div>
      )}

      {brainMsg && <div class="th-brainmsg">{brainMsg}</div>}

      <main class="th-main">
        {landing ? (
          <div class="th-landing" data-drag={drag}>
            <div class="th-drop">
              <h1>Drop a football clip here</h1>
              <p>Kimi watches the match and talks you through it in a live side chat. Nothing is uploaded; frames stay in this tab.</p>
              <div class="th-row">
                <button class="pri" onClick={() => fileRef.current?.click()}>Choose a video</button>
                <button onClick={() => setMock(true)}>Run the offline demo</button>
                <button onClick={() => { setShowcase(true); setClean(true); }}>Play the 30 s showcase</button>
              </div>
              <p class="th-hint">Shortcuts: Space play/pause, F fullscreen, G showcase, S big HUD, P perf chip, H hide controls, [ ] speed</p>
            </div>
          </div>
        ) : (
          <div class={`th-stages ${race ? 'race' : ''}`}>
            <div class="th-pane">
              {/* Real measured speed. A bare ?mock=1 theatre is the scripted-overlay demo, so it opts out.
                  The compact card lives INSIDE the HUD layer (the video rectangle), so it stacks exactly under the team
                  guide even when the picture is letterboxed; the full wall / race / burst views keep the pane-wide layer. */}
              <Stage
                clock={clock} video={showcase ? null : video} showcase={showcase || bigHud} hudVariant="feed"
                mockPhase={showcase ? showcasePhase : undefined} onController={setCtl} onCut={handleCut}
                overlay={showSpeed && compactSpeed ? <SpeedDemo store={theatreSpeed} hideControls={chromeHidden} showStats={perf} /> : undefined}
              />
              {showSpeed && !compactSpeed && (
                <div class="th-speed"><SpeedDemo store={theatreSpeed} hideControls={chromeHidden} showStats={perf} /></div>
              )}
            </div>
            {race && (
              <div class="th-pane">
                <Stage clock={clock} video={video2} showcase={showcase || bigHud} hudVariant="feed" onController={setCtl2} />
              </div>
            )}
          </div>
        )}
        {drag && <div class="th-dropveil">Drop to play</div>}
      </main>

      {race && <RaceFooter left={hud1} right={hud2} />}

      {!landing && (
        <footer class="th-controls">
          <button class="th-play" onClick={toggle} aria-label={cs.paused ? 'Play' : 'Pause'}>
            {cs.paused ? <svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z" /></svg> : <svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></svg>}
          </button>
          <span class="th-time">{fmtTime(cs.t)}</span>
          <input
            class="th-seek" type="range" min="0" max={Math.max(1, cs.dur || 1)} step="0.05" value={cs.t}
            onInput={(e) => { if (clock) clock.currentTime = Number((e.target as HTMLInputElement).value); }} aria-label="Seek"
          />
          <span class="th-time">{fmtTime(cs.dur)}</span>
          <select value={String(cs.rate)} onChange={(e) => { if (clock) clock.playbackRate = Number((e.target as HTMLSelectElement).value); }} aria-label="Speed">
            {[0.5, 1, 1.5, 2].map((r) => <option key={r} value={String(r)}>{r}x</option>)}
          </select>
          <span class="th-name">{fileName || (mock ? 'Offline mock' : '')}</span>
        </footer>
      )}
    </div>
  );
}

let empty: HudStore | null = null;
function EMPTY_STORE(): HudStore { return (empty ??= new HudStore()); }
