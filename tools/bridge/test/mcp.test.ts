import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleMcp, type McpHooks, type McpStore } from '../src/mcp';
import { CommandQueue } from '../src/commands';
import { MatchMemory } from '../src/memory';
import { BridgeStore } from '../src/store';
import { states } from './fixtures';

function makeStore(): { store: McpStore; full: BridgeStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tl-bridge-mcp-'));
  const full = new BridgeStore({ snapshotDir: dir });
  for (const s of states) full.ingest(s, Date.now());
  return { store: { memory: full.memory, commands: full.commands }, full, dir };
}

function call(store: McpStore, name: string, args: Record<string, unknown> = {}, hooks: McpHooks = {}): {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
} {
  const r = handleMcp(store, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  }, hooks) as { result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean } };
  return r.result;
}

const textOf = (r: { content: Array<{ type: string; text?: string }> }): string => r.content.find((c) => c.type === 'text')?.text ?? '';

afterEach(() => { /* temp dirs are small; tests own unique names */ });

describe('MCP tools', () => {
  it('initializes, lists tools and supports notifications', () => {
    const { store, dir } = makeStore();
    const init = handleMcp(store, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) as {
      result: { serverInfo: { name: string }; capabilities: { tools: unknown } };
    };
    expect(init.result.serverInfo.name).toBe('tacticlens-bridge');
    expect(init.result.capabilities.tools).toBeTruthy();
    const list = handleMcp(store, { jsonrpc: '2.0', id: 2, method: 'tools/list' }) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = list.result.tools.map((t) => t.name);
    expect(names).toEqual(['get_live_state', 'get_events_since', 'get_match_memory', 'get_latest_snapshot', 'request_graphic', 'record_update']);
    expect(handleMcp(store, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('get_live_state returns only gated legal stats and qualitative facts when stats are requested', () => {
    const { store, dir } = makeStore();
    const r = call(store, 'get_live_state', { includeStats: true });
    const text = textOf(r);
    expect(text).toContain('Arsenal');
    expect(text).toContain('Possession 57-43');
    const body = JSON.parse(text) as {
      possession: unknown; stats: Record<string, unknown>; facts: Array<{ id: string; team?: string }>;
      clock?: unknown; t?: unknown; score?: unknown;
    };
    expect(body.possession).toEqual({ A: 57, B: 43, current: 'A' });
    expect(Object.keys(body.stats).sort()).toEqual(['passes', 'possession', 'turnovers']);
    expect(body.stats.tempo).toBeUndefined();
    expect(body.facts.length).toBeGreaterThan(0);
    for (const f of body.facts) {
      expect(f).not.toHaveProperty('confidence');
      expect(f).not.toHaveProperty('data');
      expect(f).not.toHaveProperty('sinceS');
    }
    expect(body.clock).toBeUndefined();
    expect(body.t).toBeUndefined();
    expect(body.score).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses no numbers by default; only a qualitative possession leader', () => {
    const { store, dir } = makeStore();
    const body = JSON.parse(textOf(call(store, 'get_live_state'))) as {
      possession: unknown; stats: unknown; statLine: string; possessionLeader: string;
    };
    expect(body.possession).toBeNull();
    expect(body.stats).toEqual({});
    expect(body.statLine).toBe('');
    expect(body.possessionLeader).toBe('Arsenal');
    rmSync(dir, { recursive: true, force: true });
  });

  it('drops invalid, low-confidence and >4-a-side overload facts', () => {
    const { store, dir } = makeStore();
    const s = states[states.length - 1]!;
    const fact = (id: string, valid: boolean, confidence: number, team?: 'A' | 'B', data: Record<string, number> = {}) =>
      ({ id, valid, confidence, sinceS: 2, targets: [1], ...(team ? { team } : {}), data });
    store.memory.ingest({
      ...s,
      facts: [
        fact('overload', true, 0.9, 'A', { attackers: 5, defenders: 2 }),
        fact('overload', true, 0.9, 'A', { attackers: 3, defenders: 2 }),
        fact('press_trap', false, 0.9, 'B'),
        fact('press_trap', true, 0.4, 'B'),
        fact('press_trap', true, 0.8, 'B'),
        fact('free_player', true, 0.8, 'A'),
      ],
    }, Date.now());
    const body = JSON.parse(textOf(call(store, 'get_live_state'))) as { facts: Array<{ id: string; team?: string }> };
    expect(body.facts).toEqual([
      { id: 'overload', team: 'A' },
      { id: 'press_trap', team: 'B' },
      { id: 'free_player', team: 'A' },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('get_events_since returns types and teams without timestamps or numeric detail', () => {
    const { store, dir } = makeStore();
    const r = call(store, 'get_events_since', { t: 40 });
    const body = JSON.parse(textOf(r)) as { events: Array<Record<string, unknown>> };
    expect(body.events.length).toBeGreaterThan(0);
    for (const e of body.events) {
      expect(Object.keys(e).sort()).toEqual(['team', 'type']);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('drops overload events with more than 4 players on a side', () => {
    const { store, dir } = makeStore();
    store.memory.ingest({
      ...states[states.length - 1]!,
      events: [
        { type: 'overload', t: 10, team: 'A', confidence: 0.9, detail: { attackers: 5, defenders: 2, near: '5 v 2' } },
        { type: 'overload', t: 11, team: 'A', confidence: 0.9, detail: { attackers: 3, defenders: 2, near: '3 v 2' } },
        { type: 'turnover', t: 12, team: 'B', confidence: 0.9, detail: { x: 1 } },
      ],
    }, Date.now());
    const body = JSON.parse(textOf(call(store, 'get_events_since', {}))) as { events: Array<{ type: string }> };
    expect(body.events.filter((e) => e.type === 'overload')).toHaveLength(1);
    expect(body.events.some((e) => e.type === 'turnover')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('get_match_memory includes only legal stat categories and no timestamps when stats are requested', () => {
    const { store, full, dir } = makeStore();
    full.addUpdate('Chelsea are squeezing the left side.');
    const body = JSON.parse(textOf(call(store, 'get_match_memory', { includeStats: true }))) as {
      minutes: Array<Record<string, unknown>>;
      previousUpdates: Array<Record<string, unknown>>;
    };
    expect(body.minutes.length).toBeGreaterThan(0);
    for (const m of body.minutes) {
      expect(Object.keys(m).every((k) => ['possession', 'passes', 'turnovers'].includes(k))).toBe(true);
    }
    expect(body.previousUpdates.at(-1)).toEqual({ text: 'Chelsea are squeezing the left side.', skipped: false });
    const lean = JSON.parse(textOf(call(store, 'get_match_memory'))) as { minutes: unknown[] };
    expect(lean.minutes).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('get_latest_snapshot returns image content and a usable path', () => {
    const { store, full, dir } = makeStore();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
    const ref = full.addSnapshot({ jpegBase64: jpeg, t: 42.5, width: 1280, height: 720 });
    const r = call(store, 'get_latest_snapshot');
    expect(r.content[0]?.type).toBe('image');
    expect(r.content[0]?.mimeType).toBe('image/jpeg');
    expect(r.content[0]?.data).toBe(jpeg);
    expect(textOf(r)).toContain(ref.path);
    rmSync(dir, { recursive: true, force: true });
  });

  it('request_graphic enqueues a command for the extension', () => {
    const { store, full, dir } = makeStore();
    const body = JSON.parse(textOf(call(store, 'request_graphic', { graphic: 'overload', targets: [7, 8, 8], reason: 'three v two on the right' })));
    expect(body.queued).toBe(true);
    expect(full.commands.list()).toHaveLength(1);
    expect(full.commands.list()[0]?.targets).toEqual([7, 8]);
    expect(call(store, 'request_graphic', { graphic: 'nope' }).isError).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('record_update stores the text and flags SKIP', () => {
    const { store, full, dir } = makeStore();
    const recorded: Array<{ text: string; skipped: boolean }> = [];
    call(store, 'record_update', { text: 'Arsenal are pinning Chelsea back.' }, { recordUpdate: (text, skipped) => recorded.push({ text, skipped }) });
    call(store, 'record_update', { text: 'SKIP', skipped: true }, { recordUpdate: (text, skipped) => recorded.push({ text, skipped }) });
    expect(recorded).toEqual([
      { text: 'Arsenal are pinning Chelsea back.', skipped: false },
      { text: 'SKIP', skipped: true },
    ]);
    expect(call(store, 'record_update', { text: '   ' }).isError).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('record_update passes triggerId to the bridge and answers STALE without storing the text', () => {
    const { store, full, dir } = makeStore();
    const seen: Array<{ text: string; triggerId?: string }> = [];
    const stale = call(store, 'record_update', { text: 'Arsenal are pinning Chelsea back.', triggerId: 'u1-old' },
      { recordUpdate: (text, _skipped, triggerId) => { seen.push({ text, triggerId }); return { stale: true }; } });
    expect(textOf(stale)).toBe('STALE: this update expired. Send nothing.');
    expect(seen).toEqual([{ text: 'Arsenal are pinning Chelsea back.', triggerId: 'u1-old' }]);
    expect(full.memory.updates.some((u) => u.text === 'Arsenal are pinning Chelsea back.')).toBe(false);
    const fresh = call(store, 'record_update', { text: 'Arsenal are pinning Chelsea back.', triggerId: 'u2-new' },
      { recordUpdate: () => ({ stale: false }) });
    expect(JSON.parse(textOf(fresh))).toMatchObject({ recorded: true, skipped: false });
    expect(full.memory.updates.some((u) => u.text === 'Arsenal are pinning Chelsea back.')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns JSON-RPC errors for unknown methods', () => {
    const { store, dir } = makeStore();
    const r = handleMcp(store, { jsonrpc: '2.0', id: 9, method: 'nope' }) as { error?: { code: number } };
    expect(r.error?.code).toBe(-32601);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('CommandQueue', () => {
  it('poll is idempotent until ack', () => {
    const q = new CommandQueue();
    const a = q.push('spotlight', [1], 'x');
    expect(q.list()).toHaveLength(1);
    expect(q.list()).toHaveLength(1);
    expect(q.ack([{ id: a.id, accepted: true }])).toBe(1);
    expect(q.list()).toHaveLength(0);
  });
});
