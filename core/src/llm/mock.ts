// Mock provider: streams realistic schema-valid JSON as an OpenAI-style SSE stream, at configurable speed.
// Plugs in as a FetchLike, so the real client, timing and parsers are exercised offline.
import type { FetchInit, FetchLike, ResponseLike } from './client';

export interface MockSpeed { ttftMs: number; tokPerS: number; jitter?: number; /** TTFT when the prefix is cached (simulated). */ warmTtftMs?: number }
export type MockProfile = 'cerebras' | 'gpu' | 'kimi' | MockSpeed;

export const MOCK_PROFILES: Record<'cerebras' | 'gpu' | 'kimi', MockSpeed> = {
  cerebras: { ttftMs: 180, tokPerS: 1800, jitter: 0.15 },
  // Measured Kimi on Cerebras: ~1.15 s uncached, ~0.65 s with the prefix cached.
  kimi: { ttftMs: 1150, warmTtftMs: 650, tokPerS: 1500, jitter: 0.12 },
  gpu: { ttftMs: 900, tokPerS: 60, jitter: 0.25 },
};

const LINES = [
  'The [[A]] press is working and [[B]] cannot play out.',
  'Quick switch finds [[A]] free on the far side.',
  'Turnover, and [[B]] breaks at the open space.',
  'Shape stays compact, waiting for the trigger.',
  '',
];

const g = globalThis as unknown as {
  TextEncoder: new () => { encode(s: string): Uint8Array };
};

export interface MockOptions { seed?: number; sleep?: (ms: number) => Promise<void> }

function rng(seed: number) { let s = seed >>> 0 || 1; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

/** Ids of tracks mentioned in the request text (so mock graphics point at ids that exist). */
function idsFrom(body: any): number[] {
  const msgs: any[] = body?.messages ?? [];
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  const txt = last ? (typeof last.content === 'string' ? last.content : last.content.map((p: any) => p.text ?? '').join(' ')) : '';
  const ids = new Set<number>();
  for (const m of txt.matchAll(/"(\d{1,3})":\{"team"/g)) ids.add(Number(m[1]));
  return [...ids];
}

/** Build one schema-valid answer (matches OUTPUT_SCHEMA). */
export function mockAnswer(body: any, n: number): Record<string, unknown> {
  const ids = idsFrom(body);
  const pick = (i: number) => (ids.length ? ids[(n + i) % ids.length] : 7 + i);
  const say = LINES[n % LINES.length]!.replace('[[A]]', `[[${pick(0)}]]`).replace('[[B]]', `[[${pick(1)}]]`);
  const phases = ['build_up', 'press', 'transition', 'settled'];
  const kind = ['pass_to', 'switch', 'turnover', 'none'][n % 4];
  return {
    say,
    phase: phases[n % phases.length],
    focus: [pick(0), pick(1)],
    gfx: [
      { type: n % 2 ? 'spotlight' : 'lanes', ids: [pick(0)], team: 'A', label: 'free man' },
      ...(n % 3 === 0 ? [{ type: 'overload', ids: [pick(1), pick(2)], team: 'B', label: 'overload' }] : []),
    ],
    tiles: ['pressure', 'open_options'],
    predict: { kind, id: kind === 'pass_to' ? pick(2) : 0, side: kind === 'switch' ? 'left' : 'none', within_s: 5 },
    confidence: 0.8,
  };
}

/** Last user message parsed as JSON (the director payload is pure JSON after the static system prompt). */
function userJson(body: any): any {
  const msgs: any[] = body?.messages ?? [];
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  const txt = last ? (typeof last.content === 'string' ? last.content : last.content.map((p: any) => p.text ?? '').join(' ')) : '';
  try { return JSON.parse(txt); } catch { return null; }
}

/** Schema-valid watch observation: ids come from the live list in the tail. */
export function mockWatchAnswer(body: any, n: number): Record<string, unknown> {
  const payload = userJson(body) ?? userJsonLastText(body);
  const live: number[] = Array.isArray(payload?.live) ? payload.live.filter((x: unknown) => Number.isInteger(x)) : [];
  const phases = ['build_up', 'press', 'transition', 'settled'];
  const sides = ['left', 'centre', 'right'];
  return {
    phase: phases[n % phases.length], shape: n % 2 ? 'compact back four, winger isolated' : 'high press on the left, gap behind the line',
    hot: live.slice(n % Math.max(1, live.length), (n % Math.max(1, live.length)) + 2), ball_side: sides[n % sides.length], pressure: n % 3 ? 'low' : 'high',
  };
}

/** The text part of the last message when it is a content array (image + tail). */
function userJsonLastText(body: any): any {
  const msgs: any[] = body?.messages ?? [];
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  if (!last || typeof last.content === 'string') return null;
  const txt = last.content.filter((p: any) => p.type === 'text').map((p: any) => p.text ?? '').join(' ');
  try { return JSON.parse(txt); } catch { return null; }
}

/** Plausible, schema-valid director decisions from the live menu: mostly show, sometimes silence. */
export function mockDirectorAnswer(body: any, n: number): Record<string, unknown> {
  const payload = userJson(body);
  const menu: any[] = Array.isArray(payload?.menu) ? payload.menu : [];
  const screen = payload?.screen && typeof payload.screen === 'object' ? payload.screen : null;
  const none = { action: 'none', graphic: 'none', targets: [], caption: '', say: '', duration_s: 5, confidence: 0.55 };
  // If something is on screen, keep it about half the time so the mock also exercises keep.
  if (screen && n % 2 === 1) {
    return { action: 'keep', graphic: String(screen.graphic ?? 'none'), targets: [], caption: '', say: '', duration_s: 4, confidence: 0.6 };
  }
  if (!menu.length || n % 5 === 4) return none;
  const item = menu[n % menu.length]!;
  const targets = Array.isArray(item.targets) ? item.targets.filter((x: unknown) => Number.isInteger(x)).slice(0, 4) : [];
  const label = String(item.label ?? item.id ?? 'graphic');
  return {
    action: 'show',
    graphic: String(item.id ?? 'none'),
    targets,
    caption: label.split(/\s+/).slice(0, 4).join(' '),
    say: n % 2 ? `Watch ${label}.` : '',
    duration_s: 4 + (n % 3),
    confidence: 0.72,
  };
}

/** Split text into small stream pieces (~ one token = 3-4 chars). */
export function tokenize(s: string): string[] {
  return s.match(/.{1,4}/gs) ?? [];
}

export function createMockFetch(profile: MockProfile = 'cerebras', opts: MockOptions = {}): FetchLike {
  const speed = typeof profile === 'string' ? MOCK_PROFILES[profile] : profile;
  const rand = rng(opts.seed ?? 42);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => (globalThis as unknown as { setTimeout(f: () => void, ms: number): unknown }).setTimeout(r, ms)));
  let n = 0;
  const seenPrefixes: string[] = [];
  const enc = new g.TextEncoder();

  return async (_url: string, init: FetchInit): Promise<ResponseLike> => {
    const signal = init.signal as { aborted: boolean } | undefined;
    const body = JSON.parse(init.body);
    const idx = n++;
    const jit = () => 1 + (rand() * 2 - 1) * (speed.jitter ?? 0);
    const director = body?.response_format?.json_schema?.name === 'director_decision';
    const schemaName = body?.response_format?.json_schema?.name;
    const json = JSON.stringify(director ? mockDirectorAnswer(body, idx) : schemaName === 'watch_observation' ? mockWatchAnswer(body, idx) : mockAnswer(body, idx));
    const toks = tokenize(json);
    // Group tokens so each timer tick is >= ~8 ms (timer resolution); pacing stays at tokPerS overall.
    const group = Math.max(1, Math.round(8 / (1000 / speed.tokPerS)));
    const pieces: string[] = [];
    for (let i = 0; i < toks.length; i += group) pieces.push(toks.slice(i, i + group).join(''));
    const created = 1700000000;
    const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      enc.encode(`data: ${JSON.stringify({ id: `mock-${idx}`, object: 'chat.completion.chunk', created, model: 'mock', choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`);

    const sysText = typeof body.messages?.[0]?.content === 'string' ? (body.messages[0].content as string) : '';
    const imgs = JSON.stringify(body.messages).split('image_url').length - 1;
    const textTokens = Math.ceil((JSON.stringify(body.messages).replace(/data:image[^"]*/g, '').length) / 3.5);
    const promptTokens = textTokens + imgs * 448;
    // Simulated automatic prefix cache: 1024-token blocks of the shared system prefix already seen.
    let common = 0;
    for (const prev of seenPrefixes) { let i = 0; const m = Math.min(prev.length, sysText.length); while (i < m && prev.charCodeAt(i) === sysText.charCodeAt(i)) i++; if (i > common) common = i; }
    const cachedTokens = Math.min(promptTokens, Math.floor(Math.floor(common / 3.5) / 1024) * 1024);
    if (sysText && !seenPrefixes.includes(sysText)) { seenPrefixes.push(sysText); if (seenPrefixes.length > 6) seenPrefixes.shift(); }
    const ttftNow = cachedTokens > 0 && speed.warmTtftMs ? speed.warmTtftMs : speed.ttftMs;
    let step = -1; // -1 role chunk after ttft delay, 0..n-1 pieces, n finish, n+1 usage, n+2 done
    let closed = false;
    const reader = {
      async read(): Promise<{ done: boolean; value?: Uint8Array }> {
        if (closed || signal?.aborted) return { done: true };
        const s = step++;
        const perTok = (1000 / speed.tokPerS) * group;
        if (s === -1) { await sleep(ttftNow * jit()); if (signal?.aborted) return { done: true }; return { done: false, value: chunk({ role: 'assistant', content: '' }) }; }
        if (s < pieces.length) {
          await sleep(perTok * jit());
          if (signal?.aborted) return { done: true };
          return { done: false, value: chunk({ content: pieces[s] }) };
        }
        if (s === pieces.length) {
          return { done: false, value: enc.encode(`data: ${JSON.stringify({ id: `mock-${idx}`, object: 'chat.completion.chunk', created, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`) };
        }
        if (s === pieces.length + 1) {
          return { done: false, value: enc.encode(`data: ${JSON.stringify({ id: `mock-${idx}`, object: 'chat.completion.chunk', created, model: 'mock', choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: toks.length, total_tokens: promptTokens + toks.length, prompt_tokens_details: { cached_tokens: cachedTokens } } })}\n\n`) };
        }
        if (s === pieces.length + 2) return { done: false, value: enc.encode('data: [DONE]\n\n') };
        closed = true;
        return { done: true };
      },
      cancel() { closed = true; },
    };
    return { ok: true, status: 200, headers: { get: () => null }, body: { getReader: () => reader }, text: async () => '' };
  };
}

// One mock fetch per profile, so the call index (and therefore the scripted answer) advances across
// requests just like a real provider. Creating a fresh mock per streamChat call would restart at n=0.
const MOCK_BY_PROFILE = new Map<string, FetchLike>();
const MOCK_BY_OBJECT = new WeakMap<object, FetchLike>();

export function sharedMockFetch(profile: MockProfile = 'cerebras'): FetchLike {
  if (typeof profile === 'string') {
    let f = MOCK_BY_PROFILE.get(profile);
    if (!f) { f = createMockFetch(profile); MOCK_BY_PROFILE.set(profile, f); }
    return f;
  }
  let f = MOCK_BY_OBJECT.get(profile);
  if (!f) { f = createMockFetch(profile); MOCK_BY_OBJECT.set(profile, f); }
  return f;
}
