// Glue: one overlay = engine (canvas, 60 fps) + HUD store (DOM). Sources push into it; the stage ticks it.
import { displayKitPair, type DirectorLogEntry, type KimiSpeedSnapshot, type Liveness, type OverlaySnapshot } from '@tacticlens/core';
import { OverlayEngine, type EngineClock } from './engine';
import { HudStore } from './hud-store';
import { KitColourTracker } from './kit';
import { TeamColourResolver, type ColourSetting } from './team-colour';
import { RULES } from './tokens';
import type { SourceSink, UiMessage, ViewState } from './ui-types';

export interface ControllerOpts {
  /** Gallery cells: do not turn a frozen clock into the PAUSED state. */
  ignorePause?: boolean;
  onAsk?: (q: string) => void;
  /** Video filename/URL: selects a hardcoded clip colour table when it matches, else perception wins. */
  sourceName?: string | null;
}

export class OverlayController implements SourceSink {
  readonly engine: OverlayEngine;
  readonly hud: HudStore;
  private clock: EngineClock;
  private opts: ControllerOpts;
  private snap: OverlaySnapshot | null = null;
  private askActive = false;
  private ballOut = false;
  private ballVisibleSince = 0;
  private state: ViewState = 'OFF';
  private kit = new KitColourTracker();
  private colours = new TeamColourResolver();
  private lastColour: ColourSetting | null = null;
  private perfBase = '';
  private lastCalmReport = 0;
  /** Gallery/forced override of the liveness coming from the snapshot. */
  forceState: ViewState | null = null;

  constructor(canvas: HTMLCanvasElement, clock: EngineClock, opts: ControllerOpts = {}) {
    this.clock = clock;
    this.opts = opts;
    this.colours.setSource(opts.sourceName ?? null);
    this.engine = new OverlayEngine(canvas, clock);
    this.hud = new HudStore();
    // Dev/verification: ?players=all keeps the old every-player layer for comparison.
    try {
      this.engine.setPlayersAll(new URLSearchParams(location.search).get('players') === 'all');
    } catch { /* non-browser hosts */ }
    this.hud.onMention = (ids) => this.engine.pulse(ids);
    this.hud.onAsk = (q) => {
      this.askActive = true;
      this.recompute();
      this.opts.onAsk?.(q);
    };
  }

  dispose(): void { this.hud.dispose(); }

  /** Change the source identity without rebuilding the controller (a new clip resets the colour blend). */
  setSourceName(name: string | null | undefined): void {
    const next = name ?? null;
    if (this.colours.source === next) return;
    this.colours.setSource(next);
    this.kit.reset();
    this.lastColour = null;
  }

  /** The last resolved colour setting; clip overrides are visible here before the HUD has repainted. */
  get colourSetting(): ColourSetting | null { return this.lastColour; }

  /** Raw kit colours for prompts/frames/bridge; hardcoded clip values already applied. */
  get teamColours(): { A: string; B: string } | null {
    return this.lastColour ? { A: this.lastColour.raw.A, B: this.lastColour.raw.B } : null;
  }

  /**
   * The locked, display-mapped pair. The director's match block uses this so a noisy raw measurement
   * cannot rewrite the cached lane prefix every call.
   */
  get displayTeamColours(): { A: string; B: string } | null {
    const k = this.kit.current;
    return k ? { A: k.A.fill, B: k.B.fill } : null;
  }

  /** Colour words shared by the HUD, Kimi prompts and Telegram; clip labels win, else the HUD's words. */
  get jerseyNames(): { A: string; B: string } {
    return this.lastColour?.names ?? this.hud.m.jersey;
  }

  /** "Team White" / "Team Blue" style labels for the bridge and Telegram. */
  get teamLabels(): { A: string; B: string } {
    const names = this.jerseyNames;
    return { A: `Team ${names.A}`, B: `Team ${names.B}` };
  }

  snapshot(s: OverlaySnapshot): void {
    const now = performance.now() / 1000;
    this.snap = s;
    if (s.cut) this.engine.cut(now);
    const b = s.ball;
    if (b.state === 'absent' && b.coastingS >= RULES.ballOutAfter) { this.ballOut = true; this.ballVisibleSince = 0; }
    else if (b.state === 'visible' && b.xy) {
      if (!this.ballVisibleSince) this.ballVisibleSince = now;
      if (this.ballOut && now - this.ballVisibleSince >= RULES.ballBackAfter) this.ballOut = false;
    } else this.ballVisibleSince = 0;
    // One common colour setting: a known clip's hardcoded kit wins; otherwise the measured pair does.
    // The scorebug read is only a fallback when the teams fit has nothing.
    this.lastColour = this.colours.resolve(s.teamColours, s.match.scout?.kitColours ?? null);
    const raw = this.lastColour
      ? { A: this.lastColour.raw.A, B: this.lastColour.raw.B, confidence: this.lastColour.confidence }
      : undefined;
    const kits = this.kit.update(raw, s.teamsCalibrated, now)
      ?? (s.match.scout ? displayKitPair(s.match.scout.kitColours.A, s.match.scout.kitColours.B) : null);
    if (kits) {
      this.engine.setKit(kits.A.fill, kits.B.fill, kits.A.edge, kits.B.edge);
      this.hud.setKit(kits.A.fill, kits.B.fill, kits.A.edge, kits.B.edge, this.lastColour?.names ?? undefined);
    }
    this.engine.setSnapshot(s, now);
    this.hud.setSnapshot(s, now);
    this.recompute();
  }

  message(m: UiMessage): void {
    const now = performance.now() / 1000;
    switch (m.kind) {
      case 'intent': this.engine.intent(m.intent, now); break;
      case 'clear': this.engine.clear(m.id, now); break;
      case 'prediction': this.engine.setPrediction(m.prediction, now); this.hud.message(m, now); break;
      case 'lag': this.engine.setLag(m.id, m.ballXY, m.lateS); break;
      case 'perf':
        this.engine.setQuality(m.level);
        // Calm lives in the renderer; keep the detector's detail and append the gate state below.
        this.perfBase = m.detail ?? '';
        this.hud.message(m, now);
        this.hud.setPerfDetail(this.perfText());
        break;
      default: this.hud.message(m, now);
    }
  }

  /** Called by the stage when the pane resizes. */
  layout(cssW: number, cssH: number, vw: number, vh: number, dpr: number, fit: 'contain' | 'cover' = 'contain'): void {
    const tier = this.rectW(cssW, cssH, vw, vh) >= 960 ? 'full' : this.rectW(cssW, cssH, vw, vh) >= 600 ? 'mid' : 'narrow';
    const showcase = this.hud.m.showcase;
    this.engine.setLayout(cssW, cssH, vw, vh, dpr, this.forcedTier ?? tier, showcase, fit);
    this.hud.setLayout(this.forcedTier ?? tier, showcase);
    this.lastLayout = [cssW, cssH, vw, vh, dpr, fit === 'cover' ? 1 : 0];
  }
  forcedTier: 'full' | 'mid' | 'narrow' | null = null;
  private lastLayout: [number, number, number, number, number, number] | null = null;

  setShowcase(on: boolean): void {
    this.hud.setLayout(this.hud.m.tier, on);
    const l = this.lastLayout;
    if (l) this.engine.setLayout(l[0], l[1], l[2], l[3], l[4], this.hud.m.tier, on, l[5] ? 'cover' : 'contain');
  }

  private rectW(cw: number, ch: number, vw: number, vh: number): number {
    return vw > 0 && vh > 0 ? Math.min(cw, (ch * vw) / vh) : cw;
  }

  askDone(): void { this.askActive = false; this.recompute(); }
  cut(): void { this.engine.cut(); }

  /** Kimi is the director: heavy graphics keep the calm checks but drop the fixed 8 s gap. */
  setDirectorActive(v: boolean): void { this.engine.setDirectorActive(v); }

  /** Current calm admission, passed to the director payload. */
  calmInfo(): { ready: boolean; reason: string } {
    return { ready: this.engine.calmReady, reason: this.engine.calmReason };
  }

  /** Live Kimi speed counter. */
  setKimiSpeed(speed: KimiSpeedSnapshot | null): void {
    this.hud.message({ kind: 'kimi_speed', speed }, performance.now() / 1000);
  }

  /** Last director decisions for ?perf=1. */
  setDirectorLog(log: DirectorLogEntry[]): void {
    this.hud.message({ kind: 'director', log }, performance.now() / 1000);
  }

  private effective(): ViewState {
    if (this.forceState) return this.forceState;
    const base: Liveness | 'OFF' = this.snap?.liveness ?? 'OFF';
    if (this.askActive) return 'ASK';
    const paused = !this.opts.ignorePause && this.clock.paused;
    if (paused && (base === 'LIVE' || base === 'REPLAY' || base === 'CLOSE_UP' || base === 'CALIBRATING')) return 'PAUSED';
    return base;
  }

  private recompute(): void {
    const next = this.effective();
    if (next !== this.state) {
      const prev = this.state;
      this.state = next;
      if (this.askActive && next !== 'ASK' && next !== 'PAUSED') this.askActive = false;
      this.engine.setState(next);
      if ((prev === 'ASK' || prev === 'PAUSED') && next !== 'ASK' && next !== 'PAUSED') {
        const l = this.hud.m.line;
        if (l && l.lane === 'ask') this.hud.clearLine();
      }
    }
    this.engine.setBallOut(this.ballOut);
    this.hud.setState(this.state, this.ballOut);
  }

  /** ?perf=1 detail: detector/app detail plus the live calm state from the renderer. */
  private perfText(): string {
    return [this.perfBase, this.engine.calmDetail].filter(Boolean).join(' / ');
  }

  frame(now: number): void {
    // pause / resume is polled: it is a property of the player, not of a snapshot
    if (!this.opts.ignorePause) {
      const paused = this.clock.paused;
      if (!paused && this.askActive) this.askActive = false;
      this.recompute();
    }
    this.engine.frame(now);
    if (this.hud.m.showPerf && now - this.lastCalmReport >= 0.5) {
      this.lastCalmReport = now;
      this.hud.setPerfDetail(this.perfText());
    }
  }
}
