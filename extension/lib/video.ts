// Video helpers. findLargestPlayingVideo is used by the content script; the rest serves the Theatre page.

// Largest visible, playing <video> by on-screen area.
export function findLargestPlayingVideo(doc: Document): HTMLVideoElement | null {
  let best: HTMLVideoElement | null = null;
  let bestArea = 0;
  for (const v of Array.from(doc.querySelectorAll('video'))) {
    if (v.paused || v.readyState < 2) continue;
    const r = v.getBoundingClientRect();
    const visible =
      r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
      r.top < window.innerHeight && r.left < window.innerWidth;
    if (!visible) continue;
    const area = r.width * r.height;
    if (area > bestArea) {
      best = v;
      bestArea = area;
    }
  }
  return best;
}

/** The slice of HTMLVideoElement that the renderer and mocks rely on. */
export interface MediaClock {
  currentTime: number;
  readonly paused: boolean;
  playbackRate: number;
  readonly duration: number;
  play(): Promise<void> | void;
  pause(): void;
}

/** A clock with no video behind it: drives the offline mock demo and the gallery. */
export class VirtualClock implements MediaClock {
  private t = 0;
  private last = performance.now();
  private _paused: boolean;
  playbackRate = 1;
  constructor(public readonly duration = 70, public loop = true, startPaused = false) {
    this._paused = startPaused;
  }
  get paused(): boolean { return this._paused; }
  get currentTime(): number {
    this.advance();
    return this.t;
  }
  set currentTime(v: number) {
    this.advance();
    this.t = Math.max(0, v);
  }
  private advance(): void {
    const now = performance.now();
    if (!this._paused) {
      this.t += ((now - this.last) / 1000) * this.playbackRate;
      if (this.loop && this.t >= this.duration) this.t -= this.duration;
      else if (!this.loop && this.t > this.duration) this.t = this.duration;
    }
    this.last = now;
  }
  play(): void { this.advance(); this._paused = false; }
  pause(): void { this.advance(); this._paused = true; }
}

/** Rewrap a real video so engine code can treat it as a MediaClock (it already satisfies the shape). */
export const asClock = (v: HTMLVideoElement): MediaClock => v;

export function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
