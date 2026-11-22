import type { LLMProvider } from '../types';

// Kimi is the ONLY model family in this app, for every role. There is deliberately no non-Kimi
// fallback: if the model id is missing the caller must surface a configuration error instead.
// 'cerebras-dev' is a DEPRECATED id kept only so stored settings and older host code still compile;
// it carries no model of its own and can never reach another family. The popup never offers it.
export type PresetId = 'cerebras-kimi' | 'cerebras-dev' | 'gpu-baseline' | 'mock';
export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface Preset {
  id: PresetId;
  provider: Omit<LLMProvider, 'apiKey'>;
  note: string;
}

export const KIMI_MODEL_ENV = 'CEREBRAS_KIMI_MODEL';
export const GPU_BASELINE_DEFAULT_MODEL = 'moonshotai/kimi-k3.1-pro';
export const GPU_BASELINE_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const GPU_BASELINE_MODEL_ENV = 'GPU_BASELINE_MODEL';
export const GPU_BASELINE_PROVIDER_ENV = 'GPU_BASELINE_PROVIDER';
export const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';

// Build-time injected by extension/wxt.config.ts (only ids/base URL, never the API key).
// `typeof` keeps this safe in Node tests where the define is absent.
declare const __TL_GPU_BASELINE_MODEL__: string | undefined;
declare const __TL_GPU_BASELINE_PROVIDER__: string | undefined;

function defineValue(v: string | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

export interface GpuBaselineConfig { model: string; provider: string; baseURL: string }

let gpuConfig: GpuBaselineConfig = {
  model: defineValue(typeof __TL_GPU_BASELINE_MODEL__ === 'string' ? __TL_GPU_BASELINE_MODEL__ : '') || GPU_BASELINE_DEFAULT_MODEL,
  provider: defineValue(typeof __TL_GPU_BASELINE_PROVIDER__ === 'string' ? __TL_GPU_BASELINE_PROVIDER__ : ''),
  baseURL: GPU_BASELINE_DEFAULT_BASE_URL,
};

/** Override the GPU baseline config (tests, tools, or a host that reads its own env). */
export function configureGpuBaseline(cfg: Partial<GpuBaselineConfig> | null): void {
  const next: GpuBaselineConfig = {
    model: (cfg?.model ?? GPU_BASELINE_DEFAULT_MODEL).trim() || GPU_BASELINE_DEFAULT_MODEL,
    provider: (cfg?.provider ?? '').trim(),
    baseURL: (cfg?.baseURL ?? GPU_BASELINE_DEFAULT_BASE_URL).trim() || GPU_BASELINE_DEFAULT_BASE_URL,
  };
  gpuConfig = next;
}

export function gpuBaselineConfig(): GpuBaselineConfig { return { ...gpuConfig }; }

export interface GpuBaselineStatus {
  configured: boolean;
  label: string;
  model: string;
  provider: string;
  reason?: string;
}

/** Honest configuration state for the race UI. No fake data: unconfigured is unconfigured. */
export function gpuBaselineStatus(apiKey?: string | null): GpuBaselineStatus {
  const cfg = gpuBaselineConfig();
  const base = { model: cfg.model, provider: cfg.provider };
  if (!cfg.provider) return { configured: false, label: 'not configured', ...base, reason: `Set ${GPU_BASELINE_PROVIDER_ENV} to pin one GPU host` };
  if (apiKey !== undefined && apiKey !== null && !apiKey.trim()) return { configured: false, label: 'not configured', ...base, reason: `Set ${OPENROUTER_KEY_ENV} or save the gpu-baseline key in the popup` };
  return { configured: true, label: `gpu-baseline:${cfg.provider}`, ...base };
}

/** The explicit error shown in the popup/HUD when the Cerebras model id is missing. */
export function kimiModelError(model: string | null | undefined): string | null {
  return model && model.trim() ? null : `Set ${KIMI_MODEL_ENV}`;
}

// Generic OpenAI-compatible presets. Nothing model-specific lives in code beyond these records.
// The Cerebras Kimi model id is intentionally not hard-coded: CEREBRAS_KIMI_MODEL (popup setting or
// build-time env) is required. There is no fallback model.
export const PRESETS: Record<PresetId, Preset> = {
  'cerebras-kimi': {
    id: 'cerebras-kimi',
    provider: {
      name: 'cerebras-kimi', baseURL: 'https://api.cerebras.ai/v1',
      model: '', supportsImages: true,
    },
    note: `Kimi on Cerebras. ${KIMI_MODEL_ENV} (popup or build env) is required; no fallback model exists.`,
  },
  'gpu-baseline': {
    id: 'gpu-baseline',
    provider: {
      name: 'gpu-baseline', baseURL: GPU_BASELINE_DEFAULT_BASE_URL,
      model: GPU_BASELINE_DEFAULT_MODEL, supportsImages: true,
    },
    note: `Kimi K3.1 Pro on a GPU host through OpenRouter. ${GPU_BASELINE_PROVIDER_ENV} pins the host; key from ${OPENROUTER_KEY_ENV} or the popup.`,
  },
  // DEPRECATED (dead): kept only for old stored settings/host lists. No model, no fallback, never in the popup.
  'cerebras-dev': {
    id: 'cerebras-dev',
    provider: { name: 'cerebras-dev (deprecated)', baseURL: 'https://api.cerebras.ai/v1', model: '', supportsImages: true },
    note: 'Deprecated id with no model. Use cerebras-kimi; there is no other model family.',
  },
  mock: {
    id: 'mock',
    provider: { name: 'mock', baseURL: 'mock://local', model: 'mock', supportsImages: true },
    note: 'Offline schema-valid stream; no key. Reached only through ?mock=1.',
  },
};

export function resolveProvider(preset: PresetId, apiKey: string, overrides?: Partial<LLMProvider>): LLMProvider {
  if (preset === 'gpu-baseline') {
    const cfg = gpuBaselineConfig();
    const pinned = cfg.provider
      ? { provider: { order: [cfg.provider], allow_fallbacks: false } }
      : {};
    return {
      ...PRESETS['gpu-baseline'].provider,
      model: cfg.model,
      baseURL: cfg.baseURL,
      name: cfg.provider ? `gpu-baseline:${cfg.provider}` : 'gpu-baseline',
      apiKey,
      ...overrides,
      extra: { ...pinned, ...(overrides?.extra ?? {}) },
    };
  }
  return { ...PRESETS[preset].provider, apiKey, ...overrides };
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string | ChatContentPart[] }

export interface LLMRequest {
  messages: ChatMessage[];
  lane: 'reflex' | 'watch' | 'ask' | 'replay' | 'scout' | 'director';
  schema?: { name: string; schema: object } | null; // null/undefined = plain text
  maxCompletionTokens?: number;
  reasoningEffort?: ReasoningEffort;
  framesSent?: number;
}

export const DEFAULT_MAX_COMPLETION_TOKENS = 300; // output cap when a request sets none

export function imageDataUrlPart(base64Jpeg: string, mime = 'image/jpeg'): ChatContentPart {
  const url = base64Jpeg.startsWith('data:') ? base64Jpeg : `data:${mime};base64,${base64Jpeg}`;
  return { type: 'image_url', image_url: { url } };
}

export function countImages(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) if (Array.isArray(m.content)) for (const p of m.content) if (p.type === 'image_url') n++;
  return n;
}

/** Build the request body. reasoning_effort is ALWAYS set (default "low"). */
export function buildBody(provider: Omit<LLMProvider, 'apiKey'>, req: LLMRequest, stream = true): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: provider.model,
    messages: req.messages,
    stream,
    max_completion_tokens: req.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
    reasoning_effort: req.reasoningEffort ?? 'low',
  };
  if (stream) body.stream_options = { include_usage: true };
  if (req.schema) {
    body.response_format = { type: 'json_schema', json_schema: { name: req.schema.name, strict: true, schema: req.schema.schema } };
  }
  if (provider.extra) Object.assign(body, provider.extra);
  if (body.reasoning_effort == null) body.reasoning_effort = req.reasoningEffort ?? 'low';
  return body;
}

export function chatUrl(baseURL: string): string {
  return baseURL.replace(/\/+$/, '') + '/chat/completions';
}
