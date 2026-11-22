// A stage = media (video or synthetic stadium) + world canvas + HUD, sized by the video's
// letterboxed rectangle. The offline feed draws the same mock world the overlay consumes.
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { OverlayController, type ControllerOpts } from '../lib/render/controller';
import { VideoCutMonitor } from '../lib/render/cut-monitor';
import { onFrame, injectCss } from '../lib/render/loop';
import { clamp } from '../lib/render/math';
import { GLASS } from '../lib/render/tokens';
import type { MediaClock } from '../lib/video';
import { Hud, type HudVariant } from './Hud';
import { HUD_CSS } from './hud-css';
import { downgradeGlassToLite, glassQuality, initGlass } from './glass';
import { createMockPitch, type MockPhaseMode, type MockPitch } from './MockPitch';

export interface StageProps {
  clock: MediaClock;
  /** Real video element, or omit for the synthetic stadium feed. */
  video?: HTMLVideoElement | null;
  controllerOpts?: ControllerOpts;
  forceTier?: 'full' | 'mid' | 'narrow';
  showcase?: boolean;
  /** Review surfaces (the gallery) render many stages: never let one cell downgrade the page. */
  pinGlass?: boolean;
  onController?: (c: OverlayController) => void;
  /** Renderer-side camera cut (display-rate detector). Media time of the cut frame. */
  onCut?: (mediaTime: number, reason: 'hard' | 'seek') => void;
  class?: string;
  style?: string;
  /** Gallery: draw the backdrop dimmer so overlays read. */
  label?: string;
  /** Showcase: keep the synthetic feed in the same phase as the scripted overlay. */
  mockPhase?: () => MockPhaseMode;
  /** 'feed' = Theatre layout (rolling Kimi side chat, big stat cards, no team plates / possession bar). */
  hudVariant?: HudVariant;
  /** Rendered inside the HUD layer (the video rectangle), after the HUD, so it shares the HUD's reference box. */
  overlay?: ComponentChildren;
}

const PITCH_W = 1280, PITCH_H = 720;

export function Stage(props: StageProps): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const pitchRef = useRef<MockPitch | null>(null);
  const [ctl, setCtl] = useState<OverlayController | null>(null);
  const [tier, setTier] = useState<'full' | 'mid' | 'narrow'>('full');

  useEffect(() => {
    injectCss(HUD_CSS);
    initGlass();
    const canvas = canvasRef.current, slot = slotRef.current;
    if (!canvas || !slot) return;
    const c = new OverlayController(canvas, props.clock, props.controllerOpts);
    if (props.forceTier) c.forcedTier = props.forceTier;
    setCtl(c);
    (window as unknown as { __tl?: OverlayController[] }).__tl = [...((window as unknown as { __tl?: OverlayController[] }).__tl ?? []), c]; // debug handle
    props.onController?.(c);
    return () => { c.dispose(); setCtl(null); };
    // controller is created once per mounted stage
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.clock]);

  // media element mounting
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    slot.replaceChildren();
    pitchRef.current = null;
    if (props.video) {
      props.video.classList.add('tl-media');
      slot.append(props.video);
    } else {
      const pitch = createMockPitch(props.clock, { phase: props.mockPhase });
      pitchRef.current = pitch;
      slot.append(pitch.canvas);
    }
  }, [props.video, props.clock, props.mockPhase]);

  // layout + frame loop
  useEffect(() => {
    if (!ctl) return;
    const stage = stageRef.current, hud = hudRef.current;
    if (!stage || !hud) return;
    const v = props.video;
    // Display-rate cut detector: snaps the old shot's markers on the cut frame itself and tells the
    // brain through onCut, instead of waiting for the next detection cycle.
    const cutMon = v ? new VideoCutMonitor(v, (mediaTime, reason) => {
      ctl.engine.cut(performance.now() / 1000, mediaTime, reason === 'seek' ? 'seek' : 'detector');
      props.onCut?.(mediaTime, reason);
    }) : null;
    cutMon?.start();
    const layout = (): void => {
      const w = stage.clientWidth, h = stage.clientHeight;
      if (w <= 0 || h <= 0) return;
      const vw = v && v.videoWidth ? v.videoWidth : PITCH_W;
      const vh = v && v.videoHeight ? v.videoHeight : PITCH_H;
      // A portrait pane behaves like a phone player: cover-crop the picture, fill the screen with HUD.
      const fit: 'contain' | 'cover' = h > w * 1.02 ? 'cover' : 'contain';
      ctl.setShowcase(!!props.showcase);
      ctl.layout(w, h, vw, vh, window.devicePixelRatio || 1, fit);
      const r = ctl.engine.videoRect;
      const hx = fit === 'cover' ? 0 : r.x, hy = fit === 'cover' ? 0 : r.y;
      const hw = fit === 'cover' ? w : r.w, hh = fit === 'cover' ? h : r.h;
      hud.style.left = `${hx}px`; hud.style.top = `${hy}px`; hud.style.width = `${hw}px`; hud.style.height = `${hh}px`;
      hud.style.setProperty('--fs', `${(clamp((hw / 1280) * 14, 11, 22) * (props.showcase ? 1.4 : 1)).toFixed(2)}px`);
      stage.dataset.fit = fit;
      setTier(ctl.hud.m.tier);
    };
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(stage);
    v?.addEventListener('loadedmetadata', layout);
    v?.addEventListener('resize', layout);
    let lastT = 0, fps = 60, lastReport = 0;
    // Glass quality guard: if the render loop is over the same 4 ms budget the perf chip
    // flags (or frame pacing slips), drop the SVG refraction for the rest of the session.
    let probeAt = 0, overFor = 0;
    const off = onFrame((t) => {
      const dt = lastT ? t - lastT : 0.016;
      lastT = t;
      if (dt > 0.002 && dt < 0.25) fps = fps * 0.9 + (1 / dt) * 0.1;
      pitchRef.current?.tick(t);
      ctl.frame(t);
      if (!props.pinGlass && glassQuality() === 'high' && t - probeAt > 0.5) {
        const step = probeAt ? t - probeAt : 0;
        probeAt = t;
        const struggling = ctl.engine.stats.avgMs > GLASS.budgetMs;
        overFor = struggling ? overFor + step : 0;
        if (overFor >= GLASS.downgradeAfterS) downgradeGlassToLite();
      }
      if (t - lastReport > 0.42) {
        lastReport = t;
        ctl.hud.setRenderStats(ctl.engine.stats.avgMs, fps);
      }
    });
    return () => { cutMon?.stop(); ro.disconnect(); v?.removeEventListener('loadedmetadata', layout); v?.removeEventListener('resize', layout); off(); };
  }, [ctl, props.video, props.showcase, props.forceTier, props.pinGlass, props.onCut]);

  return (
    <div ref={stageRef} class={`tl-stage ${props.class ?? ''}`} style={props.style} data-showcase={!!props.showcase}>
      <div ref={slotRef} style={{ position: 'absolute', inset: 0 }} />
      <canvas ref={canvasRef} class="tl-world" />
      <div ref={hudRef} class="tl-hud" data-tier={tier}>{ctl && <Hud store={ctl.hud} variant={props.hudVariant} />}{props.overlay}</div>
    </div>
  );
}
