// Turns the pure annotation spec (core/src/llm/annotate.ts) into a JPEG data URL with OffscreenCanvas.
// Frames are encoded at capture into a ring, so a Kimi tick never waits on encoding.
import { annotationSpec, type AnnotateOptions, type DrawCmd } from '@tacticlens/core';
import type { FrameState as FS } from '@tacticlens/core';

export function drawCommands(ctx: OffscreenCanvasRenderingContext2D, cmds: DrawCmd[]): void {
  for (const c of cmds) {
    if (c.op === 'ellipse') {
      ctx.strokeStyle = c.stroke; ctx.lineWidth = c.lineWidth;
      ctx.beginPath(); ctx.ellipse(c.cx, c.cy, c.rx, c.ry, 0, 0, Math.PI * 2); ctx.stroke();
    } else if (c.op === 'circle') {
      ctx.strokeStyle = c.stroke; ctx.lineWidth = c.lineWidth;
      ctx.beginPath(); ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2); ctx.stroke();
    } else if (c.op === 'rect') {
      ctx.fillStyle = c.fill; ctx.fillRect(c.x, c.y, c.w, c.h);
    } else {
      ctx.fillStyle = c.fill; ctx.font = `bold ${c.fontPx}px sans-serif`; ctx.textAlign = c.align; ctx.fillText(c.text, c.x, c.y);
    }
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  // Native base64 encoder: no per-byte JS string building on the main thread.
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('blob read failed'));
    r.readAsDataURL(blob);
  });
}

/** Draw `source` at `width` px wide with IDs/team colours from `frame`, encode as JPEG data URL (base64). */
export async function annotatedJpeg(
  source: ImageBitmap, frame: FS, opts: AnnotateOptions & { quality?: number } = {},
): Promise<{ dataUrl: string; bytes: number; width: number; height: number }> {
  const width = opts.width ?? 768;
  const height = Math.round((source.height / source.width) * width);
  const spec = annotationSpec(frame, { ...opts, width, aspect: height / width });
  const canvas = new OffscreenCanvas(spec.width, spec.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(source, 0, 0, spec.width, spec.height);
  drawCommands(ctx, spec.cmds);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: opts.quality ?? 0.7 });
  return { dataUrl: await blobToDataUrl(blob), bytes: blob.size, width: spec.width, height: spec.height };
}

/** Ring of the last ~10 s, one encoded frame per second. */
export class FrameRing {
  private items: { tMedia: number; dataUrl: string }[] = [];
  constructor(private capacity = 10) {}
  push(tMedia: number, dataUrl: string): void {
    this.items.push({ tMedia, dataUrl });
    if (this.items.length > this.capacity) this.items.shift();
  }
  /** Frames nearest to t-3, t-2, t-1, t (Watch), oldest first. */
  watchSet(tNow: number, offsets = [3, 2, 1, 0]): { tMedia: number; dataUrl: string }[] {
    const out: { tMedia: number; dataUrl: string }[] = [];
    for (const o of offsets) {
      let best: (typeof this.items)[number] | null = null;
      for (const it of this.items) if (!best || Math.abs(it.tMedia - (tNow - o)) < Math.abs(best.tMedia - (tNow - o))) best = it;
      if (best && !out.includes(best)) out.push(best);
    }
    return out;
  }
  clear(): void { this.items = []; }
}
