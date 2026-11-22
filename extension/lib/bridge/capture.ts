// Composite the video frame with the overlay canvas and return a JPEG base64 (max 1280 px wide).
// Never throws: a tainted/DRM video returns null and the bridge simply has no new snapshot.

export interface CaptureRect { x: number; y: number; w: number; h: number }
export interface SnapshotJpeg { base64: string; width: number; height: number; t: number }

function blobToBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  });
}

export async function captureComposite(
  video: HTMLVideoElement,
  overlay: HTMLCanvasElement,
  rect: CaptureRect,
  t: number,
  maxWidth = 1280,
): Promise<SnapshotJpeg | null> {
  try {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !rect.w || !rect.h) return null;
    const scale = Math.min(1, maxWidth / vw);
    const cw = Math.max(1, Math.round(vw * scale));
    const ch = Math.max(1, Math.round(vh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, cw, ch);
    const cssW = overlay.clientWidth || overlay.width;
    const dpr = cssW > 0 ? overlay.width / cssW : 1;
    const sx = rect.x * dpr, sy = rect.y * dpr, sw = rect.w * dpr, sh = rect.h * dpr;
    if (sw > 0 && sh > 0 && sx >= 0 && sy >= 0 && sx + sw <= overlay.width + 1 && sy + sh <= overlay.height + 1) {
      ctx.drawImage(overlay, sx, sy, sw, sh, 0, 0, cw, ch);
    } else {
      ctx.drawImage(overlay, 0, 0, cw, ch);
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob) return null;
    return { base64: await blobToBase64(blob), width: cw, height: ch, t };
  } catch {
    return null;
  }
}
