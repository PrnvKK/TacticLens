// Page-side client for the background LLM host. Never sees an API key.
import { browser } from 'wxt/browser';
import type { LLMEvent, LaneOutcome, LLMRequest, MockProfile, PresetId, RaceResult } from '@tacticlens/core';
import type { RecvStamp } from '../speed/receipt';
import { LLM_PORT, type FromBg, type ToBg } from './protocol';

type Port = ReturnType<typeof browser.runtime.connect>;
let port: Port | null = null;
const handlers = new Map<string, (m: FromBg) => void>();
let seq = 0;

/** A page-wide listener on every real (background-hosted) stream event. Used by the speed wall. */
export interface LlmEventMeta {
  callId: string;
  preset: PresetId;
  lane?: string;
  side?: 'a' | 'b';
  /** Network-receipt stamp from the worker (absent only for a local mock). */
  stamp?: RecvStamp;
}
export type LlmEventTap = (e: LLMEvent, meta: LlmEventMeta) => void;
let tap: LlmEventTap | null = null;

/**
 * Register the one page-wide event tap. Several components could subscribe, but the wall needs a
 * single shared feed, so a second registration replaces the first. The returned function detaches
 * only if this tap is still the active one.
 */
export function setLlmEventTap(fn: LlmEventTap | null): () => void {
  tap = fn;
  return () => { if (tap === fn) tap = null; };
}

function emitTap(e: LLMEvent, meta: LlmEventMeta): void {
  try { tap?.(e, meta); } catch { /* the wall must never break a live call */ }
}

function getPort(): Port {
  if (port) return port;
  const p = browser.runtime.connect({ name: LLM_PORT });
  p.onMessage.addListener((m: FromBg) => handlers.get(m.id)?.(m));
  p.onDisconnect.addListener(() => { port = null; });
  port = p;
  return p;
}
const nextId = () => `c${++seq}`;

export interface CallHandle { id: string; done: Promise<LaneOutcome>; cancel(): void }

export function llmCall(
  preset: PresetId, request: LLMRequest,
  opts: { onEvent?: (e: LLMEvent) => void; policy?: 'replace' | 'drop' | 'parallel'; mockProfile?: MockProfile } = {},
): CallHandle {
  const id = nextId();
  const done = new Promise<LaneOutcome>((resolve) => {
    handlers.set(id, (m) => {
      if (m.kind === 'event') {
        emitTap(m.event, { callId: id, preset, lane: request.lane, stamp: { tRecv: m.tRecv, tOrigin: m.tOrigin } });
        opts.onEvent?.(m.event);
      } else if (m.kind === 'outcome') { handlers.delete(id); resolve(m.outcome); }
      else if (m.kind === 'error') { handlers.delete(id); resolve({ status: 'skipped', reason: 'busy' }); }
    });
  });
  const msg: ToBg = { type: 'call', id, preset, request, policy: opts.policy, mockProfile: opts.mockProfile };
  getPort().postMessage(msg);
  return { id, done, cancel: () => getPort().postMessage({ type: 'cancel', id } satisfies ToBg) };
}

export function llmRace(
  a: PresetId, b: PresetId, request: LLMRequest,
  opts: { onEvent?: (side: 'a' | 'b', e: LLMEvent, stamp?: RecvStamp) => void; mockA?: MockProfile; mockB?: MockProfile } = {},
): { done: Promise<RaceResult>; cancel(): void } {
  const id = nextId();
  const done = new Promise<RaceResult>((resolve, reject) => {
    handlers.set(id, (m) => {
      if (m.kind === 'event' && m.side) {
        const stamp = { tRecv: m.tRecv, tOrigin: m.tOrigin };
        opts.onEvent?.(m.side, m.event, stamp);
        emitTap(m.event, { callId: `${id}:${m.side}`, preset: m.side === 'a' ? a : b, side: m.side, stamp });
      } else if (m.kind === 'race') { handlers.delete(id); resolve(m.result); }
      else if (m.kind === 'error') { handlers.delete(id); reject(new Error(m.error)); }
    });
  });
  getPort().postMessage({ type: 'race', id, a, b, request, mockA: opts.mockA, mockB: opts.mockB } satisfies ToBg);
  return { done, cancel: () => getPort().postMessage({ type: 'cancel', id } satisfies ToBg) };
}

export function llmWarmup(preset: PresetId): Promise<number | null> {
  const id = nextId();
  return new Promise((resolve) => {
    handlers.set(id, (m) => { if (m.kind === 'warmup') { handlers.delete(id); resolve(m.ms); } });
    getPort().postMessage({ type: 'warmup', id, preset } satisfies ToBg);
  });
}

/** Which presets have a key stored in the background (names only, never the key). */
export function llmKeys(): Promise<Partial<Record<PresetId, boolean>>> {
  const id = nextId();
  return new Promise((resolve) => {
    handlers.set(id, (m) => { if (m.kind === 'keys') { handlers.delete(id); resolve(m.keys); } });
    getPort().postMessage({ type: 'keys', id } satisfies ToBg);
  });
}

export function llmStats(): Promise<{ stats: unknown; pulse: unknown }> {
  const id = nextId();
  return new Promise((resolve) => {
    handlers.set(id, (m) => { if (m.kind === 'stats') { handlers.delete(id); resolve({ stats: m.stats, pulse: m.pulse }); } });
    getPort().postMessage({ type: 'stats', id } satisfies ToBg);
  });
}
