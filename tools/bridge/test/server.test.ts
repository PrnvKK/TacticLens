import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBridgeServer, type BridgeServer } from '../src/server';
import { states } from './fixtures';

const TOKEN = 'test-token-0123456789';
let active: BridgeServer | null = null;
let dir = '';

async function start(): Promise<{ base: string; server: BridgeServer }> {
  dir = mkdtempSync(join(tmpdir(), 'tl-bridge-http-'));
  active = createBridgeServer({ token: TOKEN, port: 0, snapshotDir: dir });
  const addr = await active.listen();
  return { base: `http://${addr.host}:${addr.port}`, server: active };
}

afterEach(async () => {
  if (active) { await active.close(); active = null; }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

describe('bridge HTTP server', () => {
  it('serves health without auth and rejects missing/wrong tokens', async () => {
    const { base } = await start();
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const unauth = await fetch(`${base}/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(unauth.status).toBe(401);
    const wrong = await fetch(`${base}/state`, { method: 'POST', headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' }, body: '{}' });
    expect(wrong.status).toBe(401);
  });

  it('ingests state and exposes it through MCP', async () => {
    const { base, server } = await start();
    const res = await fetch(`${base}/state`, { method: 'POST', headers: auth, body: JSON.stringify(states.at(-1)) });
    expect(res.status).toBe(200);
    expect(server.store.memory.latest?.possession.A).toBeCloseTo(56.57, 1);
    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_live_state', arguments: { includeStats: true } } }),
    });
    expect(mcp.status).toBe(200);
    const body = await mcp.json() as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]?.text).toContain('Possession 57-43');
  });

  it('rejects a bad state payload', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/state`, { method: 'POST', headers: auth, body: JSON.stringify({ t: 1 }) });
    expect(res.status).toBe(400);
  });

  it('stores a snapshot and serves it as MCP image content', async () => {
    const { base } = await start();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    const res = await fetch(`${base}/snapshot`, {
      method: 'POST', headers: auth, body: JSON.stringify({ jpegBase64: jpeg, t: 12.5, width: 1280, height: 720 }),
    });
    expect(res.status).toBe(200);
    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_latest_snapshot', arguments: {} } }),
    });
    const body = await mcp.json() as { result: { content: Array<{ type: string; data?: string }> } };
    expect(body.result.content[0]?.type).toBe('image');
    expect(body.result.content[0]?.data).toBe(jpeg);
    const bad = await fetch(`${base}/snapshot`, {
      method: 'POST', headers: auth, body: JSON.stringify({ jpegBase64: Buffer.from('nope').toString('base64'), t: 1, width: 2, height: 2 }),
    });
    expect(bad.status).toBe(400);
  });

  it('queues a graphic through MCP, lists it and acks it', async () => {
    const { base, server } = await start();
    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'request_graphic', arguments: { graphic: 'press_trap', targets: [4, 5], reason: 'counter-press' } } }),
    });
    expect(mcp.status).toBe(200);
    const list = await fetch(`${base}/commands`, { headers: auth });
    const body = await list.json() as { commands: Array<{ id: string; graphic: string }> };
    expect(body.commands).toHaveLength(1);
    expect(body.commands[0]?.graphic).toBe('press_trap');
    expect(server.store.commands.list()).toHaveLength(1);

    const ack = await fetch(`${base}/commands/ack`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ acks: [{ id: body.commands[0]!.id, accepted: true }] }),
    });
    expect(ack.status).toBe(200);
    expect(server.store.commands.list()).toHaveLength(0);
  });

  it('records an agent update through MCP', async () => {
    const { base, server } = await start();
    await fetch(`${base}/state`, { method: 'POST', headers: auth, body: JSON.stringify(states.at(-1)) });
    await fetch(`${base}/mcp`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'record_update', arguments: { text: 'Arsenal are controlling the ball.' } } }),
    });
    expect(server.store.memory.updates.at(-1)?.text).toBe('Arsenal are controlling the ball.');
  });

  it('rejects body over the state limit and unknown routes', async () => {
    const { base } = await start();
    const huge = JSON.stringify({ ...states[0], padding: 'x'.repeat(300 * 1024) });
    const res = await fetch(`${base}/state`, { method: 'POST', headers: auth, body: huge });
    expect(res.status).toBe(413);
    const missing = await fetch(`${base}/nope`, { headers: auth });
    expect(missing.status).toBe(404);
  });
});
