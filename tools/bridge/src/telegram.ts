// Direct Telegram ping for the 10 s demo cadence. It forwards the line already shown in the
// Theatre's left-hand chat, so a ping costs no extra model call. OpenClaw remains available for
// follow-up questions and can be restored for proactive updates with BRIDGE_PING_MODE=agent.
export interface TelegramConfig {
  botToken: string;
  chatId: string;
  apiBase: string;
}

export interface TelegramResult {
  ok: boolean;
  status?: number;
  error?: string;
}

type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: unknown;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export function telegramConfigFromEnv(env: Record<string, string | undefined>): TelegramConfig {
  return {
    botToken: (env.TELEGRAM_BOT_TOKEN || '').trim(),
    chatId: (env.TELEGRAM_CHAT_ID || '').trim(),
    apiBase: (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
  };
}

export function telegramConfigured(cfg: TelegramConfig): boolean {
  return !!cfg.botToken && !!cfg.chatId;
}

/** Send one plain text message. The token only appears in the request URL and is never logged. */
export async function sendTelegramText(
  cfg: TelegramConfig,
  text: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = 8000,
): Promise<TelegramResult> {
  if (!telegramConfigured(cfg)) return { ok: false, error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set' };
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 3500);
  if (!clean) return { ok: false, error: 'empty message' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await fetchImpl(`${cfg.apiBase}/bot${cfg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text: clean, disable_web_page_preview: true }),
      signal: controller.signal,
    });
    const raw = await res.text().catch(() => '');
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    try {
      const parsed = JSON.parse(raw) as { ok?: unknown; description?: unknown };
      if (parsed.ok === false) return { ok: false, status: res.status, error: String(parsed.description ?? 'Telegram rejected the message') };
    } catch { /* a 2xx with an empty/non-JSON body is still a successful send */ }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: (e as Error)?.name === 'AbortError' ? 'Telegram timed out' : String((e as Error)?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}
