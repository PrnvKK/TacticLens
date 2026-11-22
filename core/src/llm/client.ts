// Streaming OpenAI-compatible chat client. fetch is injectable; `mock://` providers route to the mock.
import type { LLMProvider } from '../types';
import { SseParser } from './sse';
import { StreamingField, parsePartialJson } from './partialJson';
import type { CallTiming } from './timing';
import { buildBody, chatUrl, countImages, type LLMRequest } from './providers';
import { sharedMockFetch, type MockProfile } from './mock';
import { classifyHttpError, classifyNetworkError, type LLMErrorKind } from './errors';

// Minimal structural types so core stays DOM-free.
export interface ReaderLike { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> | void }
export interface ResponseLike {
  ok: boolean; status: number;
  headers: { get(name: string): string | null };
  body: { getReader(): ReaderLike } | null;
  text(): Promise<string>;
}
export interface FetchInit { method: string; headers: Record<string, string>; body: string; signal?: unknown }
export type FetchLike = (url: string, init: FetchInit) => Promise<ResponseLike>;

export type LLMEvent =
  | { type: 'start'; tRequest: number }
  | { type: 'first_byte'; tFirstByte: number }
  | { type: 'first_token'; tFirstToken: number; ttftMs: number }
  | { type: 'delta'; text: string }
  /** Hidden reasoning text (Kimi K3.1 streams `delta.reasoning` before the answer). Counted as
   *  output tokens by the API, so the TPS wall must see it; it is never shown in the overlay. */
  | { type: 'reasoning'; text: string }
  | { type: 'say'; text: string; complete: boolean }          // streamed `say` text so far
  | { type: 'partial'; value: unknown }                       // best-effort partial parse of the whole object
  | { type: 'json'; value: unknown }                          // the JSON object just closed (fires once, before usage/done)
  | { type: 'done'; result: CallResult }
  /** `errorKind` separates a congested shared queue from our own rate limit. code/message are the
   *  raw provider fields (never a secret) so callers can report them without re-parsing the body. */
  | { type: 'error'; error: string; status?: number; retryAfterMs?: number; errorKind?: LLMErrorKind; code?: string; message?: string };

export interface CallResult {
  ok: boolean;
  aborted: boolean;
  status: number;
  text: string;
  parsed: unknown;          // undefined if not valid JSON
  parseOk: boolean;
  timing: CallTiming;
  error?: string;
  retryAfterMs?: number;
  errorKind?: LLMErrorKind;
  errorCode?: string;
  errorMessage?: string;
}

export interface StreamOptions {
  provider: LLMProvider;
  request: LLMRequest;
  onEvent?: (e: LLMEvent) => void;
  signal?: { aborted: boolean; addEventListener?: (t: 'abort', fn: () => void) => void; removeEventListener?: (t: 'abort', fn: () => void) => void };
  abort?: () => void;       // not used by client itself; kept for symmetry
  fetchImpl?: FetchLike;
  now?: () => number;
  sayField?: string | null; // default 'say'; null disables
  mockProfile?: MockProfile;
}

const g = globalThis as unknown as {
  fetch?: FetchLike; performance?: { now(): number }; TextDecoder: new () => { decode(b?: Uint8Array, o?: { stream: boolean }): string };
};

export function defaultNow(): number { return g.performance ? g.performance.now() : Date.now(); }

export function estimateTokens(text: string): number { return Math.ceil(text.length / 3.5); }

function approxInputTokens(req: LLMRequest): number {
  let n = 0;
  for (const m of req.messages) {
    if (typeof m.content === 'string') n += estimateTokens(m.content);
    else for (const p of m.content) n += p.type === 'text' ? estimateTokens(p.text) : 800; // rough fixed cost per image
  }
  return n;
}

export function pickFetch(provider: LLMProvider, fetchImpl?: FetchLike, mockProfile?: MockProfile): FetchLike {
  if (fetchImpl) return fetchImpl;
  if (provider.baseURL.startsWith('mock://')) return sharedMockFetch(mockProfile ?? 'cerebras');
  if (!g.fetch) throw new Error('no fetch available');
  return g.fetch.bind(globalThis) as FetchLike;
}

export async function streamChat(opts: StreamOptions): Promise<CallResult> {
  const { provider, request, onEvent, signal } = opts;
  const now = opts.now ?? defaultNow;
  const emit = (e: LLMEvent) => { try { onEvent?.(e); } catch { /* listener errors never break the stream */ } };
  const timing: CallTiming = {
    provider: provider.name, lane: request.lane, tRequest: now(), tFirstByte: null, tFirstToken: null, tDone: null,
    ttftMs: 0, totalMs: 0, tokensIn: 0, tokensOut: 0, tokPerS: 0, framesSent: request.framesSent ?? countImages(request.messages),
    usageReported: false,
  };
  const result = (p: Partial<CallResult> & { text: string }): CallResult => {
    timing.tDone = now();
    timing.totalMs = timing.tDone - timing.tRequest;
    timing.ttftMs = timing.tFirstToken != null ? timing.tFirstToken - timing.tRequest : timing.totalMs;
    if (!timing.usageReported) {
      timing.tokensIn = approxInputTokens(request);
      timing.tokensOut = estimateTokens(p.text);
    }
    const genMs = timing.tFirstToken != null ? Math.max(1, timing.tDone - timing.tFirstToken) : 0;
    timing.tokPerS = genMs ? (timing.tokensOut / genMs) * 1000 : 0;
    let parsed: unknown;
    let parseOk = false;
    if (p.text) { try { parsed = JSON.parse(p.text); parseOk = true; } catch { /* leave undefined */ } }
    const r: CallResult = { ok: false, aborted: false, status: 0, parsed, parseOk, timing, ...p };
    return r;
  };

  let reader: ReaderLike | null = null;
  const onAbort = () => { try { void reader?.cancel('aborted'); } catch { /* ignore */ } };
  signal?.addEventListener?.('abort', onAbort);

  emit({ type: 'start', tRequest: timing.tRequest });
  let text = '';
  try {
    const f = pickFetch(provider, opts.fetchImpl, opts.mockProfile);
    const res = await f(chatUrl(provider.baseURL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) },
      body: JSON.stringify(buildBody(provider, request, true)),
      signal,
    });
    timing.tFirstByte = now();
    emit({ type: 'first_byte', tFirstByte: timing.tFirstByte });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
      const info = classifyHttpError(res.status, detail, res.headers);
      const error = `HTTP ${res.status} ${detail}`.trim();
      emit({
        type: 'error', error, status: res.status, retryAfterMs: info.retryAfterMs,
        errorKind: info.kind, ...(info.code ? { code: info.code } : {}), ...(info.message ? { message: info.message } : {}),
      });
      const r = result({
        text: '', status: res.status, error, retryAfterMs: info.retryAfterMs, errorKind: info.kind,
        ...(info.code ? { errorCode: info.code } : {}), ...(info.message ? { errorMessage: info.message } : {}),
      });
      emit({ type: 'done', result: r });
      return r;
    }
    if (!res.body) throw new Error('response has no body');
    reader = res.body.getReader();
    const dec = new g.TextDecoder();
    const sse = new SseParser();
    const say = opts.sayField === null ? null : new StreamingField(opts.sayField ?? 'say');
    let finished = false;
    let jsonClosed = false;

    const handle = (data: string) => {
      if (data === '[DONE]') { finished = true; return; }
      let j: any;
      try { j = JSON.parse(data); } catch { return; }
      if (j.error) { throw new Error(typeof j.error === 'string' ? j.error : j.error.message ?? 'stream error'); }
      if (j.usage) {
        timing.usageReported = true;
        timing.tokensIn = j.usage.prompt_tokens ?? timing.tokensIn;
        timing.tokensOut = j.usage.completion_tokens ?? timing.tokensOut;
        timing.cachedTokens = j.usage.prompt_tokens_details?.cached_tokens ?? 0;
      }
      const reason: string | undefined = j.choices?.[0]?.delta?.reasoning ?? j.choices?.[0]?.delta?.reasoning_content;
      if (reason) {
        // Hidden reasoning is billed as output and streams before the answer. It is the real first
        // output token: TTFT and TPS must start here, not at the first visible JSON character. Before
        // this fix the core timing used only `delta.content`, so a reasoning-heavy call reported a
        // tiny decode window (and absurd TPS) while the wall counted the reasoning tokens.
        if (timing.tFirstToken == null) {
          timing.tFirstToken = now();
          emit({ type: 'first_token', tFirstToken: timing.tFirstToken, ttftMs: timing.tFirstToken - timing.tRequest });
        }
        emit({ type: 'reasoning', text: reason });
      }
      const delta: string | undefined = j.choices?.[0]?.delta?.content;
      if (delta) {
        if (timing.tFirstToken == null) {
          timing.tFirstToken = now();
          emit({ type: 'first_token', tFirstToken: timing.tFirstToken, ttftMs: timing.tFirstToken - timing.tRequest });
        }
        text += delta;
        emit({ type: 'delta', text: delta });
        if (say) {
          const v = say.push(delta);
          if (v !== null) emit({ type: 'say', text: v, complete: say.complete });
        }
        if (request.schema) {
          const pv = parsePartialJson(text);
          if (pv !== undefined) emit({ type: 'partial', value: pv });
          if (!jsonClosed && delta.includes('}') && text.trimEnd().endsWith('}')) {
            try { const v = JSON.parse(text); jsonClosed = true; emit({ type: 'json', value: v }); } catch { /* not closed yet */ }
          }
        }
      }
    };

    while (!finished) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      for (const ev of sse.push(dec.decode(value, { stream: true }))) handle(ev.data);
    }
    if (!signal?.aborted) for (const ev of sse.end()) handle(ev.data);
    if (signal?.aborted) {
      try { await reader.cancel('aborted'); } catch { /* ignore */ }
      const r = result({ text, aborted: true, status: res.status, error: 'aborted' });
      emit({ type: 'done', result: r });
      return r;
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    const r = result({ text, ok: true, status: res.status });
    emit({ type: 'done', result: r });
    return r;
  } catch (err) {
    const aborted = !!signal?.aborted || (err as { name?: string })?.name === 'AbortError';
    const error = aborted ? 'aborted' : String((err as Error)?.message ?? err);
    const info = aborted ? null : classifyNetworkError(err);
    if (!aborted && info) {
      emit({ type: 'error', error, errorKind: info.kind, ...(info.code ? { code: info.code } : {}), ...(info.message ? { message: info.message } : {}) });
    }
    const r = result({
      text, aborted, error,
      ...(info ? { errorKind: info.kind, ...(info.code ? { errorCode: info.code } : {}), ...(info.message ? { errorMessage: info.message } : {}) } : {}),
    });
    emit({ type: 'done', result: r });
    return r;
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * Warm-up: a 1-token call so TLS/HTTP2 is hot and, when the real stable prefix is supplied, the
 * provider's prefix cache is primed before the first user-visible call. Returns ms or null.
 */
export async function warmUp(provider: LLMProvider, fetchImpl?: FetchLike, stablePrefix?: string): Promise<number | null> {
  if (provider.baseURL.startsWith('mock://')) return 0;
  const t0 = defaultNow();
  const messages = stablePrefix
    ? [{ role: 'system' as const, content: stablePrefix }, { role: 'user' as const, content: '.' }]
    : [{ role: 'user' as const, content: 'ping' }];
  const r = await streamChat({
    provider, fetchImpl, sayField: null,
    request: { lane: 'reflex', messages, maxCompletionTokens: 1, reasoningEffort: 'low' },
  });
  return r.ok ? defaultNow() - t0 : null;
}
