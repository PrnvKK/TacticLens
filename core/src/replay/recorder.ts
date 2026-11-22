// Recorder: the extension calls `push` once per perception cycle and decides what to do with each line
// (append to an in-memory array, stream to a Blob, download at the end). No fs, no DOM here.
import type { FrameState } from '../types';
import type { FrameRecord, RawFrame, SessionHeader } from './format';
import { SESSION_VERSION } from './format';

/** JSON.stringify replacer: 4 decimals keeps files small and diffs stable. */
export const round4 = (_k: string, v: unknown): unknown => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);
export const toLine = (o: unknown): string => JSON.stringify(o, round4);

export interface RecorderOpts {
  source?: string;
  hz?: number;
  video?: SessionHeader['video'];
  meta?: Record<string, unknown>;
  /** Store the finished FrameState (default true). With raw only, store just the clocks. */
  keepFrame?: boolean;
  /** Stop after this many frames (memory guard). */
  maxFrames?: number;
}

export class SessionRecorder {
  count = 0;
  private started = false;
  constructor(private sink: (line: string) => void, private o: RecorderOpts = {}) {}

  /** The header line is written on the first push so `hasRaw` is accurate. */
  private start(hasRaw: boolean): void {
    this.started = true;
    const h: SessionHeader = { kind: 'header', version: SESSION_VERSION, source: this.o.source ?? 'extension', createdAt: new Date().toISOString(), hz: this.o.hz, hasRaw, video: this.o.video, meta: this.o.meta };
    this.sink(toLine(h));
  }

  /** Record one cycle. Returns false when maxFrames was reached. */
  push(frame: FrameState, raw?: RawFrame): boolean {
    if (this.o.maxFrames !== undefined && this.count >= this.o.maxFrames) return false;
    if (!this.started) this.start(!!raw);
    const keep = this.o.keepFrame !== false || !raw;
    const rec: FrameRecord = {
      kind: 'frame',
      frame: keep ? frame : { t: frame.t, tMedia: frame.tMedia, playbackRate: frame.playbackRate, quality: frame.quality, frameIdx: frame.frameIdx },
      ...(raw ? { raw } : {}),
    };
    this.sink(toLine(rec));
    this.count++;
    return true;
  }
}

/** Serialise a whole session to JSONL text (used by the fixture generator). */
export function serializeSession(header: SessionHeader, frames: FrameRecord[]): string {
  return [toLine(header), ...frames.map(toLine)].join('\n') + '\n';
}
