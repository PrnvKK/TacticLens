// Shared helpers for the live LLM tools (calibrate, soak). The API key is read from .env and never printed.
// Kimi is the only model family: CEREBRAS_KIMI_MODEL is required, there is no fallback model.
import { readFileSync } from 'node:fs';
import { KIMI_MODEL_ENV, resolveProvider, streamChat, QueueRetryMeter, withQueueRetry, type CallResult, type LLMProvider, type LLMRequest } from '../../core/src/llm/index';

export function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const text = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env */ }
  for (const k of ['CEREBRAS_API_KEY', KIMI_MODEL_ENV, 'CEREBRAS_BASE_URL', 'OPENROUTER_API_KEY', 'GPU_BASELINE_MODEL', 'GPU_BASELINE_PROVIDER']) {
    if (process.env[k]) out[k] = process.env[k]!;
  }
  return out;
}

export interface LiveSetup { provider: LLMProvider; model: string }

export function liveSetup(): LiveSetup | null {
  const env = loadEnv();
  const key = env.CEREBRAS_API_KEY;
  const model = env[KIMI_MODEL_ENV]?.trim() ?? '';
  if (!key || !model) return null;
  const baseURL = env.CEREBRAS_BASE_URL?.trim();
  return { provider: resolveProvider('cerebras-kimi', key, { model, ...(baseURL ? { baseURL } : {}) }), model };
}

export interface Measured {
  ok: boolean; status: number; ttftMs: number; totalMs: number;
  prompt: number; cached: number; completion: number; parsed: unknown; parseOk: boolean; error?: string; text: string;
  /** Shared-queue / rate-limit accounting for this call (retries included). */
  queueFull: number; rateLimited: number; retries: number; retrySuccess: boolean;
}

export interface MeasureOptions {
  meter?: QueueRetryMeter;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxRetries?: number;
}

/** One real call with the shared queue_full retry policy. Errors never contain the key. */
export async function measure(provider: LLMProvider, request: LLMRequest, opts: MeasureOptions = {}): Promise<Measured> {
  const meter = opts.meter ?? new QueueRetryMeter();
  const before = { q: meter.queueFull, r: meter.rateLimited, retries: meter.retries, ok: meter.retrySuccess };
  const r: CallResult = await withQueueRetry(
    () => streamChat({ provider, request }),
    (res) => (res.errorKind === 'queue_full'
      ? { kind: 'queue_full', status: res.status, ...(res.errorCode ? { code: res.errorCode } : {}), ...(res.errorMessage ? { message: res.errorMessage } : {}) }
      : null),
    { meter, sleep: opts.sleep, random: opts.random, maxRetries: opts.maxRetries },
  );
  const t = r.timing;
  return {
    ok: r.ok, status: r.status, ttftMs: Math.round(t.tFirstToken != null ? t.ttftMs : 0), totalMs: Math.round(t.totalMs),
    prompt: t.usageReported ? t.tokensIn : 0, cached: t.cachedTokens ?? 0, completion: t.usageReported ? t.tokensOut : 0,
    parsed: r.parsed, parseOk: r.parseOk, error: r.error, text: r.text,
    queueFull: meter.queueFull - before.q, rateLimited: meter.rateLimited - before.r,
    retries: meter.retries - before.retries, retrySuccess: meter.retrySuccess > before.ok,
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
