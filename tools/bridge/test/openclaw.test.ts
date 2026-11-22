import { describe, expect, it } from 'vitest';
import { openClawConfigFromEnv, triggerOpenClaw, type FetchLike } from '../src/openclaw';
import { buildTriggerMessage } from '../src/prompts';
import { BridgeStore } from '../src/store';
import { fixture } from './fixtures';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('OpenClaw trigger', () => {
  it('POSTs the documented agent payload with the hook bearer token', async () => {
    const captured: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      captured.push({ url, init });
      return { ok: true, status: 200, text: async () => '{"ok":true,"runId":"run-1"}' };
    };
    const r = await triggerOpenClaw(
      { url: 'http://127.0.0.1:18789/hooks/agent', token: 'hook-secret', agentId: 'main', timeoutMs: 5000 },
      'live update please',
      fetchImpl,
    );
    expect(r).toEqual({ ok: true, status: 200, runId: 'run-1' });
    expect(captured[0]?.url).toBe('http://127.0.0.1:18789/hooks/agent');
    expect(captured[0]?.init.headers.Authorization).toBe('Bearer hook-secret');
    const body = JSON.parse(captured[0]?.init.body ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({ message: 'live update please', agentId: 'main', deliver: false, sessionMode: 'isolated' });
    expect(body).not.toHaveProperty('channel');
    expect(body).not.toHaveProperty('to');
  });

  it('fails closed without a hook token and reports HTTP errors', async () => {
    const noToken = await triggerOpenClaw({ url: 'http://x', token: '', agentId: 'main', timeoutMs: 1000 }, 'x');
    expect(noToken.ok).toBe(false);
    expect(noToken.error).toContain('OPENCLAW_HOOK_TOKEN');
    const denied = await triggerOpenClaw(
      { url: 'http://x', token: 't', agentId: 'main', timeoutMs: 1000 }, 'x',
      async () => ({ ok: false, status: 401, text: async () => '{"ok":false,"error":"unauthorized"}' }),
    );
    expect(denied).toMatchObject({ ok: false, status: 401, error: 'unauthorized' });
  });

  it('retries the trigger once after a queue_full hook failure', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const fetchImpl: FetchLike = async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: false, status: 429,
          text: async () => JSON.stringify({ message: "We're experiencing high traffic right now!", param: 'queue', code: 'queue_exceeded' }),
        };
      }
      return { ok: true, status: 200, text: async () => '{"ok":true,"runId":"run-2"}' };
    };
    const r = await triggerOpenClaw(
      { url: 'http://x', token: 't', agentId: 'main', timeoutMs: 1000 }, 'x', fetchImpl,
      { sleep: async (ms) => { sleeps.push(ms); } },
    );
    expect(r).toMatchObject({ ok: true, status: 200, runId: 'run-2' });
    expect(r.errorKind).toBeUndefined();
    expect(calls).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it('does not retry a plain rate limit or an auth failure', async () => {
    let calls = 0;
    const rate = await triggerOpenClaw(
      { url: 'http://x', token: 't', agentId: 'main', timeoutMs: 1000 }, 'x',
      async () => { calls++; return { ok: false, status: 429, text: async () => '{"message":"rate limit exceeded"}' }; },
      { sleep: async () => undefined },
    );
    expect(rate).toMatchObject({ ok: false, errorKind: 'rate_limited' });
    expect(calls).toBe(1);
    calls = 0;
    const denied = await triggerOpenClaw(
      { url: 'http://x', token: 't', agentId: 'main', timeoutMs: 1000 }, 'x',
      async () => { calls++; return { ok: false, status: 401, text: async () => '{"ok":false,"error":"unauthorized"}' }; },
      { sleep: async () => undefined },
    );
    expect(denied.errorKind).toBe('client');
    expect(calls).toBe(1);
  });

  it('retries a queue_full reported inside a 200 hook body', async () => {
    let calls = 0;
    const r = await triggerOpenClaw(
      { url: 'http://x', token: 't', agentId: 'main', timeoutMs: 1000 }, 'x',
      async () => {
        calls++;
        return calls === 1
          ? { ok: true, status: 200, text: async () => '{"ok":false,"error":"429 queue_exceeded high traffic"}' }
          : { ok: true, status: 200, text: async () => '{"ok":true,"runId":"run-3"}' };
      },
      { sleep: async () => undefined },
    );
    expect(r).toMatchObject({ ok: true, runId: 'run-3' });
    expect(calls).toBe(2);
  });

  it('builds a trigger message that names the chat and update number without media', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-bridge-oc-'));
    const store = new BridgeStore({ snapshotDir: dir });
    for (const s of fixture.states) store.ingest(s, Date.now());
    const msg = buildTriggerMessage(store.memory, {
      updateNumber: 4, includeStatLine: true, chatId: '12345', snapshotPath: 'C:\\tmp\\snap.jpg',
    });
    expect(msg).toContain('update #4');
    expect(msg).toContain('Telegram chat id: 12345');
    expect(msg).not.toContain('C:\\tmp\\snap.jpg');
    expect(msg).toContain('Include the compact stat line: yes');
    expect(msg).toContain('record_update');
    expect(msg).toContain('SKIP');
    rmSync(dir, { recursive: true, force: true });
  });

  it('trigger message carries the triggerId, the ISO triggeredAt and the expiry rule', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-bridge-oc-'));
    const store = new BridgeStore({ snapshotDir: dir });
    for (const s of fixture.states) store.ingest(s, Date.now());
    const triggeredAt = Date.UTC(2026, 10, 22, 19, 0, 0);
    const msg = buildTriggerMessage(store.memory, {
      updateNumber: 5, includeStatLine: false, chatId: '12345', triggerId: 'u5-abc', triggeredAt,
    });
    expect(msg).toContain('u5-abc');
    expect(msg).toContain(new Date(triggeredAt).toISOString());
    expect(msg).toContain('EXPIRES 60 s after triggeredAt');
    expect(msg).toContain('STALE');
    expect(msg).toContain('"triggerId":"<trigger id above>"');
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads defaults from env without exposing secrets', () => {
    const cfg = openClawConfigFromEnv({ OPENCLAW_HOOK_TOKEN: 'secret' });
    expect(cfg.url).toBe('http://127.0.0.1:18789/hooks/agent');
    expect(cfg.agentId).toBe('main');
    expect(cfg.token).toBe('secret');
  });
});
