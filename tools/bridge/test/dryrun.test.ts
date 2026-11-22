import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDryRun } from '../src/dryrun';
import { BridgeStore } from '../src/store';
import { FIXTURE_PATH, fixture } from './fixtures';
import type { ChatResult } from '../src/cerebras';

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('dry run', () => {
  it('replays the fixture in three chunks, records updates and prints latency', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tl-bridge-dry-'));
    const store = new BridgeStore({ snapshotDir: dir });
    const prompts: string[] = [];
    const chatFn = async (_opts: unknown, messages: Array<{ content: string }>): Promise<ChatResult> => {
      prompts.push(messages[messages.length - 1]!.content);
      return { text: `Update ${prompts.length}: Arsenal are controlling midfield.`, ms: 12 + prompts.length, model: 'gpt-oss-120b', tokensIn: 10, tokensOut: 5 };
    };
    const lines: string[] = [];
    const samples = await runDryRun({
      store, fixture, apiKey: 'test', model: 'gpt-oss-120b', count: 3, gapMs: 0,
      chatFn: chatFn as never, log: (l) => lines.push(l), now: () => 1_000,
    });
    expect(samples).toHaveLength(3);
    expect(samples.map((s) => s.ms)).toEqual([13, 14, 15]);
    expect(store.memory.updates).toHaveLength(3);
    expect(prompts[0]).toContain('includeStatLine=false');
    expect(prompts[0]).toContain('"possessionLeader"');
    expect(prompts[0]).not.toContain('"statLine":"Possession');
    expect(prompts[2]).toContain('includeStatLine=true');
    expect(prompts[2]).toContain('Possession');
    expect(lines.join('\n')).toContain('No Telegram and no OpenClaw calls');
    expect(FIXTURE_PATH).toContain('synth-balanced.recorded.json');
    rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('prints the prompt instead of calling a model without a key', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tl-bridge-dry-'));
    const lines: string[] = [];
    const samples = await runDryRun({
      store: new BridgeStore({ snapshotDir: dir }), fixture, apiKey: '', model: 'gpt-oss-120b', gapMs: 0,
      log: (l) => lines.push(l), now: () => 1_000,
    });
    expect(samples).toHaveLength(0);
    expect(lines.join('\n')).toContain('CEREBRAS_API_KEY is not set');
    expect(lines.join('\n')).toContain('TacticLens analyst');
    rmSync(dir, { recursive: true, force: true });
    dir = '';
  });
});
