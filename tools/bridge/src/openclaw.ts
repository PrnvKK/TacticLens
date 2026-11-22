// Trigger OpenClaw through its documented inbound webhook (POST /hooks/agent).
// The agent does the writing; the bridge only supplies live context and the run trigger.
import { classifyHttpError, looksQueueFull, type LLMErrorKind } from '@tacticlens/core';

export interface OpenClawHookConfig {
  url: string;
  token: string;
  agentId: string;
  timeoutMs: number;
}

export interface TriggerResult {
  ok: boolean;
  status?: number;
  runId?: string;
  error?: string;
  /** Shared-queue refusal: the hook run was not admitted by Cerebras. */
  errorKind?: LLMErrorKind;
}

export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: unknown;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface TriggerOptions {
  /** Retry once after a queue_full failure instead of skipping the update (default true). */
  retryQueueFull?: boolean;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function openClawConfigFromEnv(env: Record<string, string | undefined>): OpenClawHookConfig {
  return {
    url: env.OPENCLAW_HOOK_URL || 'http://127.0.0.1:18789/hooks/agent',
    token: env.OPENCLAW_HOOK_TOKEN || '',
    agentId: env.OPENCLAW_AGENT_ID || 'main',
    timeoutMs: Number(env.OPENCLAW_TIMEOUT_MS || 0) > 0 ? Number(env.OPENCLAW_TIMEOUT_MS) : 120_000,
  };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function kindOf(status: number, body: string): LLMErrorKind {
  return looksQueueFull(body) ? 'queue_full' : classifyHttpError(status, body).kind;
}

export async function triggerOpenClaw(
  cfg: OpenClawHookConfig,
  message: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  opts: TriggerOptions = {},
): Promise<TriggerResult> {
  if (!cfg.token) return { ok: false, error: 'OPENCLAW_HOOK_TOKEN is not set' };
  const first = await triggerOnce(cfg, message, fetchImpl);
  if (first.ok || first.errorKind !== 'queue_full' || opts.retryQueueFull === false) return first;
  // A congested Cerebras queue is transient: retry the run once instead of dropping this update.
  await (opts.sleep ?? defaultSleep)(opts.retryDelayMs ?? 2000);
  return triggerOnce(cfg, message, fetchImpl);
}

async function triggerOnce(cfg: OpenClawHookConfig, message: string, fetchImpl: FetchLike): Promise<TriggerResult> {
  const body = JSON.stringify({
    message,
    name: 'TacticLens live update',
    agentId: cfg.agentId,
    sessionMode: 'isolated',
    deliver: false,
    timeoutSeconds: Math.ceil(cfg.timeoutMs / 1000) + 30,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(cfg.timeoutMs, 20_000));
  try {
    const res = await fetchImpl(cfg.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `tl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    let runId: string | undefined;
    let hookOk: boolean | undefined;
    let hookError: string | undefined;
    try {
      const parsed = JSON.parse(text) as { runId?: unknown; ok?: unknown; error?: unknown };
      if (typeof parsed.runId === 'string') runId = parsed.runId;
      if (typeof parsed.ok === 'boolean') hookOk = parsed.ok;
      if (typeof parsed.error === 'string') hookError = parsed.error;
    } catch {
      if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}`, errorKind: kindOf(res.status, text) };
    }
    if (!res.ok) return { ok: false, status: res.status, error: hookError ?? `HTTP ${res.status}`, errorKind: kindOf(res.status, text) };
    // The hook can report a failed agent run in a 200 body; that is still a skipped update.
    if (hookOk === false || hookError) {
      return { ok: false, status: res.status, error: hookError ?? 'hook run failed', errorKind: kindOf(res.status, text) };
    }
    return { ok: true, status: res.status, runId };
  } catch (e) {
    return {
      ok: false,
      error: (e as Error)?.name === 'AbortError' ? 'webhook timed out' : String((e as Error)?.message ?? e),
      errorKind: 'network',
    };
  } finally {
    clearTimeout(timer);
  }
}
