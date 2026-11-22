// Wires the pure CutDetector to a real <video>: one tiny 32x18 readback per presented frame.
// requestVideoFrameCallback fires exactly once per decoded frame (including seeks); rAF is the fallback
// when the browser does not expose it. Pausing is not a cut: no new frame is presented, and a repeated
// media time is ignored by the detector. A seek is a cut even while paused, via the `seeked` event.
import { CUT_H, CUT_W, CutDetector, type CutReason } from './cut';

export interface CutMonitorStats {
  frames: number;
  cuts: number;
  /** Last sample cost (drawImage + getImageData + histogram), ms. */
  lastMs: number;
  /** EMA of the sample cost, ms. */
  avgMs: number;
}

export type CutSink = (mediaTime: number, reason: Exclude<CutReason, null>) => void;

export class VideoCutMonitor {
  readonly stats: CutMonitorStats = { frames: 0, cuts: 0, lastMs: 0, avgMs: 0 };
  private readonly detector = new CutDetector();
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly onSeeked = (): void => this.seek();
  private running = false;
  private handle: number | null = null;
  private raf = 0;

  constructor(private readonly video: HTMLVideoElement, private readonly sink: CutSink) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CUT_W;
    this.canvas.height = CUT_H;
    this.ctx = this.canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  }

  get isRunning(): boolean { return this.running; }

  start(): void {
    if (this.running || !this.ctx) return;
    this.running = true;
    this.video.addEventListener('seeked', this.onSeeked);
    this.arm();
  }

  stop(): void {
    this.running = false;
    this.video.removeEventListener('seeked', this.onSeeked);
    if (this.handle !== null) {
      this.video.cancelVideoFrameCallback?.(this.handle);
      this.handle = null;
    }
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private arm(): void {
    if (!this.running) return;
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      this.handle = this.video.requestVideoFrameCallback((_now, meta) => {
        this.handle = null;
        this.sample(meta.mediaTime);
        this.arm();
      });
    } else {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.sample(this.video.currentTime);
        this.arm();
      });
    }
  }

  private sample(mediaTime: number): void {
    const v = this.video, ctx = this.ctx;
    if (!this.running || !ctx || v.readyState < 2 || v.videoWidth <= 0) return;
    const t0 = performance.now();
    let reading;
    try {
      ctx.drawImage(v, 0, 0, CUT_W, CUT_H);
      const { data } = ctx.getImageData(0, 0, CUT_W, CUT_H);
      reading = this.detector.push(data, mediaTime);
    } catch (e) {
      // DRM or tainted media: the overlay keeps working without the renderer-side cut hint.
      console.warn('[TacticLens] cut detector disabled', e);
      this.stop();
      return;
    }
    const ms = performance.now() - t0;
    const s = this.stats;
    s.frames++;
    s.lastMs = ms;
    s.avgMs = s.avgMs ? s.avgMs * 0.95 + ms * 0.05 : ms;
    if (reading.cut) {
      s.cuts++;
      this.sink(mediaTime, reading.reason ?? 'hard');
    }
  }

  private seek(): void {
    if (!this.running || this.stats.frames === 0) return;
    // A paused scrub presents no frame callback, so force the cut here; the next frame is the baseline.
    const r = this.detector.forceSeek(this.video.currentTime);
    if (r.cut) {
      this.stats.cuts++;
      this.sink(r.mediaTime, 'seek');
    }
  }
}
