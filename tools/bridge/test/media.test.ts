import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatResult } from '../src/cerebras';
import { runDryRun } from '../src/dryrun';
import { stripMediaTalk } from '../src/media';
import { handleMcp } from '../src/mcp';
import { MatchMemory } from '../src/memory';
import { ANALYST_SYSTEM, buildTriggerMessage } from '../src/prompts';
import { BridgeStore } from '../src/store';
import { fixture, states } from './fixtures';

const LABELS = { A: 'Team Red', B: 'Team Yellow' };

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

describe('stripMediaTalk', () => {
  it('drops a sentence that talks about the picture and keeps the analysis', () => {
    expect(stripMediaTalk('As seen in the attached JPG, Team Red press high.')).toBe('');
    expect(stripMediaTalk('Team Red press high. As seen in the attached JPG, Team Red press high.')).toBe('Team Red press high.');
    expect(stripMediaTalk('Team Red press high. The snapshot shows a gap. Team Yellow are pinned back.')).toBe('Team Red press high. Team Yellow are pinned back.');
  });

  it('matches case-insensitively and on whole words only', () => {
    expect(stripMediaTalk('The Screenshot is clear. Team Red press high.')).toBe('Team Red press high.');
    expect(stripMediaTalk('Team Red press high. Their PHOTO is grainy.')).toBe('Team Red press high.');
    expect(stripMediaTalk('Team Yellow frame their press well. Team Red switch play.')).toBe('Team Red switch play.');
    expect(stripMediaTalk('Team Red framework is solid. Pictures are not needed.')).toBe('Team Red framework is solid.');
  });

  it('drops machinery words such as tracker, payload, JSON and metadata', () => {
    expect(stripMediaTalk('The tracker lost the ball. Team Red press high.')).toBe('Team Red press high.');
    expect(stripMediaTalk('Team Red press high. JSON says otherwise.')).toBe('Team Red press high.');
    expect(stripMediaTalk('Metadata shows a shift. Team Yellow are stretched.')).toBe('Team Yellow are stretched.');
  });

  it('collapses whitespace and returns empty when nothing is left', () => {
    expect(stripMediaTalk('  Team Red   press\n\nhigh.  ')).toBe('Team Red press high.');
    expect(stripMediaTalk('An annotated PNG.  ')).toBe('');
    expect(stripMediaTalk('')).toBe('');
  });
});

describe('media wording is cleaned before anything is stored or sent', () => {
  it('addUpdate stores the cleaned text, and empty text as a skip', () => {
    const m = new MatchMemory();
    const kept = m.addUpdate('As seen in the attached JPG, Team A press high. Team B are pinned back.');
    expect(kept.text).toBe('Team B are pinned back.');
    expect(kept.skipped).toBe(false);
    const dropped = m.addUpdate('As seen in the attached JPG, Team A press high.');
    expect(dropped.text).toBe('');
    expect(dropped.skipped).toBe(true);
  });

  it('record_update returns an empty skipped result that must not be sent', () => {
    dir = mkdtempSync(join(tmpdir(), 'tl-bridge-media-'));
    const full = new BridgeStore({ snapshotDir: dir });
    for (const s of states) full.ingest({ ...s, teamLabels: LABELS }, Date.now());
    const store = { memory: full.memory, commands: full.commands };
    const recorded: Array<{ text: string; skipped: boolean }> = [];
    const r = handleMcp(store, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'record_update', arguments: { text: 'As seen in the attached JPG, Team A press high.' } },
    }, { recordUpdate: (text, skipped) => recorded.push({ text, skipped }) }) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(r.result.content[0]!.text)).toMatchObject({ recorded: true, skipped: true, text: '' });
    expect(recorded).toEqual([{ text: '', skipped: true }]);
  });

  it('the dry run never prints or sends an empty update', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tl-bridge-media-dry-'));
    const store = new BridgeStore({ snapshotDir: dir });
    const tagged = { ...fixture, states: fixture.states.map((s) => ({ ...s, teamLabels: LABELS })) };
    const chatFn = async (): Promise<ChatResult> => ({ text: 'As seen in the attached JPG, Team A press high.', ms: 5, model: 'm', tokensIn: 1, tokensOut: 1 });
    const lines: string[] = [];
    const samples = await runDryRun({
      store, fixture: tagged, apiKey: 'k', model: 'm', count: 1, gapMs: 0,
      chatFn: chatFn as never, log: (l) => lines.push(l), now: () => 1_000,
    });
    expect(samples[0]).toMatchObject({ text: '', skipped: true });
    expect(store.memory.updates[0]).toMatchObject({ text: '', skipped: true });
    expect(lines.join('\n')).not.toContain('JPG');
  });
});

describe('prompts forbid media and machinery talk', () => {
  it('the system prompt carries the hard rule and keeps the jersey-colour naming rule', () => {
    expect(ANALYST_SYSTEM).toContain('NEVER mention or allude to images, JPEG/JPG/PNG, snapshots, screenshots');
    expect(ANALYST_SYSTEM).toContain('as seen in the image');
    expect(ANALYST_SYSTEM).toContain('must read perfectly without it');
    expect(ANALYST_SYSTEM).not.toContain('an annotated snapshot');
    expect(ANALYST_SYSTEM).toContain('ONLY by their jersey-colour labels');
  });

  it('the trigger message asks for text only, with no media and no snapshot path', () => {
    const memory = new MatchMemory();
    for (const s of states) memory.ingest({ ...s, teamLabels: LABELS }, Date.now());
    memory.addSnapshot({ id: 's1', path: 'C:\tmp\snap.jpg', t: 1, width: 1280, height: 720, bytes: 4, receivedAt: 1 });
    const msg = buildTriggerMessage(memory, { updateNumber: 2, includeStatLine: false, chatId: '77', snapshotPath: 'C:\tmp\snap.jpg' });
    expect(msg).toContain('Never mention images, snapshots, frames, tools, memory, JSON, data');
    expect(msg).toContain('as text only');
    expect(msg).toContain('Do not attach or add any media yourself');
    expect(msg).not.toContain('media=');
    expect(msg).not.toContain('C:\tmp\snap.jpg');
    expect(msg).toContain('Team labels: A = "Team Red", B = "Team Yellow"');
  });
});
