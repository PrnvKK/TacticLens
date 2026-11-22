// Brain page: runs inside a hidden iframe injected by the content script (or imported as a module by the Theatre page).
// Owns onnxruntime-web (WebGPU) and the perception pipeline; posts FrameState over the MessagePort at the detection rate.
//
// Pipelining: one frame is prepared (CPU/DOM) while the previous frame's GPU inference runs, and the next GPU
// inference is started before the previous frame's CPU tail. Only one ORT run is ever in flight (Brain serialises
// them), and only one result is posted per processed frame, in capture order.
import type { FrameState } from '@tacticlens/core';
import { Brain, type PlayerInference, type PreparedFrame } from './pipeline';

// Contract: the brain posts FrameState (the perception -> engine contract), one per processed frame.
export type BrainOutput = FrameState | null;

let brain: Brain | null = null;
let loading: Promise<Brain> | null = null;

async function boot(source: string): Promise<Brain> {
  const base = new URL('./', location.href).href.replace(/\/$/, '');
  // ORT is loaded as a plain module from the extension origin (copied into the build as ort/), so the bundler never touches its wasm.
  const ort = await import(/* @vite-ignore */ `${base}/ort/ort.webgpu.min.mjs`);
  const s = source === 'game' || source === 'auto' ? source : 'broadcast';
  return Brain.create({ ort, modelBase: `${base}/models`, wasmPaths: `${base}/ort/`, source: s as 'broadcast' | 'game' | 'auto' });
}

interface Job { id: number; bitmap: ImageBitmap; tMedia: number; t: number; playbackRate: number }

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.data?.type !== 'tl:port') return;
  const port = ev.ports[0];
  if (!port) return;

  let queue: Job | null = null;                                   // newest captured, not prepared yet
  let ready: { job: Job; prep: PreparedFrame } | null = null;      // prepared, waiting for the GPU/tail
  let producing = false;
  let consuming = false;
  let wake: (() => void) | null = null;
  const wakeup = (): void => { const w = wake; wake = null; w?.(); };
  const waitWork = (): Promise<void> => new Promise<void>((r) => { wake = r; });

  // Producer: prepare the newest queued frame. Runs while the consumer is inside GPU inference.
  async function produce(): Promise<void> {
    if (producing || !brain) return;
    producing = true;
    try {
      while (queue) {
        const job = queue;
        queue = null;
        let prep: PreparedFrame;
        try {
          prep = await brain.prepare({ source: job.bitmap, width: job.bitmap.width, height: job.bitmap.height }, job.tMedia, job.playbackRate, job.t);
        } catch (e) {
          job.bitmap.close();
          throw e;
        }
        if (queue) {                       // a fresher frame arrived while this one was being resized
          job.bitmap.close();
          continue;
        }
        if (ready) ready.job.bitmap.close();
        ready = { job, prep };
        wakeup();
      }
    } catch (e) {
      port.postMessage({ type: 'tl:error', message: String(e) });
    } finally {
      producing = false;
    }
  }

  // Consumer: inference then CPU tail, strict order, one frame at a time. The next frame's GPU inference is
  // started before the current frame's CPU tail (ball/teams/state) so the 60 ms GPU pass is never idle behind
  // a few ms of JavaScript; Brain serialises ORT runs, so the ball pass of the current frame still waits its
  // turn rather than ever running two sessions at once.
  async function consume(): Promise<void> {
    if (consuming || !brain) return;
    consuming = true;
    let cur: { job: Job; prep: PreparedFrame } | null = null;
    let inflight: Promise<PlayerInference> | null = null;
    try {
      for (;;) {
        if (!cur) {
          if (!ready) {
            if (queue) await produce();
            else { await waitWork(); continue; }
            if (!ready) continue;
          }
          cur = ready;
          ready = null;
        }
        const infP = inflight ?? brain.startInference(cur.prep);
        inflight = null;
        void produce();                   // prepare the next frame while the GPU runs
        const inf = await infP;
        // Start N+1 before N's CPU tail, when its prepared frame is already waiting.
        const next = ready;
        if (next) {
          ready = null;
          inflight = brain.startInference(next.prep);
        }
        const done = cur.job;
        let r;
        try {
          r = await brain.finish(cur.prep, inf);
        } finally {
          done.bitmap.close();
          cur = null;
        }
        port.postMessage({ type: 'tl:state', id: done.id, state: r.state, stats: brain.stats() });
        cur = next;
      }
    } catch (e) {
      // Release whatever this cycle still holds so a GPU/ORT error does not leak frames.
      if (cur) { try { cur.job.bitmap.close(); } catch { /* already closed */ } cur = null; }
      if (ready) { ready.job.bitmap.close(); ready = null; }
      if (inflight) void inflight.catch(() => undefined);
      port.postMessage({ type: 'tl:error', message: String(e) });
    } finally {
      consuming = false;
    }
  }

  port.onmessage = (m: MessageEvent) => {
    const d = m.data;
    if (d?.type === 'tl:hello') {
      port.postMessage({ type: 'tl:hello-ack', from: 'brain', at: performance.now() });
    } else if (d?.type === 'tl:init') {
      void (async () => {
        try {
          loading ??= boot(String(d.source ?? 'broadcast'));
          brain = await loading;
          port.postMessage({ type: 'tl:ready', adapter: brain.adapter });
        } catch (e) {
          loading = null;
          port.postMessage({ type: 'tl:error', message: String(e) });
        }
      })();
    } else if (d?.type === 'tl:cut') {
      // The renderer detected the cut a display frame or two before this cycle's detection.
      brain?.noteCut(Number(d.tMedia));
    } else if (d?.type === 'tl:frame') {
      const bitmap = d.bitmap as ImageBitmap;
      if (!brain) { bitmap.close(); port.postMessage({ type: 'tl:skip', id: d.id }); return; }
      // One-slot queue, newest wins: a delayed frame is stale by definition.
      if (queue) queue.bitmap.close();
      queue = { id: d.id, bitmap, tMedia: d.tMedia, t: d.t, playbackRate: d.playbackRate };
      void produce();
      wakeup();
      void consume();
    }
  };
});
