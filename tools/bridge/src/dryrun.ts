// Dry run: replay a recorded compact-state fixture through the same prompts the OpenClaw agent gets,
// print the updates and latency, and never touch Telegram.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chat, type ChatMessage } from './cerebras';
import { labelTeams } from './labels';
import { stripMediaTalk } from './media';
import { AnalystThread, buildDryRunMessages } from './prompts';
import { isBridgeState, type BridgeState } from './protocol';
import type { BridgeStore } from './store';

export interface RecordedFixture {
  name: string;
  note?: string;
  states: BridgeState[];
}

export function loadFixture(path: string): RecordedFixture {
  const json = JSON.parse(readFileSync(resolve(path), 'utf8')) as Partial<RecordedFixture>;
  if (!Array.isArray(json.states) || !json.states.length) throw new Error(`${path}: fixture has no states`);
  const states = json.states.filter(isBridgeState);
  if (!states.length) throw new Error(`${path}: fixture states do not match the bridge state contract`);
  return { name: json.name || path, note: json.note, states };
}

export interface DryRunOpts {
  store: BridgeStore;
  fixture: RecordedFixture;
  apiKey: string;
  model: string;
  baseUrl?: string;
  count?: number;
  gapMs?: number;
  chatFn?: typeof chat;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
}

export interface DryRunSample {
  index: number;
  text: string;
  ms: number;
  model: string;
  skipped: boolean;
  tokensIn: number;
  tokensOut: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runDryRun(o: DryRunOpts): Promise<DryRunSample[]> {
  const log = o.log ?? ((l: string) => console.log(l));
  const sleep = o.sleep ?? defaultSleep;
  const count = Math.max(1, Math.min(3, o.count ?? 3));
  const states = o.fixture.states;
  const chunk = Math.max(1, Math.ceil(states.length / count));
  const samples: DryRunSample[] = [];
  const thread = new AnalystThread();
  log(`TacticLens bridge dry run: ${o.fixture.name}, ${states.length} recorded states, model ${o.model}`);
  log('No Telegram and no OpenClaw calls. Numbers come only from the recorded fixture.');
  if (!o.apiKey) {
    for (const s of states.slice(0, chunk)) o.store.ingest(s, (o.now ?? Date.now)());
    log('CEREBRAS_API_KEY is not set: printing the first prompt instead.');
    const messages = buildDryRunMessages(o.store.memory, { updateNumber: 1, includeStatLine: false });
    for (const m of messages) log(`[${m.role}]\n${m.content}`);
    return samples;
  }

  for (let i = 0; i < count; i++) {
    const start = i * chunk;
    const end = i === count - 1 ? states.length : Math.min(states.length, start + chunk);
    for (const s of states.slice(start, end)) o.store.ingest(s, (o.now ?? Date.now)());
    const includeStatLine = i === count - 1;
    const messages: ChatMessage[] = thread.next(o.store.memory, { updateNumber: i + 1, includeStatLine }) as ChatMessage[];
    const r = await (o.chatFn ?? chat)({
      apiKey: o.apiKey,
      model: o.model,
      baseUrl: o.baseUrl,
      maxTokens: 260,
      fetchImpl: fetch,
    }, messages);
    // Final sanitizers, exactly where the live path sends: media talk is dropped and Team A/Team B become
    // the jersey labels. Text that is empty after cleaning is a skip.
    const text = labelTeams(stripMediaTalk(r.text), o.store.memory.teamLabels);
    const skipped = r.text.trim().toUpperCase() === 'SKIP' || text === '';
    thread.commit(text || 'SKIP');
    o.store.addUpdate(text, skipped);
    samples.push({ index: i + 1, text, ms: r.ms, model: r.model, skipped, tokensIn: r.tokensIn, tokensOut: r.tokensOut });
    log('');
    log(`--- update ${i + 1}/${count} · ${r.ms} ms · ${r.tokensIn} in / ${r.tokensOut} out${skipped ? ' · SKIP' : ''} ---`);
    log(text || '(empty response)');
    if (i < count - 1 && o.gapMs !== 0) await sleep(o.gapMs ?? 20_000);
  }
  return samples;
}
