import { browser } from 'wxt/browser';
import type { FrameState, SourceKind } from '@tacticlens/core';

// Bridge between a page (content script) and the hidden brain iframe over a MessageChannel.
// Protocol (port messages):
//   page  -> brain: { type: 'tl:init' }                                   load + warm models
//   brain -> page : { type: 'tl:ready', adapter } | { type: 'tl:error', message }
//   page  -> brain: { type: 'tl:frame', id, bitmap, tMedia, t, playbackRate }   bitmap is transferred; brain closes it
//   page  -> brain: { type: 'tl:cut', tMedia }                             renderer saw a hard cut/seek
//   brain -> page : { type: 'tl:state', id, state: FrameState, stats }    one per frame; doubles as the ack
// Back-pressure: one bitmap in flight, never queue. `sendFrame` returns false when busy.

export interface BrainStats {
  hz: number;
  stages: Record<string, { p50: number; p95: number }>;
  cycles: number;
  quality: number;
  newIdsPerMinute?: number;
  /** Active source profile (broadcast or game; auto resolves to one of them). */
  profile?: 'broadcast' | 'game';
}

export interface BrainHandle {
  ready: Promise<{ adapter: string }>;
  /** Transfers `bitmap` to the brain. Returns false (and does not consume the bitmap) if a frame is still in flight. */
  sendFrame(bitmap: ImageBitmap, tMedia: number, t: number, playbackRate: number): boolean;
  /** Renderer-side display cut: force a hard tracker cut at the first detection at/after `tMedia`. */
  sendCut(tMedia: number): void;
  onState(cb: (state: FrameState, stats: BrainStats) => void): void;
  /** Called when the brain reports an error for a frame (the in-flight slot is released). */
  onError(cb: (message: string) => void): void;
  stop(): void;
}

function mountBrain(): { iframe: HTMLIFrameElement; channel: MessageChannel; origin: string; loaded: Promise<void> } {
  // Extension pages resolve through the runtime; a plain http page (dev / verification server) falls back to a sibling URL.
  const url = browser?.runtime?.getURL ? browser.runtime.getURL('/brain.html') : new URL('brain.html', location.href).href;
  const origin = new URL(url).origin;
  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.style.display = 'none';
  iframe.setAttribute('aria-hidden', 'true');
  const channel = new MessageChannel();
  const loaded = new Promise<void>((resolve, reject) => {
    iframe.addEventListener('error', () => reject(new Error('brain iframe failed to load')));
    iframe.addEventListener('load', () => {
      iframe.contentWindow?.postMessage({ type: 'tl:port' }, origin, [channel.port2]);
      resolve();
    });
  });
  document.documentElement.append(iframe);
  return { iframe, channel, origin, loaded };
}

// Injects the hidden brain iframe and sends a hello over a MessageChannel (the ack is not used).
// Resolves with a cleanup function that closes the port and removes the iframe.
export function startBrain(): Promise<() => void> {
  const { iframe, channel, loaded } = mountBrain();
  const stop = (): void => {
    channel.port1.close();
    iframe.remove();
  };
  return loaded.then(() => {
    channel.port1.postMessage({ type: 'tl:hello', from: 'content' });
    return stop;
  });
}

/** Full perception link: loads models in the brain and streams FrameState back. */
export function connectBrain(source: SourceKind = 'broadcast'): BrainHandle {
  const { iframe, channel, loaded } = mountBrain();
  let inFlight = false;
  let nextId = 1;
  let listener: ((s: FrameState, st: BrainStats) => void) | null = null;
  let errListener: ((m: string) => void) | null = null;
  let resolveReady!: (v: { adapter: string }) => void;
  let rejectReady!: (e: Error) => void;
  const ready = new Promise<{ adapter: string }>((res, rej) => { resolveReady = res; rejectReady = rej; });

  channel.port1.onmessage = (ev: MessageEvent) => {
    const m = ev.data;
    if (m?.type === 'tl:ready') resolveReady({ adapter: m.adapter });
    else if (m?.type === 'tl:error') { inFlight = false; rejectReady(new Error(m.message)); errListener?.(m.message); console.error('[TacticLens brain]', m.message); }
    else if (m?.type === 'tl:skip') { inFlight = false; }   // frame dropped before the brain was ready
    else if (m?.type === 'tl:state') { inFlight = false; listener?.(m.state, m.stats); }
  };
  loaded.then(() => channel.port1.postMessage({ type: 'tl:init', source }), rejectReady);

  return {
    ready,
    sendFrame(bitmap, tMedia, t, playbackRate) {
      if (inFlight) return false;
      inFlight = true;
      channel.port1.postMessage({ type: 'tl:frame', id: nextId++, bitmap, tMedia, t, playbackRate }, [bitmap]);
      return true;
    },
    sendCut(tMedia) {
      channel.port1.postMessage({ type: 'tl:cut', tMedia });
    },
    onState(cb) { listener = cb; },
    onError(cb) { errListener = cb; },
    stop() { channel.port1.close(); iframe.remove(); },
  };
}
