// Cut-aware timing for the calm player markers. Kept separate from the engine so the three rules that
// matter (stale fade, fast-spawn window, normal window) are testable without a canvas:
//  - a cut snaps every current marker out in <= D.snap (80 ms); the engine does the snap, this owns
//    the duration and the "no coasting" guarantee;
//  - for fastSpawnAfterCutS after a cut, a track only needs fastSpawnAgeS and a 120 ms fade-in, so
//    the new shot is populated in ~0.3-0.4 s instead of ~1.3 s;
//  - outside that window the strict playerAgeS / markerFadeInS rule returns, which is what keeps
//    normal play free of flicker.
import { CALM_CONFIG } from './calm';
import { D, RULES } from './tokens';

export type CutSource = 'detector' | 'brain' | 'seek' | 'clear';

export interface CutInfo {
  /** All cut-ish events (detector hard cuts, seeks, brain cuts, scene clears). */
  count: number;
  /** Renderer-side hard cuts only (the ?perf=1 detail line shows this separately). */
  detector: number;
  /** Wall time of the last cut, seconds (performance.now()/1000 scale). */
  lastAt: number;
  /** Media time of the last cut; -Infinity until one is known. */
  lastMedia: number;
  lastSource: CutSource | null;
}

export class MarkerCutPolicy {
  /** Wall time of the last cut; the calm gate and the marker layer read this. */
  cutAt = -Infinity;
  /** Media time of the last cut, used to reject snapshots produced before the new shot. */
  cutMedia = -Infinity;
  /** A cut has already snapped the old markers, so this is a hard 80 ms upper bound. */
  readonly staleFadeS = D.snap;

  private total = 0;
  private detector = 0;
  private lastSource: CutSource | null = null;

  noteCut(now: number, mediaTime?: number, source: CutSource = 'brain'): void {
    this.cutAt = now;
    if (mediaTime !== undefined && Number.isFinite(mediaTime)) this.cutMedia = mediaTime;
    this.total++;
    if (source === 'detector') this.detector++;
    this.lastSource = source;
  }

  /** The brain acknowledged a cut with a FrameState: make its media time authoritative. */
  noteMedia(mediaTime: number): void {
    if (Number.isFinite(mediaTime)) this.cutMedia = mediaTime;
  }

  get info(): CutInfo {
    return { count: this.total, detector: this.detector, lastAt: this.cutAt, lastMedia: this.cutMedia, lastSource: this.lastSource };
  }

  /** Inside the new-shot window? Then the looser spawn rule applies. */
  fastSpawn(now: number): boolean {
    return now - this.cutAt < CALM_CONFIG.fastSpawnAfterCutS;
  }

  /** Track age needed before a marker may be born (normal vs new-shot window). */
  minAgeS(now: number): number {
    return this.fastSpawn(now) ? CALM_CONFIG.fastSpawnAgeS : CALM_CONFIG.playerAgeS;
  }

  /** Anchor "on" age. Never later than the normal 0.3 s track birth rule. */
  birthAgeS(now: number): number {
    return this.fastSpawn(now) ? Math.min(RULES.trackBirth, CALM_CONFIG.fastSpawnAgeS) : RULES.trackBirth;
  }

  /** Marker opacity ramp; the new-shot window is deliberately quicker. */
  fadeInS(now: number): number {
    return this.fastSpawn(now) ? CALM_CONFIG.fastSpawnFadeInS : CALM_CONFIG.markerFadeInS;
  }

  /** Whole-layer target: hidden during a fast pan, and for the first frame after a cut. */
  layerTarget(now: number, pan: boolean): 0 | 1 {
    return pan || now - this.cutAt < CALM_CONFIG.markerAfterCutS ? 0 : 1;
  }
}
