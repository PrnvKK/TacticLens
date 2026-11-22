// Cerebras OpenAI-compatible chat call used only by `pnpm bridge --dry`.
// The live path goes through OpenClaw; this exists so the prompt can be tested without Telegram.
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface ChatOpts {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ChatResult {
  text: string;
  ms: number;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export async function chat(opts: ChatOpts, messages: ChatMessage[]): Promise<ChatResult> {
  if (!opts.apiKey) throw new Error('CEREBRAS_API_KEY is not set');
  const base = (opts.baseUrl || 'https://api.cerebras.ai/v1').replace(/\/+$/, '');
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        messages,
        stream: false,
        max_completion_tokens: opts.maxTokens ?? 260,
        reasoning_effort: 'low',
        temperature: 0.4,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Cerebras HTTP ${res.status}: ${text.slice(0, 300)}`);
    const json = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: (json.choices?.[0]?.message?.content ?? '').trim(),
      ms: Date.now() - started,
      model: opts.model,
      tokensIn: json.usage?.prompt_tokens ?? 0,
      tokensOut: json.usage?.completion_tokens ?? 0,
    };
  } finally {
    clearTimeout(timer);
  }
}
