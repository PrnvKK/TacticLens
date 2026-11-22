// Brain pipeline: ORT WebGPU runner + sequential perception schedule -> FrameState.
// No wxt or chrome APIs here, so the same code runs in the extension brain page and the Theatre page.
// Sessions run strictly one after another (concurrent run() across sessions crashes ORT-web WebGPU).
//
// Latency: the cycle is split into prepare -> inference -> finish so the
// host can start frame N+1's GPU inference before the CPU tail of frame N (a single ORT lock still forbids
// two sessions). Preprocessing does ONE canvas readback (the 640 letterbox) and derives the 64x36 scene grid
// and the 320x180 camera-flow luma from those pixels; the source bitmap is resized off-thread first.
import type { FrameState, QualityLevel, Track } from '@tacticlens/core';
import {
  cropRect, decodeYolo, letterboxMap, QualityLadder, BallScheduler, ByteTrackLite, BallTracker, TeamAssigner, sampleTorso,
  GRID_H, GRID_W, SceneAnalyzer, labHistogram, labDist, iou, resolveProfile, trackerOptsFromProfile, SourceClassifier,
  type InputMap, type GreyFrame, type Lab, type RawDet, type BallPlan, type PersonDet, type BallCandidate, type SceneResult,
  type SourceKind, type SourceProfile, type ResolvedSourceKind,
} from '@tacticlens/core';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Ort = any;   // onnxruntime-web module (webgpu build); injected so this file stays bundler-agnostic

export interface FrameSource {
  source: CanvasImageSource;
  width: number;
  height: number;
}

export interface BrainOptions {
  ort: Ort;
  /** Base URL of the model files: soccana_640.onnx, ball_640.onnx, ball_1280.onnx. */
  modelBase: string;
  /** Base URL of the ORT runtime files (wasm + mjs). */
  wasmPaths: string;
  /** Source profile: broadcast (default), game, or auto (classified from frame signals). */
  source?: SourceKind;
  playerConf?: number;      // low-score floor for players; ByteTrack splits high/low itself
  ballConf?: number;
  ballConfFull?: number;
  searchEvery?: number;
  onProgress?: (msg: string) => void;
}

export const STAGES = ['prep', 'players', 'scene', 'grey', 'track', 'ballPrep', 'ball', 'teams', 'total'] as const;
export type Stage = (typeof STAGES)[number];
export type StageMs = Record<Stage, number>;

export interface FrameDebug {
  stageMs: StageMs;
  ballPlan: BallPlan['mode'];
  ballWhy?: string;
  cropPx: [number, number, number, number] | null;   // x0,y0,w,h in source pixels of the ball crop, if any
  hint: [number, number] | null;
  scene: SceneResult;
  playersRaw: number;
  ballCandidates: { xy: [number, number]; score: number }[];
  videoW: number;
  videoH: number;
  newIdsPerMinute: number;
  cameraConf: number | null;
}

export interface BrainResult {
  state: FrameState;
  debug: FrameDebug;
}

/** Everything a cycle needs from the CPU/DOM side, computed before the GPU call. */
export interface PreparedFrame {
  source: CanvasImageSource;
  width: number;
  height: number;
  W: number;
  H: number;
  t: number;
  tMedia: number;
  playbackRate: number;
  startedAt: number;
  prepMs: number;
  /** Time to derive the 320x180 luma, reported under the `grey` stage (part of prep wall time). */
  greyMs: number;
  map: InputMap;
  tensor: any;
  buf: Float32Array;
  rgba: Uint8ClampedArray;
  /** 64x36 RGBA of the letterbox content area, derived from `rgba` (no extra canvas readback). */
  grid: Uint8ClampedArray;
  /** 320x180 luma of the full frame (letterbox bars included), derived from `rgba`. */
  grey: GreyFrame;
}

export interface PlayerInference {
  data: Float32Array;
  C: number;
  N: number;
  dispose: () => void;
  ms: number;
}

const PERSON_CLS: (PersonDet['cls'] | 'ball')[] = ['player', 'ball', 'referee'];   // soccana_640 class order

const pct = (a: number[], p: number): number => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};

export class Brain {
  readonly ort: Ort;
  private sessions!: { players: any; ball640: any; ball1280: any };
  private canvases = new Map<number, OffscreenCanvas>();
  private ctxs = new Map<number, OffscreenCanvasRenderingContext2D>();
  /** Float32 CHW buffers; two live at most (one in flight in ORT, one being prepared for the next frame). */
  private tensorPool = new Map<number, Float32Array[]>();
  /** Greyscale frame for camera-motion flow: 320x180 (camera.ts is specified for ~320x180 with ~60 corners). */
  static readonly GREY_W = 320;
  static readonly GREY_H = 180;
  private greyLutX = new Int32Array(Brain.GREY_W);

  readonly tracker: ByteTrackLite;
  readonly ball = new BallTracker();
  readonly teams = new TeamAssigner();
  readonly scene = new SceneAnalyzer();
  readonly scheduler: BallScheduler;
  readonly ladder = new QualityLadder();
  forcedQuality: QualityLevel | null = null;
  /** The requested source kind (auto resolves to broadcast or game as frames arrive). */
  readonly source: SourceKind;
  /** Currently active profile (broadcast initially; auto may flip it to game). */
  private activeProfile: SourceProfile;
  private readonly sourceClassifier = new SourceClassifier();
  /** Test hook: busy-wait this many ms inside each cycle (counted in the cycle time the ladder sees). */
  artificialLoadMs = 0;

  private frameIdx = 0;
  private prepSlot = 0;
  private lastBallXY: [number, number] | null = null;
  /** Renderer-side hard cut (media time); applied to the first frame at or after it. */
  private cutSignal = -Infinity;
  private roll: Record<Stage, number[]> = Object.fromEntries(STAGES.map((s) => [s, [] as number[]])) as Record<Stage, number[]>;
  private doneAt: number[] = [];
  private win = 60;
  private ortQueue: Promise<void> = Promise.resolve();
  ballRuns = { crop: 0, full: 0, none: 0 };
  adapter = 'n/a';

  private constructor(private opts: BrainOptions) {
    this.ort = opts.ort;
    this.scheduler = new BallScheduler(opts.searchEvery ?? 5, 3);
    this.source = opts.source ?? 'broadcast';
    this.activeProfile = resolveProfile(this.source);
    this.tracker = new ByteTrackLite({ tracker: 'v2', ...trackerOptsFromProfile(this.activeProfile) });
  }

  static async create(opts: BrainOptions): Promise<Brain> {
    const b = new Brain(opts);
    await b.init();
    return b;
  }

  private async init(): Promise<void> {
    const { ort, opts } = this;
    const say = opts.onProgress ?? (() => {});
    ort.env.wasm.wasmPaths = opts.wasmPaths;
    ort.env.wasm.numThreads = 1;
    const gpu = (navigator as any).gpu;
    const adapter = await gpu?.requestAdapter();
    if (!adapter) throw new Error('WebGPU adapter not available (WebGPU only; WASM is cut)');
    const i = adapter.info ?? {};
    this.adapter = `${i.vendor ?? ''} ${i.architecture ?? ''} ${i.description ?? ''}`.trim();
    const load = async (name: string): Promise<any> => {
      say(`loading ${name}`);
      const url = `${opts.modelBase}/${name}.onnx`;
      let res: Response;
      try {
        res = await fetch(url);
      } catch (e) {
        // "Failed to fetch" alone does not say what was requested; name the URL (missing/stale extension files show up here).
        throw new Error(`fetch failed for ${url}: ${(e as Error)?.message ?? e}`);
      }
      if (!res.ok) throw new Error(`model ${url} returned HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      return ort.InferenceSession.create(buf, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
    };
    // sequential creation and warm-up (first inference compiles shaders)
    const players = await load('soccana_640');
    const ball640 = await load('ball_640');
    const ball1280 = await load('ball_1280');
    this.sessions = { players, ball640, ball1280 };
    for (const [s, sz] of [[players, 640], [ball640, 640], [ball1280, 1280]] as const) {
      say(`warming ${sz}`);
      const t = new ort.Tensor('float32', new Float32Array(3 * sz * sz).fill(0.45), [1, 3, sz, sz]);
      const out = await s.run({ [s.inputNames[0]]: t });
      for (const v of Object.values(out) as any[]) v.dispose?.();
    }
  }

  // ---------- preprocessing (one shared canvas per model size, pooled tensor buffers) ----------
  /** Canvas per (size, slot). Slot 0/1 alternate between pipelined preps; slot 2 is the ball's own canvas. */
  private ctx(sz: number, slot = 2): OffscreenCanvasRenderingContext2D {
    const key = sz * 4 + slot;
    let c = this.ctxs.get(key);
    if (!c) {
      const cv = new OffscreenCanvas(sz, sz);
      this.canvases.set(key, cv);
      c = cv.getContext('2d', { willReadFrequently: true })!;
      this.ctxs.set(key, c);
    }
    return c;
  }

  private takeBuf(sz: number): Float32Array {
    const pool = this.tensorPool.get(sz) ?? [];
    this.tensorPool.set(sz, pool);
    const b = pool.pop();
    return b ?? new Float32Array(3 * sz * sz);
  }

  private giveBuf(sz: number, b: Float32Array): void {
    const pool = this.tensorPool.get(sz) ?? [];
    if (pool.length < 2) pool.push(b);
    this.tensorPool.set(sz, pool);
  }

  private toTensor(g: OffscreenCanvasRenderingContext2D, sz: number): { tensor: any; rgba: Uint8ClampedArray; buf: Float32Array } {
    const rgba = g.getImageData(0, 0, sz, sz).data;
    const n = sz * sz;
    const f = this.takeBuf(sz);
    for (let i = 0, j = 0; i < n; i++, j += 4) { f[i] = rgba[j]! / 255; f[n + i] = rgba[j + 1]! / 255; f[2 * n + i] = rgba[j + 2]! / 255; }
    return { tensor: new this.ort.Tensor('float32', f, [1, 3, sz, sz]), rgba, buf: f };
  }

  /**
   * Resize the captured bitmap to the letterbox content size OFF the main thread, then blit it 1:1 into the
   * model canvas. Drawing a 1920x1080 ImageBitmap into a willReadFrequently (CPU) canvas was the 30 ms prep.
   */
  private async blitLetterbox(fs: FrameSource, sz: number, slot = 2): Promise<InputMap> {
    const g = this.ctx(sz, slot);
    const map = letterboxMap(fs.width, fs.height, sz);
    g.fillStyle = 'rgb(114,114,114)';
    g.fillRect(0, 0, sz, sz);
    const dw = Math.max(1, Math.round(fs.width * map.sc));
    const dh = Math.max(1, Math.round(fs.height * map.sc));
    const small = await resizeBitmap(fs.source, dw, dh);
    if (small) {
      g.drawImage(small, map.ox, map.oy, dw, dh);
      small.close();
    } else {
      g.drawImage(fs.source, map.ox, map.oy, fs.width * map.sc, fs.height * map.sc);
    }
    return map;
  }

  /** Native-resolution sz x sz crop centred on (cx, cy) source pixels. */
  private prepCrop(fs: FrameSource, cx: number, cy: number, sz: number) {
    const g = this.ctx(sz);
    const r = cropRect(cx, cy, fs.width, fs.height, sz);
    g.fillStyle = 'rgb(114,114,114)';
    g.fillRect(0, 0, sz, sz);
    g.drawImage(fs.source, r.x0, r.y0, r.cw, r.ch, 0, 0, r.cw, r.ch);
    return { ...this.toTensor(g, sz), map: r.map, rect: r };
  }

  /**
   * 64x36 RGBA over the letterbox content area, nearest-sampled from the 640 readback (the old path drew the
   * 640 canvas into a 64x36 canvas and paid a second getImageData).
   */
  private gridFrom(rgba: Uint8ClampedArray, W: number, H: number, map: InputMap): Uint8ClampedArray {
    const out = new Uint8ClampedArray(GRID_W * GRID_H * 4);
    const cw = W * map.sc, ch = H * map.sc;
    for (let gy = 0; gy < GRID_H; gy++) {
      const cy = map.oy + ((gy + 0.5) / GRID_H) * ch;
      const y = Math.min(639, Math.max(0, Math.floor(cy)));
      for (let gx = 0; gx < GRID_W; gx++) {
        const cx = map.ox + ((gx + 0.5) / GRID_W) * cw;
        const x = Math.min(639, Math.max(0, Math.floor(cx)));
        const si = (y * 640 + x) * 4, di = (gy * GRID_W + gx) * 4;
        out[di] = rgba[si]!; out[di + 1] = rgba[si + 1]!; out[di + 2] = rgba[si + 2]!; out[di + 3] = 255;
      }
    }
    return out;
  }

  /** 320x180 luma of the full frame (same aspect letterbox as the old grey canvas), sampled from `rgba`. */
  private greyFrom(rgba: Uint8ClampedArray, W: number, H: number, map: InputMap): GreyFrame {
    const gw = Brain.GREY_W, gh = Brain.GREY_H;
    const sc = Math.min(gw / W, gh / H);
    const dw = W * sc, dh = H * sc;
    const ox = (gw - dw) / 2, oy = (gh - dh) / 2;
    const data = new Uint8Array(gw * gh);
    const cw = W * map.sc, ch = H * map.sc;
    for (let x = 0; x < gw; x++) {
      const nx = (x - ox) / dw;
      this.greyLutX[x] = nx < 0 || nx >= 1 ? -1 : Math.min(639, Math.max(0, Math.floor(map.ox + nx * cw)));
    }
    for (let y = 0; y < gh; y++) {
      const ny = (y - oy) / dh;
      if (ny < 0 || ny >= 1) continue;                       // letterbox bar: luma 0
      const py = Math.min(638, Math.max(0, Math.floor(map.oy + ny * ch)));
      const row = py * 640, row2 = (py + 1) * 640;
      for (let x = 0; x < gw; x++) {
        const sx = this.greyLutX[x]!;
        if (sx < 0) continue;
        const sx2 = sx < 639 ? sx + 1 : sx;
        // 2x2 box: the 640 letterbox is exactly 2x the 320x180 grey for a 16:9 source; averaging keeps
        // LK corners stable on the fine turf texture instead of aliasing them away.
        const a = (row + sx) * 4, b = (row + sx2) * 4, c = (row2 + sx) * 4, d = (row2 + sx2) * 4;
        data[y * gw + x] = 0.25 * (
          0.299 * (rgba[a]! + rgba[b]! + rgba[c]! + rgba[d]!) +
          0.587 * (rgba[a + 1]! + rgba[b + 1]! + rgba[c + 1]! + rgba[d + 1]!) +
          0.114 * (rgba[a + 2]! + rgba[b + 2]! + rgba[c + 2]! + rgba[d + 2]!));
      }
    }
    return { data, width: gw, height: gh };
  }

  /** CPU/DOM half of a cycle. Async only because the off-thread bitmap resize is a promise. */
  async prepare(fs: FrameSource, tMedia: number, playbackRate = 1, t = tMedia): Promise<PreparedFrame> {
    const startedAt = performance.now();
    const t0 = startedAt;
    if (this.artificialLoadMs > 0) { const e = t0 + this.artificialLoadMs; while (performance.now() < e) { /* simulated load */ } }
    const W = fs.width, H = fs.height;
    const slot = (this.prepSlot ^= 1);
    const map = await this.blitLetterbox(fs, 640, slot);
    const { tensor, rgba, buf } = this.toTensor(this.ctx(640, slot), 640);
    // Both auxiliary images come from the single 640 readback: no second drawImage/getImageData.
    const grid = this.gridFrom(rgba, W, H, map);
    const g0 = performance.now();
    const grey = this.greyFrom(rgba, W, H, map);
    const greyMs = performance.now() - g0;
    return {
      source: fs.source, width: W, height: H, W, H, t, tMedia, playbackRate, startedAt,
      prepMs: performance.now() - t0 - greyMs, greyMs, map, tensor, buf, rgba, grid, grey,
    };
  }

  /** Start the players-model inference. Serialised across cycles: ORT-web WebGPU cannot run two sessions. */
  startInference(prep: PreparedFrame): Promise<PlayerInference> {
    const go = async (): Promise<PlayerInference> => {
      const t0 = performance.now();
      const out = await this.sessions.players.run({ [this.sessions.players.inputNames[0]]: prep.tensor });
      const o = Object.values(out)[0] as any;
      return {
        data: o.data as Float32Array, C: o.dims[1], N: o.dims[2],
        dispose: () => { for (const v of Object.values(out) as any[]) v.dispose?.(); },
        ms: performance.now() - t0,
      };
    };
    const p = this.ortQueue.then(go, go);
    this.ortQueue = p.then(() => undefined, () => undefined);
    return p;
  }

  /** Backwards-compatible one-shot cycle. */
  async process(fs: FrameSource, tMedia: number, playbackRate = 1, t = tMedia): Promise<BrainResult> {
    const prep = await this.prepare(fs, tMedia, playbackRate, t);
    return this.finish(prep, await this.startInference(prep));
  }

  /** CPU half of a cycle: decode, scene, camera frame, tracking, ball, teams. */
  async finish(prep: PreparedFrame, inf: PlayerInference): Promise<BrainResult> {
    const t0 = performance.now();
    let mark = t0;
    const ms: StageMs = { prep: prep.prepMs, players: inf.ms, scene: 0, grey: prep.greyMs, track: 0, ballPrep: 0, ball: 0, teams: 0, total: 0 };
    const lap = (k: Stage): void => { const n = performance.now(); ms[k] += n - mark; mark = n; };
    const { W, H, t, tMedia, playbackRate } = prep;
    const quality: QualityLevel = this.forcedQuality ?? this.ladder.level;

    const po = inf;
    const playerConf = this.opts.playerConf ?? this.activeProfile.playerConf;
    const raw: RawDet[] = decodeYolo(po.data, po.C, po.N, prep.map, [playerConf, 0.25, playerConf], this.activeProfile.nmsIou);
    po.dispose();
    this.giveBuf(640, prep.buf);
    const persons: PersonDet[] = [];
    let hint: [number, number] | null = null;
    let hintScore = 0;
    for (const d of raw) {
      const cls = PERSON_CLS[d.cls];
      const nb: [number, number, number, number] = [
        Math.max(0, d.box[0] / W), Math.max(0, d.box[1] / H), Math.min(1, d.box[2] / W), Math.min(1, d.box[3] / H),
      ];
      if (cls === 'ball') {
        if (d.score > hintScore) { hintScore = d.score; hint = [(nb[0] + nb[2]) / 2, (nb[1] + nb[3]) / 2]; }
        continue;
      }
      if (nb[3] - nb[1] < 0.02 || nb[2] - nb[0] < 0.004) continue;
      persons.push({ cls: cls as PersonDet['cls'], score: d.score, box: nb });
    }
    lap('track');   // decode counts as track-side CPU work

    // 2. scene (cheap signals from the 64x36 grid derived from the 640 letterbox, content area only)
    const confident = persons.filter((p) => p.score >= this.tracker.opts.highScore);
    const scene = this.scene.update(t, prep.grid, confident.filter((p) => p.cls !== 'referee').map((p) => p.box[3] - p.box[1]));
    // The renderer sees the cut on the displayed frame, before this detection cycle. Apply it to the
    // first frame at/after that media time: park every ID in the gallery and clear the Kalman state
    // now instead of waiting for the scene histogram to commit.
    const externalCut = Number.isFinite(this.cutSignal) && tMedia >= this.cutSignal - 1e-6;
    if (externalCut) this.cutSignal = -Infinity;
    // A rewind/loop moved the timeline behind the pending signal: it belongs to the old segment.
    else if (Number.isFinite(this.cutSignal) && tMedia < this.cutSignal - 0.5) this.cutSignal = -Infinity;
    const cut = scene.cut || externalCut;
    lap('scene');

    // 2a. auto source classification: guess `game` from saturated, uniform synthetic turf with hysteresis.
    // Conservative by design — defaults to broadcast and only flips on a sustained strong signal.
    if (this.source === 'auto') {
      const guess = this.sourceClassifier.update(t, scene);
      if (guess !== this.activeProfile.kind) {
        this.activeProfile = resolveProfile(guess);
        this.tracker.configure(trackerOptsFromProfile(this.activeProfile));
      }
    }

    // 2b. greyscale frame for camera flow (already derived during prep)
    const frame = prep.grey;
    lap('grey');

    // 2c. torso colours per detection (from the 640 letterbox already in memory): hist + provisional team for the tracker
    const labs: (Lab | null)[] = persons.map((p) => {
      const m = prep.map;
      const s = sampleTorso(prep.rgba, 640, 640, [p.box[0] * W * m.sc + m.ox, p.box[1] * H * m.sc + m.oy, p.box[2] * W * m.sc + m.ox, p.box[3] * H * m.sc + m.oy]);
      return s ? s.lab : null;
    });
    const wide = scene.kind === 'WIDE';
    const tc = this.teams.calibrated ? this.teams.centres : null;
    const dets: PersonDet[] = persons.map((p, i) => {
      const lab = labs[i];
      if (!lab) return p;
      const out: PersonDet = { ...p, hist: labHistogram(lab) };
      // Provisional team only from the wide pitch view: a close-up torso is not evidence and used
      // to seed the cut gallery with the wrong team before the assigner saw the new track id.
      if (tc && wide) {
        const dA = labDist(lab, tc[0]), dB = labDist(lab, tc[1]);
        if (Math.min(dA, dB) <= Math.max(24, 2.6 * this.teams.spread)) out.team = dA <= dB ? 'A' : 'B';
      }
      return out;
    });
    lap('teams');

    // 3. tracking
    if (cut) { this.ball.reset(); this.scheduler.reset(); this.lastBallXY = null; }
    const tracks0 = this.tracker.update(dets, t, tMedia, cut, { scene: scene.kind, frame });
    // Flow is a displacement over the tracker's actual flow span (cycles may be skipped); FrameState
    // .globalMotion is a per-second rate.
    const flow = this.tracker.motion;
    const span = this.tracker.motionSpanS;
    const globalMotion: [number, number] = flow && span > 0 ? [flow.dx / span, flow.dy / span] : ByteTrackLite.medianVelocity(tracks0);
    lap('track');

    // 4. ball pass (sequential after players)
    const predicted = this.ball.predict(t);
    const smart = this.smartTarget(tracks0);
    const plan = this.scheduler.plan({
      state: this.ball.state, quality, scene: scene.kind, predicted, hint, smart: this.lastBallXY ?? smart,
    });
    this.ballRuns[plan.mode]++;
    const cands: BallCandidate[] = [];
    let cropPx: FrameDebug['cropPx'] = null;
    if (plan.mode !== 'none') {
      const ballPrepStart = performance.now();
      mark = ballPrepStart;
      let pre: { tensor: any; map: InputMap; buf: Float32Array };
      let session: any;
      let thr: number;
      let sz = 640;
      if (plan.mode === 'crop') {
        const c = this.prepCrop(prep, plan.xy[0] * W, plan.xy[1] * H, 640);
        pre = c; cropPx = [c.rect.x0, c.rect.y0, c.rect.cw, c.rect.ch];
        session = this.sessions.ball640; thr = this.opts.ballConf ?? 0.25;
      } else {
        sz = 1280;
        const map1280 = await this.blitLetterbox(prep, 1280);
        pre = { ...this.toTensor(this.ctx(1280), 1280), map: map1280 };
        session = this.sessions.ball1280; thr = this.opts.ballConfFull ?? 0.3;
      }
      lap('ballPrep');
      const bo = await this.runLocked(session, pre.tensor);
      lap('ball');
      for (const d of decodeYolo(bo.data, bo.C, bo.N, pre.map, thr)) {
        cands.push({ xy: [((d.box[0] + d.box[2]) / 2) / W, ((d.box[1] + d.box[3]) / 2) / H], score: d.score });
      }
      bo.dispose();
      this.giveBuf(sz, pre.buf);
      this.scheduler.report(plan, cands.length > 0);
    }
    const bout = plan.mode === 'none' && plan.skipped ? this.ball.advance(t) : this.ball.update(t, cands, false);
    if (bout.xy) this.lastBallXY = bout.xy;
    mark = performance.now();

    // 5. teams (torso colours from the 640 letterbox pixels already in memory)
    // WIDE only, exactly like the replay pipeline. A close-up or a replay is a different scale, a
    // different background and often a different shirt (warm-up jacket); feeding those samples into
    // the per-track EMA was dragging both teams toward white on EA FC's frequent cutaways.
    for (const tr of tracks0) {
      if (!wide || tr.timeSinceUpdate > 0 || tr.cls === 'referee') continue;
      let bi = -1, bv = 0.3;
      persons.forEach((p, i) => { const v = iou(tr.box, p.box); if (v > bv && labs[i]) { bv = v; bi = i; } });
      if (bi >= 0) this.teams.observe(tr.id, labs[bi]!, t, wide);
    }
    const tracks: Track[] = this.teams.assign(tracks0, t, wide);
    this.tracker.noteTeams(tracks);
    lap('teams');

    // The cycle cost is the interval between results (what "Hz" means), not the staged wall time: with the
    // pipeline, prep of the next frame overlaps this one's GPU pass. The ladder measures that period minus the
    // optional ball pass, because the ball frequency is *scheduled by the ladder itself* (Q3: every cycle,
    // Q1: every third); counting it would keep the ladder at Q1. The first cycles include shader warm-up.
    const doneNow = performance.now();
    const prevDone = this.doneAt.length ? this.doneAt[this.doneAt.length - 1]! : 0;
    const period = prevDone > 0 ? doneNow - prevDone : doneNow - prep.startedAt;
    ms.total = period;
    this.frameIdx++;
    if (this.frameIdx > 5) this.ladder.push(doneNow / 1000, Math.max(0, period - ms.ball - ms.ballPrep));
    for (const k of STAGES) { const a = this.roll[k]; a.push(ms[k]); if (a.length > this.win) a.shift(); }
    this.doneAt.push(doneNow); if (this.doneAt.length > this.win) this.doneAt.shift();

    const state: FrameState = {
      t, tMedia, playbackRate, globalMotion, quality, frameIdx: this.frameIdx,
      scene: { kind: scene.kind, confidence: scene.confidence },
      tracks,
      ball: bout,
      teamsCalibrated: this.teams.calibrated,
      cut,
      teamColours: this.teams.kitColours ?? undefined,
    };
    return {
      state,
      debug: {
        stageMs: ms, ballPlan: plan.mode, ballWhy: plan.mode === 'crop' ? plan.why : undefined, cropPx, hint, scene,
        playersRaw: raw.length, ballCandidates: cands, videoW: W, videoH: H,
        newIdsPerMinute: this.tracker.debugStats().newIdsPerMinute, cameraConf: flow ? flow.confidence : null,
      },
    };
  }

  /** Async ball inference (must not overlap the players run). */
  private runLocked(session: any, tensor: any): Promise<{ data: Float32Array; C: number; N: number; dispose: () => void }> {
    const go = async () => {
      const out = await session.run({ [session.inputNames[0]]: tensor });
      const o = Object.values(out)[0] as any;
      return { data: o.data as Float32Array, C: o.dims[1], N: o.dims[2], dispose: () => { for (const v of Object.values(out) as any[]) v.dispose?.(); } };
    };
    const p = this.ortQueue.then(go, go);
    this.ortQueue = p.then(() => undefined, () => undefined);
    return p;
  }

  /** Smart crop target: centre of the densest cluster of confirmed players. */
  private smartTarget(tracks: Track[]): [number, number] | null {
    const live = tracks.filter((t) => t.cls !== 'referee' && t.timeSinceUpdate < 0.3);
    if (live.length < 3) return null;
    let best = -1, bi = 0;
    live.forEach((a, i) => {
      let n = 0;
      for (const b of live) if (Math.hypot(a.foot[0] - b.foot[0], (a.foot[1] - b.foot[1]) * 1.7) < 0.12) n++;
      if (n > best) { best = n; bi = i; }
    });
    const c = live[bi]!;
    return [c.foot[0], c.foot[1] - 0.03];
  }

  /** Renderer saw a hard cut on this video frame; force the tracker cut on the next cycle at/after it. */
  noteCut(tMedia: number): void {
    if (Number.isFinite(tMedia)) this.cutSignal = tMedia;
  }

  /** Reset all temporal state (seek, new video). Teams are kept unless `teams` is true. */
  reset(teams = false): void {
    this.tracker.reset(); this.ball.reset(); this.scheduler.reset(); this.scene.reset(); this.lastBallXY = null;
    this.cutSignal = -Infinity;
    this.sourceClassifier.reset();
    if (teams) this.teams.recalibrate();
  }

  /** Rolling per-stage timings, ms (last ~60 cycles) and detection rate. */
  stats(): { hz: number; stages: Record<Stage, { p50: number; p95: number }>; cycles: number; ballRuns: Brain['ballRuns']; quality: QualityLevel; newIdsPerMinute: number; profile: ResolvedSourceKind } {
    const d = this.doneAt;
    const hz = d.length > 1 ? (d.length - 1) / ((d[d.length - 1]! - d[0]!) / 1000) : NaN;
    const stages = Object.fromEntries(STAGES.map((k) => [k, { p50: pct(this.roll[k], 0.5), p95: pct(this.roll[k], 0.95) }])) as Record<Stage, { p50: number; p95: number }>;
    return { hz, stages, cycles: this.frameIdx, ballRuns: this.ballRuns, quality: this.forcedQuality ?? this.ladder.level, newIdsPerMinute: this.tracker.debugStats().newIdsPerMinute, profile: this.activeProfile.kind };
  }

  dispose(): void {
    for (const s of Object.values(this.sessions ?? {}) as any[]) s.release?.();
  }
}

/** Resize an ImageBitmap off the main thread; null when the browser source cannot be resized. */
async function resizeBitmap(src: CanvasImageSource, w: number, h: number): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== 'function' || typeof ImageBitmap === 'undefined' || !(src instanceof ImageBitmap)) return null;
  try {
    return await createImageBitmap(src, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' });
  } catch {
    return null;
  }
}
