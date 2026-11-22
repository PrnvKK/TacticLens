// One real streamed Kimi call through the SAME TPS calculator the extension uses.
//   node --no-warnings --experimental-transform-types --import ./tools/replay/register.mjs tools/llm/speed-check.ts
// Prints the model id, TTFT, tokens, TPS and the timestamp. The API key is read from .env and never printed.
import { streamChat } from '../../core/src/llm/index';
import { feedLLMEvent, SpeedTracker } from '../../extension/lib/speed/tps';
import { liveSetup } from './common';

const setup = liveSetup();
if (!setup) {
  console.log('[speed] CEREBRAS_API_KEY not set in .env; nothing to measure.');
  process.exit(0);
}
const { provider, model } = setup;
if (!model) {
  console.log('[speed] CEREBRAS_KIMI_MODEL is empty; set it in .env before measuring.');
  process.exit(0);
}

const tracker = new SpeedTracker();
const id = 'live-check';
const request = {
  lane: 'ask' as const,
  maxCompletionTokens: 600,
  reasoningEffort: 'low' as const,
  messages: [{
    role: 'user' as const,
    content:
      'You are a football analyst. A team presses high with a 4-3-3 and leaves the two centre-backs 1v1. ' +
      'In about 120 words, describe how the team in possession should build through the first line and the ' +
      'one signal that tells the ball carrier to go long instead. Concrete movements, no headings.',
  }],
};

const startedAt = new Date().toISOString();
const t0 = performance.now();
const result = await streamChat({
  provider,
  request,
  // Called synchronously from the SSE reader: performance.now() here is the network-receipt time.
  onEvent: (e) => feedLLMEvent(tracker, id, e, performance.now(), { lane: 'ask', provider: provider.name }),
});
const wallMs = performance.now() - t0;
const snap = tracker.snapshot(performance.now());
const call = snap.calls[0];
const timing = result.timing;

const report = {
  at: startedAt,
  model,
  ok: result.ok,
  status: result.status,
  usageReported: timing.usageReported,
  ttftMs: Math.round(call?.ttftMs ?? timing.ttftMs),
  totalMs: Math.round(timing.totalMs),
  streamWallMs: Math.round(wallMs),
  tokensOut: call?.tokens ?? 0,
  tps: Math.round((call?.tps ?? 0) * 10) / 10,
  tpsFromCore: Math.round(timing.tokPerS),
  textChars: result.text.length,
  error: result.error ? result.error.slice(0, 200) : undefined,
};
console.log(`[speed] ${report.at} model=${report.model} ok=${report.ok} ttft=${report.ttftMs}ms tokens=${report.tokensOut} tps=${report.tps} total=${report.totalMs}ms usage=${report.usageReported}`);
console.log(JSON.stringify(report, null, 2));
