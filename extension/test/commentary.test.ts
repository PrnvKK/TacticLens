import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyFacts } from '@tacticlens/core';
import { CommentaryDriver } from '../lib/live/commentary';
import { llmCall } from '../lib/llm/client';

vi.mock('../lib/llm/client', () => ({ llmCall: vi.fn() }));
vi.mock('../lib/llm/frame', () => ({
  annotatedJpeg: vi.fn(async () => ({ dataUrl: 'data:image/jpeg;base64,AAAA', bytes: 4, width: 768, height: 432 })),
}));
vi.mock('@tacticlens/core', async (orig) => ({
  ...(await orig<object>()),
  packMatch: () => ({ tracks: [] }),
}));

const STAMP = { provider: 'p', lane: 'ask', ttftMs: 120, totalMs: 300, tokensIn: 1, tokensOut: 5, tokPerS: 900, framesSent: 1 };

const okOutcome = (say: string, phase = 'build_up') =>
  ({ status: 'ok', stamp: STAMP, result: { ok: true, parsed: { say, phase }, timing: {} } }) as any;
const errOutcome = (error: string) =>
  ({ status: 'error', stamp: STAMP, result: { ok: false, error } }) as any;

interface Step { outcome: any; events?: string[] }

/** Each llmCall pops the next step; the last step repeats once the script runs out. */
let script: Step[] = [];
function setScript(...steps: Step[]): void { script = steps; }

const frame = {
  t: 10, tMedia: 10, scene: { kind: 'WIDE' }, teamsCalibrated: true,
  ball: { state: 'visible', xy: [0.5, 0.5] },
  tracks: [{ id: 7, cls: 'player', team: 'A', timeSinceUpdate: 0, age: 2, foot: [0.5, 0.5], box: [0.4, 0.3, 0.6, 0.7] }],
  teamColours: { A: '#ff0000', B: '#ffff00' },
  playbackRate: 1,
} as any;

let controller: { message: ReturnType<typeof vi.fn>; hud?: any };
let clock: { currentTime: number; paused: boolean; playbackRate: number };
let source: any;
let video: any;
let driver: CommentaryDriver | null = null;
/** Virtual performance.now(), advanced together with the fake timers. */
let pn = 100_000;

function makeDriver(preset: 'mock' | 'cerebras-kimi' = 'mock', kimiModel?: string): CommentaryDriver {
  driver = new CommentaryDriver({
    controller: controller as any, clock: clock as any, video, source, preset, kimiModel,
  });
  return driver;
}

/** Advance fake timers and the virtual clock in lockstep, 100 ms at a time. */
async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 100) {
    pn += 100;
    await vi.advanceTimersByTimeAsync(100);
  }
}

const messages = (): any[] => controller.message.mock.calls.map((c) => c[0]);
const notes = (id: string): any[] => messages().filter((m) => m.kind === 'feed_note' && m.id === id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  pn = 100_000;
  vi.spyOn(performance, 'now').mockImplementation(() => pn);
  vi.stubGlobal('createImageBitmap', async () => ({ close() {} }));
  vi.stubGlobal('__TL_KIMI_MODEL__', '');
  controller = { message: vi.fn() };
  clock = { currentTime: 0, paused: false, playbackRate: 1 };
  source = { isReady: true, history: [frame], measure: { last: null, recent: [] } };
  video = { videoWidth: 1280, videoHeight: 720, paused: false };
  setScript({ outcome: okOutcome('Red press'), events: ['Red press'] });
  vi.mocked(llmCall).mockReset();
  vi.mocked(llmCall).mockImplementation(((_preset: unknown, _req: unknown, opts: any) => {
    const step = script.length > 1 ? script.shift()! : script[0]!;
    for (const text of step.events ?? []) opts?.onEvent?.({ type: 'say', text, complete: false } as any);
    return { id: 'c1', cancel() {}, done: Promise.resolve(step.outcome) };
  }) as any);
});

afterEach(() => {
  driver?.stop();
  driver = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CommentaryDriver.ask', () => {
  it('streams the answer, strips every player id, and posts no error note', async () => {
    setScript({ outcome: okOutcome('Player [[7]] is free and [[99]] is not.', 'build_up'), events: ['Red press'] });
    const d = makeDriver();
    await d.ask('who is free?');

    const msgs = messages();
    expect(msgs[0]).toEqual({ kind: 'typing', on: true });

    const askLines = msgs.filter((m) => m.kind === 'line' && m.line.lane === 'ask');
    expect(askLines.some((m) => m.line.text === 'Red press')).toBe(true);

    const finalLine = askLines.find((m) => m.line.text.includes('is free'));
    expect(finalLine).toBeDefined();
    expect(finalLine.line.text).toBe('Player is free and is not.');
    expect(finalLine.line.text).not.toContain('[[');
    expect(finalLine.line.mentions).toEqual([]);

    // The typing bubble is switched off once the call ends.
    const typing = msgs.filter((m) => m.kind === 'typing');
    expect(typing[typing.length - 1]).toEqual({ kind: 'typing', on: false });

    expect(msgs.filter((m) => m.kind === 'feed_note')).toEqual([]);
  });

  it('posts an ask-error note with the provider message when the call fails', async () => {
    setScript({ outcome: errOutcome('HTTP 401 bad key') });
    const d = makeDriver();
    await d.ask('what happened?');

    const n = notes('ask-error');
    expect(n).toHaveLength(1);
    expect(n[0].text).toContain('401');
  });

  it('retries text-only when the picture was the problem, and stays silent when the retry works', async () => {
    setScript(
      { outcome: errOutcome('HTTP 500 image input unsupported') },
      { outcome: okOutcome('Team B is pressing high.') },
    );
    const d = makeDriver();
    await d.ask('what is the press like?');

    expect(llmCall).toHaveBeenCalledTimes(2);
    const first = vi.mocked(llmCall).mock.calls[0]![1] as any;
    const second = vi.mocked(llmCall).mock.calls[1]![1] as any;
    expect(Array.isArray(first.messages[1].content)).toBe(true);
    expect(typeof second.messages[1].content).toBe('string');
    expect(notes('ask-error')).toEqual([]);
  });

  it('retries an empty answer once text-only with the larger cap, then shows the reworded note', async () => {
    setScript({ outcome: okOutcome('') });
    const d = makeDriver();
    await d.ask('anything?');

    const calls = vi.mocked(llmCall).mock.calls.map((c) => c[1] as any);
    expect(calls).toHaveLength(2);
    expect(calls[0].maxCompletionTokens).toBe(600);
    expect(calls[1].maxCompletionTokens).toBe(800);
    expect(typeof calls[1].messages[1].content).toBe('string');

    const n = notes('ask-error');
    expect(n).toHaveLength(1);
    expect(n[0].text).toBe("Kimi couldn't read that one. Try asking again.");
    expect(JSON.stringify(messages())).not.toMatch(/this frame/);
  });

  it('retries a queue refusal and shows one answer from the second try, with no error note', async () => {
    setScript({ outcome: queueOutcome() }, { outcome: okOutcome('Team Red are pressing high.') });
    const d = makeDriver();
    const p = d.ask('how is the press?');
    await advance(13_000);
    await p;

    expect(llmCall).toHaveBeenCalledTimes(2);
    const answers = messages().filter((m) => m.kind === 'line' && m.line.lane === 'ask');
    expect(answers.map((m) => m.line.text)).toEqual(['Team Red are pressing high.']);
    expect(notes('ask-error')).toEqual([]);
  });

  it('keeps retrying a busy question every ~10 s with no note, then shows the answer when one gets through', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter: retries land at exactly 10 s, 20 s, ...
    setScript(...Array.from({ length: 5 }, () => ({ outcome: queueOutcome() })), { outcome: okOutcome('Team Red are pressing high.') });
    const d = makeDriver();
    let settled = false;
    const p = d.ask('still there?').then(() => { settled = true; });

    // Five refusals take about 50 s of retries: the question is still pending, nothing is posted, the typing bubble is still on.
    await advance(42_000);
    expect(llmCall).toHaveBeenCalledTimes(5);
    expect(settled).toBe(false);
    expect(notes('ask-error')).toEqual([]);
    expect(JSON.stringify(messages())).not.toMatch(/busy|high traffic|queue_exceeded/i);
    const typing = messages().filter((m) => m.kind === 'typing');
    expect(typing[typing.length - 1]).toMatchObject({ on: true });

    // The sixth call gets through.
    await advance(13_000);
    await p;
    expect(llmCall).toHaveBeenCalledTimes(6);
    expect(messages().filter((m) => m.kind === 'line' && m.line.lane === 'ask').map((m) => m.line.text)).toEqual(['Team Red are pressing high.']);
    expect(notes('ask-error')).toEqual([]);
    const after = messages().filter((m) => m.kind === 'typing');
    expect(after[after.length - 1]).toMatchObject({ on: false });
  });

  it('shows the answer from the raw text when the JSON was cut off by the cap', async () => {
    setScript({
      outcome: { status: 'ok', stamp: STAMP, result: { ok: true, parsed: undefined, text: '{"say": "Team Red press high.", "phase": "press"', timing: {} } } as any,
    });
    const d = makeDriver();
    await d.ask('how is the press?');

    expect(llmCall).toHaveBeenCalledTimes(1);
    const answers = messages().filter((m) => m.kind === 'line' && m.line.lane === 'ask');
    expect(answers.map((m) => m.line.text)).toEqual(['Team Red press high.']);
    expect(notes('ask-error')).toEqual([]);
  });

  it('drops media talk from the answer before it reaches the chat', async () => {
    setScript({ outcome: okOutcome('The annotated image shows Team Red high. Team Red are pressing high.') });
    const d = makeDriver();
    await d.ask('press?');

    const answers = messages().filter((m) => m.kind === 'line' && m.line.lane === 'ask');
    expect(answers.map((m) => m.line.text)).toEqual(['Team Red are pressing high.']);
  });
});

/** A queue refusal as the client reports it (HTTP 429, queue_exceeded). */
const queueOutcome = () =>
  ({
    status: 'error', stamp: STAMP,
    result: { ok: false, status: 429, error: 'HTTP 429 {"code":"queue_exceeded","message":"We\'re experiencing high traffic right now!"}', errorKind: 'queue_full', timing: {} },
  }) as any;

const shown = (value: unknown, updatedAt: number) => ({ value, confidence: 1, updatedAt, gate: 'shown' });
const pausedStat = (value: unknown, updatedAt: number) => ({ value, confidence: 1, updatedAt, gate: 'hidden', paused: true });
const matchOf = (stats: Record<string, unknown>) => ({ liveness: 'LIVE', stats }) as any;

/** The text part of a request's user message (the image variant carries it as the second content part). */
function userText(req: any): string {
  const c = req.messages[1].content;
  return typeof c === 'string' ? c : c.find((p: any) => p.type === 'text').text;
}
/** The JSON payload that follows the "Viewer question" line. */
const askPayload = (req: any): any => JSON.parse(userText(req).split('\n')[1]!);
const askRequests = (): any[] => vi.mocked(llmCall).mock.calls.map((c) => c[1] as any).filter((r) => r.lane === 'ask');

describe('CommentaryDriver long-term memory', () => {
  it('sends a memory block with every ask, and the system prompt forbids refusing because stats are paused', async () => {
    const d = makeDriver();
    await d.ask('who is on top?');

    const req = askRequests()[0];
    expect(userText(req)).toMatch(/^Viewer question: "who is on top\?"\n/);
    const payload = askPayload(req);
    expect(payload).toHaveProperty('memory');
    expect(payload.memory).toMatchObject({ teams: ['Team A', 'Team B'], lastKnownStats: {}, minutes: [], events: [], said: [] });

    const system: string = req.messages[0].content;
    expect(system).toMatch(/"paused"/);
    expect(system).toMatch(/NEVER a reason to refuse/);
    expect(system).toMatch(/memory\.lastKnownStats/);
    expect(system).toMatch(/Team <colour>/);
    expect(system).toMatch(/35 words/);
  });

  it('answers from the last real stats when everything is paused at ask time (video paused, ball out)', async () => {
    controller.hud = { m: { jersey: { A: 'Red', B: 'Yellow' }, feed: [] } } as any;
    source.measure.last = { match: matchOf({ possession: shown({ A: 61.2, B: 38.8 }, 9), freePlayers: shown({ A: 3, B: 1 }, 9) }) };
    source.measure.recent = [{ type: 'turnover', t: 7, team: 'B', confidence: 0.9, detail: { from: 'A', carrierId: 7 } }];
    const d = makeDriver();
    d.start();
    await advance(600);   // one tick has fed the memory (and the commentary lane has spoken once)

    // The ball goes out and the viewer pauses the video: every ball-dependent stat is now "paused".
    source.measure.last = { match: matchOf({ possession: pausedStat({ A: 61.2, B: 38.8 }, 9), freePlayers: shown({ A: 3, B: 1 }, 9) }) };
    clock.paused = true;
    await d.ask('who has had more of the ball?');

    const payload = askPayload(askRequests()[0]);
    expect(payload.memory.teams).toEqual(['Team Red', 'Team Yellow']);
    expect(payload.memory.lastKnownStats.possession).toEqual({ value: { 'Team Red': 61, 'Team Yellow': 39 }, agoS: 1 });
    expect(payload.memory.events).toEqual([{ type: 'turnover', team: 'Team Yellow', agoS: 3, from: 'Team Red' }]);
    // What Kimi already said is in memory too.
    expect(payload.memory.said).toEqual([{ by: 'commentary', agoS: 0, text: 'Red press' }]);
    expect(JSON.stringify(payload.memory)).not.toContain('paused');
  });

  it('puts the possession split and the mid-term memory in the commentary payload', async () => {
    source.measure.last = { match: matchOf({ possession: shown({ A: 55, B: 45 }, 10) }) };
    const d = makeDriver();
    d.start();
    await advance(600);

    const req = vi.mocked(llmCall).mock.calls[0]![1] as any;
    expect(req.lane).toBe('reflex');
    const payload = JSON.parse(userText(req));
    expect(payload.possessionNow).toEqual({ value: { 'Team A': 55, 'Team B': 45 }, agoS: 0 });
    expect(payload.memory).toHaveProperty('minutes');
    expect(payload.memory).not.toHaveProperty('lastKnownStats');
    // Kimi is told what it said lately; nothing has been said yet.
    expect(payload.recent).toEqual([]);
  });

  it('sends a compact commentary payload with no tracks, velocities or ids, and a mid-term system prompt', async () => {
    controller.hud = { m: { jersey: { A: 'Red', B: 'Yellow' }, feed: [] } } as any;
    source.measure.last = { match: matchOf({ possession: shown({ A: 60, B: 40 }, 10) }) };
    const d = makeDriver();
    d.start();
    await advance(600);

    const req = vi.mocked(llmCall).mock.calls[0]![1] as any;
    const text = userText(req);
    expect(JSON.parse(text).scout).toEqual({ A: 'Team Red', B: 'Team Yellow' });
    expect(text).not.toMatch(/"tracks"|"velocity|"vx"|"vy"|"id"/);
    expect(text).not.toContain('"7"');
    expect(text.length).toBeLessThan(1800);

    const system: string = req.messages[0].content;
    expect(system).toMatch(/momentum/);
    // Kimi writes the sentence itself: one `say` plus up to two `next` follow-ups.
    expect(system).toMatch(/ONE short sentence/);
    expect(Object.keys(req.schema.schema.properties)).toEqual(['say', 'next', 'phase']);
    expect(req.maxCompletionTokens).toBe(300);
  });

  it('remembers director lines from the chat feed and the answers it gave itself', async () => {
    controller.hud = { m: { jersey: { A: 'Red', B: 'Yellow' }, feed: [
      { id: 'dir1', kind: 'kimi', lane: 'director', final: true, text: 'Team Red switch the play.', phase: 'transition' },
      { id: 'dir2', kind: 'kimi', lane: 'director', final: false, text: 'half-streamed', phase: 'none' },
      { id: 'you1', kind: 'you', lane: 'ask', final: true, text: 'a question', phase: 'none' },
    ] } } as any;
    setScript({ outcome: okOutcome('Team Red are ahead.', 'settled') });
    const d = makeDriver();
    d.start();
    await advance(600);
    await d.ask('who leads?');

    const said = askPayload(askRequests()[0]).memory.said;
    expect(said.map((s: any) => [s.by, s.text])).toEqual([['director', 'Team Red switch the play.'], ['commentary', 'Team Red are ahead.']]);
    // The answer itself is remembered for the next question.
    expect(d.memory.toPayload(10).said.at(-1)).toMatchObject({ by: 'answer', text: 'Team Red are ahead.' });
    expect(d.memory.toPayload(10).phases).toEqual({ transition: 1, settled: 2 });
  });
});

describe('CommentaryDriver commentary tick', () => {
  it('speaks on the reflex lane right away, then again after the normal gap', async () => {
    const d = makeDriver();
    d.start();

    await advance(600);
    expect(llmCall).toHaveBeenCalledTimes(1);
    const req = vi.mocked(llmCall).mock.calls[0]![1] as any;
    expect(req.lane).toBe('reflex');
    expect(req.schema.name).toBe('live_line');
    expect(messages().some((m) => m.kind === 'line' && m.line.lane === 'watch')).toBe(true);

    // Under the 10 s cadence: no second call within about 8 s of the first.
    await advance(8_000);
    expect(llmCall).toHaveBeenCalledTimes(1);

    // Past the cadence: the next call goes out at about 10 s.
    await advance(3_000);
    expect(llmCall).toHaveBeenCalledTimes(2);
  });

  it('does not call the model while the clock is paused', async () => {
    clock.paused = true;
    const d = makeDriver();
    d.start();

    await advance(10_000);
    expect(llmCall).not.toHaveBeenCalled();
  });

  it('sends rule facts so commentary explains the mechanism, not just the stat', async () => {
    const facts = emptyFacts();
    facts.overload = { ...facts.overload, valid: true, confidence: 0.9, sinceS: 2, targets: [1, 2, 3], team: 'A', attackers: 3, defenders: 2, near: [1, 2, 3] };
    facts.press = { ...facts.press, valid: true, confidence: 0.9, sinceS: 3, targets: [1, 4, 5], carrierId: 1, pressers: 2, team: 'A' };
    facts.freePlayer = { ...facts.freePlayer, valid: true, confidence: 0.8, sinceS: 1, targets: [1, 2], carrierId: 1, freeId: 2, spaceM: 7.5, team: 'A' };
    source.measure.last = {
      match: {
        attackDir: { A: 'right', confidence: 0.8 },
        stats: { pressure: shown(2, 10), freePlayers: shown({ A: 3, B: 1 }, 10) },
      },
      detail: { facts, formation: { A: '4-3-3', B: '4-4-2' } },
    };

    const d = makeDriver();
    d.start();
    await advance(600);

    const payload = JSON.parse(userText(vi.mocked(llmCall).mock.calls[0]![1] as any));
    expect(payload.tactics).toMatchObject({
      attackDir: { A: 'right', B: 'left' },
      formations: { A: '4-3-3', B: '4-4-2' },
      facts: {
        overload: { team: 'Team A', attackers: 3, defenders: 2 },
        pressTrap: { onBall: 'Team A', pressers: 2 },
        freePlayer: { team: 'Team A', spaceM: 7.5 },
      },
    });
    // The raw stat feed is withheld; the facts block is what Kimi explains.
    expect(payload.memory).not.toHaveProperty('lastKnownStats');
    const system = (vi.mocked(llmCall).mock.calls[0]![1] as any).messages[0].content as string;
    expect(system).toMatch(/pressTrap\.onBall is the side being trapped/);
    expect(system).toMatch(/Start from tactics\.facts/);
  });

  it('batches two follow-up lines and exposes them five seconds apart', async () => {
    setScript({
      outcome: {
        status: 'ok', stamp: STAMP,
        result: { ok: true, parsed: { say: 'Line one', next: ['Line two', 'Line three'], phase: 'settled' }, timing: {} },
      } as any,
    });
    const d = makeDriver();
    d.start();

    await advance(600);
    expect(messages().filter((m) => m.kind === 'line' && m.line.lane === 'watch').map((m) => m.line.text)).toEqual(['Line one']);

    await advance(5_000);
    expect(messages().filter((m) => m.kind === 'line' && m.line.lane === 'watch').map((m) => m.line.text)).toEqual(['Line one', 'Line two']);

    await advance(6_000);
    // The next call starts at about 10 s and repeats the script, so look only at the first call's three lines.
    expect(messages().filter((m) => m.kind === 'line' && m.line.lane === 'watch').map((m) => m.line.text).slice(0, 3)).toEqual(['Line one', 'Line two', 'Line three']);
  });

  it('tells Kimi what it said lately so it does not repeat itself', async () => {
    setScript({
      outcome: {
        status: 'ok', stamp: STAMP,
        result: { ok: true, parsed: { say: 'Line one', next: ['Line two'], phase: 'settled' }, timing: {} },
      } as any,
    });
    const d = makeDriver();
    d.start();

    await advance(600);
    await advance(11_000);
    expect(llmCall).toHaveBeenCalledTimes(2);
    const second = JSON.parse(userText(vi.mocked(llmCall).mock.calls[1]![1] as any));
    expect(second.recent).toEqual(['Line one', 'Line two']);
  });

  it('scrubs player id tags and media talk from the sentences Kimi writes', async () => {
    setScript({
      outcome: {
        status: 'ok', stamp: STAMP,
        result: { ok: true, parsed: { say: 'The annotated image shows it. Team Red win the ball [[7]] back.', next: [], phase: 'press' }, timing: {} },
      } as any,
    });
    const d = makeDriver();
    d.start();
    await advance(600);

    expect(messages().filter((m) => m.kind === 'line' && m.line.lane === 'watch').map((m) => m.line.text)).toEqual(['Team Red win the ball back.']);
  });

  it('reports a missing Kimi model once and never calls the model', async () => {
    vi.stubGlobal('__TL_KIMI_MODEL__', '');
    const d = makeDriver('cerebras-kimi', '');
    d.start();

    const n = notes('cm-config');
    expect(n).toHaveLength(1);
    expect(n[0].text).toContain('CEREBRAS_KIMI_MODEL');

    await advance(10_000);
    expect(llmCall).not.toHaveBeenCalled();
  });

  it('posts a commentary error once per 30 s, not on every failing call', async () => {
    setScript({ outcome: errOutcome('HTTP 401 bad key') });
    const d = makeDriver();
    d.start();

    // First failing call at about 0.4 s.
    await advance(600);
    expect(llmCall).toHaveBeenCalledTimes(1);
    expect(notes('cm-error')).toHaveLength(1);
    expect(notes('cm-error')[0].text).toContain('401');

    // Calls land about every 15 s; the second one still falls inside the 30 s window.
    await advance(15_000);
    expect(llmCall).toHaveBeenCalledTimes(2);
    expect(notes('cm-error')).toHaveLength(1);

    // Once more than 30 s have passed since the first note, the next failure is shown again.
    await advance(30_000);
    expect(notes('cm-error')).toHaveLength(2);
  });

  it('stays silent when Kimi is busy, and shows a line when a later call gets through', async () => {
    setScript({ outcome: queueOutcome() }, { outcome: queueOutcome() }, { outcome: queueOutcome() }, { outcome: okOutcome('Team Red are pressing high.') });
    const d = makeDriver();
    d.start();

    // The first call is refused three times in a row: no busy note, no error note, no line.
    await advance(6_000);
    expect(llmCall).toHaveBeenCalledTimes(3);
    expect(notes('cm-error')).toEqual([]);
    expect(JSON.stringify(messages())).not.toMatch(/busy/i);
    expect(messages().filter((m) => m.kind === 'line')).toEqual([]);

    // The next scheduled call (about 10 s after the first started) goes through and its line reaches the chat.
    await advance(10_000);
    expect(llmCall).toHaveBeenCalledTimes(4);
    expect(messages().filter((m) => m.kind === 'line').map((m) => m.line.text)).toEqual(['Team Red are pressing high.']);
    expect(notes('cm-error')).toEqual([]);
  });
});
