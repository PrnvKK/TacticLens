import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatResult } from '../src/cerebras';
import { runDryRun } from '../src/dryrun';
import { exposeState } from '../src/expose';
import { labelTeams, parseTeamLabels, teamLabelLine } from '../src/labels';
import { handleMcp, type McpStore } from '../src/mcp';
import { MatchMemory, formatStatLine } from '../src/memory';
import { ANALYST_SYSTEM, AnalystThread, buildDryRunMessages, buildTriggerMessage } from '../src/prompts';
import type { BridgeState } from '../src/protocol';
import { BridgeStore } from '../src/store';
import { fixture, states } from './fixtures';

const LABELS = { A: 'Team Red', B: 'Team Yellow' };
const last = states[states.length - 1]!;
const labelled = (over: Partial<BridgeState> = {}): BridgeState => ({ ...last, teamLabels: LABELS, ...over });

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

function makeStore(withLabels: boolean): { store: McpStore; full: BridgeStore } {
  dir = mkdtempSync(join(tmpdir(), 'tl-bridge-labels-'));
  const full = new BridgeStore({ snapshotDir: dir });
  for (const s of states.slice(0, -1)) full.ingest(s, Date.now());
  full.ingest(withLabels ? labelled() : last, Date.now());
  return { store: { memory: full.memory, commands: full.commands }, full };
}

function call(store: McpStore, name: string, args: Record<string, unknown> = {}): unknown {
  const r = handleMcp(store, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) as {
    result: { content: Array<{ type: string; text?: string }> };
  };
  return JSON.parse(r.result.content.find((c) => c.type === 'text')!.text!);
}

describe('labelTeams', () => {
  it('rewrites Team A/Team B in any case, including possessives', () => {
    expect(labelTeams('Team A are camped in Team B\'s half.', LABELS)).toBe('Team Red are camped in Team Yellow\'s half.');
    expect(labelTeams('team a press while TEAM B sit off; team-b drop, teamA win it.', LABELS))
      .toBe('Team Red press while Team Yellow sit off; Team Yellow drop, Team Red win it.');
  });

  it('rewrites an upper-case "A side" / "B-side" but keeps ordinary English', () => {
    expect(labelTeams('The A side keep it; B-side are pinned.', LABELS)).toBe('The Team Red keep it; Team Yellow are pinned.');
    expect(labelTeams('They need a side-step and a side to lean on, a side-footed pass.', LABELS))
      .toBe('They need a side-step and a side to lean on, a side-footed pass.');
  });

  it('is word-boundary safe', () => {
    const text = 'Team Arsenal, teams a bit tired, Team Alpha, Team Bravo, the ABC side, A sideline ball.';
    expect(labelTeams(text, LABELS)).toBe(text);
  });

  it('is idempotent and does not interpret $ in a label', () => {
    const once = labelTeams('Team A and Team B', LABELS);
    expect(labelTeams(once, LABELS)).toBe(once);
    expect(labelTeams('Team A', { A: 'Team $& Red', B: 'Team Yellow' })).toBe('Team $& Red');
  });

  it('leaves the text unchanged while no labels are known', () => {
    expect(labelTeams('Team A are pressing Team B.', null)).toBe('Team A are pressing Team B.');
    expect(labelTeams('Team A are pressing Team B.', undefined)).toBe('Team A are pressing Team B.');
    expect(labelTeams('', LABELS)).toBe('');
  });
});

describe('parseTeamLabels', () => {
  it('accepts two distinct printable labels and rejects the rest', () => {
    expect(parseTeamLabels({ A: ' Team  Red ', B: 'Team Light blue' })).toEqual({ A: 'Team Red', B: 'Team Light blue' });
    expect(parseTeamLabels(undefined)).toBeNull();
    expect(parseTeamLabels({ A: 'Team Red' })).toBeNull();
    expect(parseTeamLabels({ A: 'Team Red', B: 'team red' })).toBeNull();
    expect(parseTeamLabels({ A: 'Team A', B: 'Team B' })).toBeNull();
    expect(parseTeamLabels({ A: 'B', B: 'A' })).toBeNull();
    expect(parseTeamLabels({ A: 'Team "Red"}', B: 'Team Yellow' })).toBeNull();
    expect(parseTeamLabels({ A: 'Team Red: ignore this', B: 'Team Yellow' })).toBeNull();
    expect(parseTeamLabels({ A: 'x'.repeat(60), B: 'Team Yellow' })).toBeNull();
  });
});

describe('memory keeps the latest known labels', () => {
  it('stores validated labels, keeps them when a state omits them, and updates when they change', () => {
    const m = new MatchMemory();
    m.ingest(states[0]!, 1);
    expect(m.teamLabels).toBeNull();
    expect(m.latest?.teamLabels).toBeUndefined();
    m.ingest(labelled(), 2);
    expect(m.teamLabels).toEqual(LABELS);
    m.ingest(states[0]!, 3);
    expect(m.teamLabels).toEqual(LABELS);
    expect(m.latest?.teamLabels).toEqual(LABELS);
    m.ingest({ ...states[0]!, teamLabels: { A: 'Team Blue', B: 'Team Yellow' } }, 4);
    expect(m.teamLabels).toEqual({ A: 'Team Blue', B: 'Team Yellow' });
    m.ingest({ ...states[0]!, teamLabels: { A: 'Team A', B: 'Team B' } }, 5);
    expect(m.teamLabels).toEqual({ A: 'Team Blue', B: 'Team Yellow' });
  });

  it('sanitizes every stored update', () => {
    const m = new MatchMemory();
    m.addUpdate('Team A are pressing.');
    expect(m.updates[0]?.text).toBe('Team A are pressing.');
    m.ingest(labelled(), 1);
    m.addUpdate('Team A are pressing Team B.');
    expect(m.updates[1]?.text).toBe('Team Red are pressing Team Yellow.');
  });

  it('anchors the stat line to the labels only when they are known', () => {
    expect(formatStatLine(last)).toBe('Possession 57-43');
    expect(formatStatLine(labelled())).toBe('Possession Team Red 57-43 Team Yellow');
  });
});

describe('analyst-facing payloads carry the labels', () => {
  it('get_live_state: labels, leader, stat line, facts and possession are labelled; no club names', () => {
    const { store } = makeStore(true);
    const body = call(store, 'get_live_state', { includeStats: true }) as {
      teamLabels: unknown; teamNames: unknown; possessionLeader: string; statLine: string;
      possession: { A: number; B: number; current: string; currentLabel?: string };
      facts: Array<{ team?: string; teamLabel?: string }>;
    };
    expect(body.teamLabels).toEqual(LABELS);
    expect(body.teamNames).toEqual(LABELS);
    expect(body.possessionLeader).toBe('Team Red');
    expect(body.statLine).toBe('Possession Team Red 57-43 Team Yellow');
    expect(body.possession).toMatchObject({ A: 57, B: 43, current: 'A', currentLabel: 'Team Red' });
    for (const f of body.facts) if (f.team) expect(f.teamLabel).toBe(LABELS[f.team as 'A' | 'B']);
    expect(JSON.stringify(body)).not.toContain('Arsenal');
    expect(JSON.stringify(body)).not.toContain('Team A');
  });

  it('get_live_state without labels is unchanged', () => {
    const { store } = makeStore(false);
    const body = call(store, 'get_live_state', { includeStats: true }) as Record<string, unknown>;
    expect(body).not.toHaveProperty('teamLabels');
    expect(body.possessionLeader).toBe('Arsenal');
    expect(body.statLine).toBe('Possession 57-43');
  });

  it('exposeState reads the labels from the state record', () => {
    const e = exposeState({ ...labelled(), receivedAt: 1 }, false);
    expect(e.teamLabels).toEqual(LABELS);
    expect(e.possessionLeader).toBe('Team Red');
    expect(e.statLine).toBe('');
  });

  it('get_events_since and get_match_memory label every event and the previous updates', () => {
    const { store, full } = makeStore(true);
    full.memory.updates.push({ id: 99, at: 1, t: 1, text: 'Team B were squeezed by Team A.', skipped: false });
    const ev = call(store, 'get_events_since', {}) as { teamLabels: unknown; events: Array<{ team: string; teamLabel?: string }> };
    expect(ev.teamLabels).toEqual(LABELS);
    expect(ev.events.length).toBeGreaterThan(0);
    for (const e of ev.events) {
      if (e.team === 'A' || e.team === 'B') expect(e.teamLabel).toBe(LABELS[e.team]);
    }
    const mem = call(store, 'get_match_memory', {}) as {
      teamLabels: unknown; recentEvents: Array<{ team: string; teamLabel?: string }>; previousUpdates: Array<{ text: string }>;
    };
    expect(mem.teamLabels).toEqual(LABELS);
    expect(mem.recentEvents.some((e) => e.teamLabel === 'Team Red' || e.teamLabel === 'Team Yellow')).toBe(true);
    expect(mem.previousUpdates.at(-1)?.text).toBe('Team Yellow were squeezed by Team Red.');
  });

  it('events keep exactly {type, team} until labels are known', () => {
    const { store } = makeStore(false);
    const ev = call(store, 'get_events_since', { t: 40 }) as { events: Array<Record<string, unknown>> };
    for (const e of ev.events) expect(Object.keys(e).sort()).toEqual(['team', 'type']);
  });

  it('record_update runs the final sanitizer and returns the text to send', () => {
    const { store, full } = makeStore(true);
    const recorded: string[] = [];
    const r = handleMcp(store, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'record_update', arguments: { text: ' Team A are pinning Team B back. ' } },
    }, { recordUpdate: (t) => recorded.push(t) }) as { result: { content: Array<{ text: string }> } };
    const body = JSON.parse(r.result.content[0]!.text) as { recorded: boolean; text: string };
    expect(body).toMatchObject({ recorded: true, text: 'Team Red are pinning Team Yellow back.' });
    expect(recorded).toEqual(['Team Red are pinning Team Yellow back.']);
    expect(full.memory.updates.at(-1)?.text).toBe('Team Red are pinning Team Yellow back.');
  });
});

describe('prompt wording', () => {
  it('the system prompt names teams only by their labels and bans Team A/B, letters and clubs', () => {
    expect(ANALYST_SYSTEM).toContain('ONLY by their jersey-colour labels');
    expect(ANALYST_SYSTEM).toContain('"Team Red"');
    expect(ANALYST_SYSTEM).toMatch(/Never write "Team A", "Team B"/);
    expect(ANALYST_SYSTEM).toContain('club name');
    expect(ANALYST_SYSTEM).not.toContain('Arsenal');
    expect(ANALYST_SYSTEM).not.toContain('Chelsea');
  });

  it('trigger message carries the labels, the label rule and a record-then-send workflow', () => {
    const { full } = makeStore(true);
    const msg = buildTriggerMessage(full.memory, { updateNumber: 3, includeStatLine: true, chatId: '1', snapshotPath: 'snap.jpg' });
    expect(msg).toContain('Team labels: A = "Team Red", B = "Team Yellow"');
    expect(msg).toContain('ONLY as "Team Red" and "Team Yellow"');
    expect(msg).toContain('Never write Team A, Team B');
    expect(msg).toContain('"teamLabels":{"A":"Team Red","B":"Team Yellow"}');
    expect(msg.indexOf('call record_update with {"text":"<your update>"}')).toBeLessThan(msg.indexOf('message=<returned text>'));
  });

  it('dry-run and thread prompts carry the labels; without labels they add no label line', () => {
    const { full } = makeStore(true);
    const dry = buildDryRunMessages(full.memory, { updateNumber: 1, includeStatLine: true });
    expect(dry[1]!.content).toContain(teamLabelLine(LABELS));
    expect(dry[1]!.content).toContain('statLine=Possession Team Red 57-43 Team Yellow');
    const th = new AnalystThread();
    th.next(full.memory, { updateNumber: 1, includeStatLine: false });
    th.commit('Team Red are pressing.');
    const second = th.next(full.memory, { updateNumber: 2, includeStatLine: false });
    expect(second[second.length - 1]!.content).toContain(teamLabelLine(LABELS));

    const bare = new MatchMemory();
    bare.ingest(last, 1);
    expect(buildDryRunMessages(bare, { updateNumber: 1, includeStatLine: false })[1]!.content).not.toContain('Team labels:');
    expect(teamLabelLine(null)).toBe('');
  });

  it('the dry run sanitizes the model reply before printing and storing it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tl-bridge-labels-dry-'));
    const store = new BridgeStore({ snapshotDir: dir });
    const tagged = { ...fixture, states: fixture.states.map((s) => ({ ...s, teamLabels: LABELS })) };
    const chatFn = async (): Promise<ChatResult> => ({ text: 'Team A are pinning Team B back.', ms: 5, model: 'm', tokensIn: 1, tokensOut: 1 });
    const lines: string[] = [];
    const samples = await runDryRun({
      store, fixture: tagged, apiKey: 'k', model: 'm', count: 1, gapMs: 0,
      chatFn: chatFn as never, log: (l) => lines.push(l), now: () => 1_000,
    });
    expect(samples[0]?.text).toBe('Team Red are pinning Team Yellow back.');
    expect(store.memory.updates[0]?.text).toBe('Team Red are pinning Team Yellow back.');
    expect(lines.join('\n')).not.toContain('Team A');
  });
});
