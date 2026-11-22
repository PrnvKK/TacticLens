// Capture loop: one native-resolution ImageBitmap per cycle, with back-pressure.
// If the source has not acked the previous frame, this frame is dropped (never queued).
import type { PerceptionMeta, PerceptionSource } from './render/ui-types';

export interface CaptureStats { sent: number; dropped: number; hz: number; lastMs: number }

export class Capturer {
  private inFlight = false;
  private stopped = true;
  private handle: number | null = null;
  private frameIdx = 0;
  private lastSent = 0;
  private win: number[] = [];
  readonly stats: CaptureStats = { sent: 0, dropped: 0, hz: 0, lastMs: 0 };

  /** maxHz caps the capture rate; the real limit is the source's ack. 60 = no extra throttle. */
  constructor(private video: HTMLVideoElement, private source: PerceptionSource, private maxHz = 60, private onStats?: (s: CaptureStats) => void) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.arm();
  }
  stop(): void {
    this.stopped = true;
    if (this.handle !== null && 'cancelVideoFrameCallback' in this.video) this.video.cancelVideoFrameCallback(this.handle);
    this.handle = null;
  }

  private arm(): void {
    if (this.stopped) return;
    if ('requestVideoFrameCallback' in this.video) {
      this.handle = this.video.requestVideoFrameCallback((_now, meta) => { void this.onFrame(meta.mediaTime); this.arm(); });
    } else {
      this.handle = window.setTimeout(() => { void this.onFrame(this.video.currentTime); this.arm(); }, 1000 / this.maxHz) as unknown as number;
    }
  }

  private async onFrame(mediaTime: number): Promise<void> {
    const v = this.video;
    const now = performance.now();
    if (v.readyState < 2 || v.videoWidth === 0) return;
    if (this.inFlight || now - this.lastSent < 1000 / this.maxHz) {
      if (this.inFlight) { this.stats.dropped++; this.onStats?.(this.stats); }
      return;
    }
    this.inFlight = true;
    this.lastSent = now;
    try {
      const bmp = await createImageBitmap(v); // native resolution: the brain makes the letterbox, crop and JPEG
      const meta: PerceptionMeta = { tMedia: mediaTime, playbackRate: v.playbackRate, frameIdx: this.frameIdx++ };
      if (this.source.process) await this.source.process(bmp, meta);
      else bmp.close();
      this.stats.sent++;
      const t = performance.now();
      this.stats.lastMs = t - now;
      this.win.push(t);
      while (this.win.length && t - this.win[0]! > 2000) this.win.shift();
      this.stats.hz = this.win.length / 2;
      this.onStats?.(this.stats);
    } catch (e) {
      // DRM or tainted media: surface once and keep going.
      console.warn('[TacticLens] capture failed', e);
    } finally {
      this.inFlight = false;
    }
  }
}
