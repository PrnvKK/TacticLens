// YOLO output decoding, NMS and letterbox/crop geometry. Pure TS, no DOM.
// Output tensors: [1, 4+nc, N] (cx,cy,w,h,class scores).

export type Box = [x1: number, y1: number, x2: number, y2: number];

/** Maps model-input pixels back to source-frame pixels: src = (m - o) / sc + x0|y0. */
export interface InputMap {
  sc: number;
  ox: number;
  oy: number;
  x0: number;
  y0: number;
}

export interface RawDet {
  box: Box;        // source-frame pixels
  score: number;
  cls: number;
}

export function iou(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const i = w * h;
  return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i + 1e-9);
}

/** Letterbox of the whole W x H frame into a sz x sz square (pad value 114 is applied by the caller). */
export function letterboxMap(W: number, H: number, sz: number): InputMap {
  const sc = Math.min(sz / W, sz / H);
  return { sc, ox: (sz - W * sc) / 2, oy: (sz - H * sc) / 2, x0: 0, y0: 0 };
}

/** Native-resolution sz x sz crop centred on (cx, cy) pixels, clamped to the frame. */
export function cropRect(cx: number, cy: number, W: number, H: number, sz: number) {
  const cw = Math.min(sz, W);
  const ch = Math.min(sz, H);
  const x0 = Math.round(Math.min(Math.max(cx - cw / 2, 0), W - cw));
  const y0 = Math.round(Math.min(Math.max(cy - ch / 2, 0), H - ch));
  return { x0, y0, cw, ch, map: { sc: 1, ox: 0, oy: 0, x0, y0 } as InputMap };
}

/**
 * Decode a [1, C, N] YOLO tensor (nms=False export) into per-class-NMS'd detections in source pixels.
 * `minScore` may be a per-class array.
 */
export function decodeYolo(
  data: ArrayLike<number>,
  C: number,
  N: number,
  map: InputMap,
  minScore: number | number[],
  nmsIou = 0.45,
): RawDet[] {
  const nc = C - 4;
  const cand: RawDet[] = [];
  for (let i = 0; i < N; i++) {
    let best = 0;
    let bc = 0;
    for (let c = 0; c < nc; c++) {
      const s = data[(4 + c) * N + i]!;
      if (s > best) { best = s; bc = c; }
    }
    const thr = Array.isArray(minScore) ? minScore[bc]! : minScore;
    if (best < thr) continue;
    const cx = data[i]!, cy = data[N + i]!, w = data[2 * N + i]!, h = data[3 * N + i]!;
    cand.push({
      box: [
        ((cx - w / 2) - map.ox) / map.sc + map.x0,
        ((cy - h / 2) - map.oy) / map.sc + map.y0,
        ((cx + w / 2) - map.ox) / map.sc + map.x0,
        ((cy + h / 2) - map.oy) / map.sc + map.y0,
      ],
      score: best,
      cls: bc,
    });
  }
  cand.sort((a, b) => b.score - a.score);
  const keep: RawDet[] = [];
  for (const c of cand) {
    let ok = true;
    for (const k of keep) if (k.cls === c.cls && iou(k.box, c.box) > nmsIou) { ok = false; break; }
    if (ok) keep.push(c);
  }
  return keep;
}
