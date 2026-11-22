import { describe, expect, it, vi } from 'vitest';
import { sendTelegramText, telegramConfigFromEnv, telegramConfigured, type TelegramConfig } from '../src/telegram';

const cfg: TelegramConfig = { botToken: '123:abc', chatId: '42', apiBase: 'https://api.telegram.org' };

function responder(status: number, body: string) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, text: async () => body }));
}

describe('telegram ping', () => {
  it('reads the bot token and chat id from env', () => {
    const c = telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: ' t ', TELEGRAM_CHAT_ID: ' 9 ' });
    expect(c).toEqual({ botToken: 't', chatId: '9', apiBase: 'https://api.telegram.org' });
    expect(telegramConfigured(c)).toBe(true);
    expect(telegramConfigured({ ...c, botToken: '' })).toBe(false);
  });

  it('posts the text to sendMessage', async () => {
    const fetchImpl = responder(200, JSON.stringify({ ok: true }));
    const r = await sendTelegramText(cfg, '  Team Blue  are pressing. ', fetchImpl as never);
    expect(r).toEqual({ ok: true, status: 200 });
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toMatchObject({ chat_id: '42', text: 'Team Blue are pressing.', disable_web_page_preview: true });
  });

  it('surfaces a Telegram rejection and never throws', async () => {
    const r = await sendTelegramText(cfg, 'hello', responder(200, JSON.stringify({ ok: false, description: 'chat not found' })) as never);
    expect(r).toEqual({ ok: false, status: 200, error: 'chat not found' });
    const bad = await sendTelegramText(cfg, 'hello', responder(401, 'bad token') as never);
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('401');
  });

  it('refuses an unconfigured bot or an empty message', async () => {
    expect((await sendTelegramText({ ...cfg, botToken: '' }, 'hello')).ok).toBe(false);
    expect((await sendTelegramText(cfg, '   ')).ok).toBe(false);
  });
});
