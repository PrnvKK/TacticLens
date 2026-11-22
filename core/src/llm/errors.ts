// Shared HTTP error classification. Cerebras overloads its shared queue and refuses requests with
// HTTP 429 {"code":"queue_exceeded"}; those must NOT be treated as our rate limit. Every consumer
// (director, watch lane, tools, bridge) classifies errors through this one function.
export type LLMErrorKind = 'queue_full' | 'rate_limited' | 'server' | 'client' | 'network';

export interface LLMErrorInfo {
  kind: LLMErrorKind;
  status?: number;
  /** Provider error code, for example "queue_exceeded". */
  code?: string;
  /** Provider message, for example "We're experiencing high traffic right now!". Never a secret. */
  message?: string;
  retryAfterMs?: number;
}

export interface HeaderLike { get(name: string): string | null }

interface BodyFields { code?: string; param?: string; message?: string; type?: string }

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function bodyFields(body: string | undefined): BodyFields {
  if (!body) return {};
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const nested = j.error && typeof j.error === 'object' ? j.error as Record<string, unknown> : null;
    const root = nested ?? j;
    return {
      code: str(root.code) ?? str(j.code),
      param: str(root.param) ?? str(j.param),
      message: str(root.message) ?? str(j.message),
      type: str(root.type) ?? str(j.type),
    };
  } catch {
    return { message: body.replace(/\s+/g, ' ').trim().slice(0, 300) };
  }
}

/** True when a provider body/error names the shared-queue refusal (not our rate limit). */
export function looksQueueFull(body: string | undefined): boolean {
  if (!body) return false;
  const f = bodyFields(body);
  if (f.code?.toLowerCase() === 'queue_exceeded') return true;
  if (f.param?.toLowerCase() === 'queue') return true;
  if (f.message && /high traffic/i.test(f.message)) return true;
  return /queue_exceeded|"param"\s*:\s*"queue"|high traffic/i.test(body);
}

/** Any x-ratelimit header at zero means the 429 is a genuine account rate limit. */
export function headersExhausted(headers?: HeaderLike | null): boolean {
  if (!headers) return false;
  const names = [
    'x-ratelimit-remaining', 'x-ratelimit-remaining-requests', 'x-ratelimit-remaining-tokens',
    'x-ratelimit-requests-remaining', 'x-ratelimit-tokens-remaining',
  ];
  for (const n of names) {
    const v = headers.get(n);
    if (v !== null && Number(v) === 0) return true;
  }
  return false;
}

export function retryAfterMs(headers?: HeaderLike | null): number | undefined {
  if (!headers) return undefined;
  const ra = headers.get('retry-after');
  if (!ra) return undefined;
  const n = Number(ra);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : undefined;
}

/**
 * Classify an HTTP failure:
 * - queue_full: 429 whose body says code "queue_exceeded", param "queue", or message "high traffic"
 * - rate_limited: any other 429 (including one whose x-ratelimit headers show exhaustion)
 * - server: 5xx
 * - client: other 4xx
 * - network: no HTTP status (fetch/transport failure)
 */
export function classifyHttpError(status: number | undefined, body?: string, headers?: HeaderLike | null): LLMErrorInfo {
  const f = bodyFields(body);
  const base = {
    ...(status !== undefined && status > 0 ? { status } : {}),
    ...(f.code ? { code: f.code } : {}),
    ...(f.message ? { message: f.message } : {}),
    ...(retryAfterMs(headers) !== undefined ? { retryAfterMs: retryAfterMs(headers) } : {}),
  };
  if (status === 429) {
    // A queue refusal can also carry exhausted headers; the queue markers win.
    const kind: LLMErrorKind = looksQueueFull(body) ? 'queue_full' : 'rate_limited';
    return { kind, ...base };
  }
  if (status !== undefined && status >= 500) return { kind: 'server', ...base };
  if (status !== undefined && status >= 400) return { kind: 'client', ...base };
  return { kind: 'network', ...base };
}

/** Classify a thrown transport error (never an abort, which callers handle separately). */
export function classifyNetworkError(err: unknown): LLMErrorInfo {
  const message = String((err as Error)?.message ?? err ?? 'network error');
  return { kind: 'network', message: message.slice(0, 300) };
}
