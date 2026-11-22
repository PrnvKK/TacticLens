// pnpm llm:calibrate  -  re-measure the Kimi cache behaviour with at most 15 real calls (override: LLM_CALIBRATE_MAX).
// Measures: cold vs warm TTFT, the cache block size, image tokens at 768 and 512 wide, and the token count of the
// stable prefix, then pads the prefix so the shared layer and each lane layer end exactly on a 1024-token block.
// Results go to core/src/llm/cache/calibration.json (+ a TS mirror the extension bundles).
import { readFileSync, writeFileSync } from 'node:fs';
import { KIMI_PROMPT_SPEC, REFERENCE_MATCH, DIRECTOR_SCHEMA, DIRECTOR_SCHEMA_NAME, WATCH_SCHEMA, WATCH_SCHEMA_NAME } from '../../core/src/director/index';
import { BOUNDARY_OFFSET_TOKENS, DEFAULT_CHARS_PER_TOKEN, PromptBuilder, BRIDGE_A, type Calibration, type ModelCalibration } from '../../core/src/llm/cache/index';
import type { LLMRequest } from '../../core/src/llm/providers';
import { liveSetup, measure, type Measured } from './common';

const MAX_CALLS = Number(process.env.LLM_CALIBRATE_MAX ?? 15);
const BLOCK = 1024;
const OFF = BOUNDARY_OFFSET_TOKENS;

const setup = liveSetup();
if (!setup) { console.log('[calibrate] set CEREBRAS_API_KEY and CEREBRAS_KIMI_MODEL in .env; nothing to do.'); process.exit(0); }
const { provider, model } = setup;
let calls = 0;
const totals = { queueFull: 0, rateLimited: 0, retries: 0, retrySuccess: 0 };
const log: string[] = [];
const say = (s: string): void => { console.log(s); log.push(s); };

async function call(label: string, req: LLMRequest): Promise<Measured> {
  if (calls >= MAX_CALLS) throw new Error(`call budget of ${MAX_CALLS} reached before "${label}"`);
  calls++;
  const m = await measure(provider, req);
  totals.queueFull += m.queueFull;
  totals.rateLimited += m.rateLimited;
  totals.retries += m.retries;
  if (m.retrySuccess) totals.retrySuccess++;
  const refusals = [
    m.queueFull ? ` queue_full ${m.queueFull}` : '',
    m.rateLimited ? ` rate_limited ${m.rateLimited}` : '',
    m.retries ? ` retries ${m.retries}${m.retrySuccess ? ' (recovered)' : ''}` : '',
  ].join('');
  say(`[${String(calls).padStart(2)}] ${label}: status ${m.status} prompt ${m.prompt} cached ${m.cached} completion ${m.completion} ttft ${m.ttftMs} ms${refusals}${m.error ? ` error ${m.error.slice(0, 120)}` : ''}`);
  if (!m.ok) throw new Error(`call failed: ${label} (HTTP ${m.status})`);
  return m;
}

const tiny = (messages: LLMRequest['messages'], schema?: LLMRequest['schema']): LLMRequest => ({
  lane: 'director', messages, schema: schema ?? null, maxCompletionTokens: 8, reasoningEffort: 'low', framesSent: 0,
});

const builder = new PromptBuilder(KIMI_PROMPT_SPEC, { model });
const charsOf = (s: string): number => s.length;
const cached: number[] = [];

async function main(): Promise<void> {
  say(`[calibrate] model ${model}, spec ${KIMI_PROMPT_SPEC.version}, max ${MAX_CALLS} calls`);

  // ---- 1. shared layer: pad so [shared][pad][A] ends one block edge, with the next layer's bridge after it ----
  builder.force({ sharedPad: 0 });
  const sys0 = builder.sharedOnly();
  const p0 = (await call('shared layer, no pad', tiny([{ role: 'system', content: sys0 }, { role: 'user', content: '.' }]))).prompt;
  let cpt = charsOf(sys0) / Math.max(1, p0 - 12);
  const kShared = Math.max(1, Math.ceil((p0 - OFF) / BLOCK));
  const targetShared = kShared * BLOCK + OFF;
  let pad = Math.max(0, Math.round((targetShared - p0) * cpt));
  let pShared = p0;
  for (let i = 0; i < 3; i++) {
    builder.force({ sharedPad: pad });
    const sys = builder.sharedOnly();
    pShared = (await call(`shared layer, pad ${pad}`, tiny([{ role: 'system', content: sys }, { role: 'user', content: '.' }]))).prompt;
    cpt = charsOf(sys) / Math.max(1, pShared - 12);
    if (Math.abs(pShared - targetShared) <= 10) break;
    pad = Math.max(0, pad + Math.round((targetShared - pShared) * cpt));
  }
  const sharedPad = pad;
  const sharedChars = KIMI_PROMPT_SPEC.shared.length + sharedPad + BRIDGE_A.length;
  say(`[calibrate] shared layer: ${kShared} block(s), pad ${sharedPad} chars, prompt_tokens ${pShared} (target ${targetShared}), ${cpt.toFixed(2)} chars/token`);

  // ---- 2. each lane layer ----
  // Alignment is measured on the MESSAGES only. A response_format / json_schema is appended to the
  // request after the user message and contributes prompt_tokens, but it can never be part of the
  // cached message prefix. Counting it here made the lane pad ~200 tokens short, so the third 1024-token
  // block always missed and only 2048 tokens were ever cached (measured 2026-11-22).
  const lanes: Record<string, { segChars: number; tokens: number }> = {};
  const lanePads: Record<string, number> = {};
  const laneSchema: Record<string, LLMRequest['schema']> = {
    director: { name: DIRECTOR_SCHEMA_NAME, schema: DIRECTOR_SCHEMA }, watch: { name: WATCH_SCHEMA_NAME, schema: WATCH_SCHEMA },
  };
  let lastWatch = 0;
  for (const lane of ['director', 'watch']) {
    builder.force({ sharedPad, lanePad: { ...lanePads, [lane]: 0 } });
    let built = builder.build({ lane, match: REFERENCE_MATCH, tail: '.' });
    let p = (await call(`${lane} lane, no pad`, tiny(built.messages))).prompt;
    const k2 = Math.max(1, Math.ceil((p - pShared - 0) / BLOCK));
    const target = kShared * BLOCK + k2 * BLOCK + OFF;
    let lp = 0;
    let lastP = p;
    for (let i = 0; i < 2 && Math.abs(target - lastP) > 10; i++) {
      lp = Math.max(0, lp + Math.round((target - lastP) * cpt));
      builder.force({ sharedPad, lanePad: { ...lanePads, [lane]: lp } });
      built = builder.build({ lane, match: REFERENCE_MATCH, tail: '.' });
      lastP = (await call(`${lane} lane, pad ${lp}`, tiny(built.messages))).prompt;
    }
    lanePads[lane] = lp;
    lanes[lane] = { segChars: built.info.laneChars, tokens: lastP };
    if (lane === 'watch') lastWatch = lastP;
    say(`[calibrate] ${lane} lane: ${k2} block(s), pad ${lp} chars, message prompt_tokens ${lastP} (target ${target}; schema tokens excluded)`);
  }

  // ---- 3. cold vs warm TTFT and the cache block size, with the real director request ----
  builder.force({ sharedPad, lanePad: lanePads });
  const tail = { clock: '23:14', t: 1394, scene: 'WIDE', ball: { state: 'visible', x: 0.7, y: 0.45 }, possession: { A: 57, B: 43, current: 'A' }, live: [3, 7, 9, 14, 21], events: [], menu: [{ id: 'overload', label: '4 v 2 overload', targets: [3, 7, 9], team: 'A', attackers: 4, defenders: 2 }], screen: null, sinceLastGraphicS: 30, calm: { state: 'ready', reason: 'calm ready' }, recent: [] };
  const real = (salt: string, t2: number): LLMRequest => {
    const b = builder.build({ lane: 'director', match: REFERENCE_MATCH, tail: { ...tail, t: t2 } });
    const msgs = salt ? [{ role: 'system' as const, content: `[session ${salt}]\n${b.stable}` }, b.messages[1]!] : b.messages;
    return { lane: 'director', messages: msgs, schema: laneSchema.director, maxCompletionTokens: 500, reasoningEffort: 'low', framesSent: 0 };
  };
  const salt = Math.random().toString(36).slice(2, 10);
  const cold = await call('director, cold prefix (salted)', real(salt, 1394));
  const warm1 = await call('director, same prefix, warm', real(salt, 1395));
  const warm2 = await call('director, same prefix, warm (2)', real(salt, 1396));
  cached.push(warm1.cached, warm2.cached);
  const warmTtft = Math.round((warm1.ttftMs + warm2.ttftMs) / 2);

  // ---- 4. image tokens ----
  let w768 = 0, w512 = 0;
  if (provider.supportsImages) {
    const img = (file: string): string => `data:image/jpeg;base64,${readFileSync(new URL(`./fixtures/${file}`, import.meta.url)).toString('base64')}`;
    try {
      const b768 = builder.build({ lane: 'watch', match: REFERENCE_MATCH, tail: '.', image: img('frame-768.jpg') });
      const m768 = await call('watch lane + 768x432 image', tiny(b768.messages));
      w768 = m768.prompt - lastWatch;
      const b512 = builder.build({ lane: 'watch', match: REFERENCE_MATCH, tail: '.', image: img('frame-512.jpg') });
      const m512 = await call('watch lane + 512x288 image', tiny(b512.messages));
      w512 = m512.prompt - lastWatch;
      cached.push(m768.cached, m512.cached);
    } catch (e) { say(`[calibrate] image calls failed: ${(e as Error).message}`); }
  }

  // ---- 5. write ----
  const nz = cached.filter((c) => c > 0);
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = nz.reduce(gcd, 0);
  const cacheBlockTokens = g > 0 && nz.every((c) => c % BLOCK === 0) ? BLOCK : g || BLOCK;
  const mc: ModelCalibration = {
    charsPerToken: Math.round(cpt * 100) / 100 || DEFAULT_CHARS_PER_TOKEN,
    imageTokens: { w768, w512 },
    ttftMs: { cold: cold.ttftMs, warm: warmTtft },
    cacheBlockTokens,
    prompts: { [KIMI_PROMPT_SPEC.version]: { sharedChars, sharedTokens: pShared, lanes } },
  };
  const file = new URL('../../core/src/llm/cache/calibration.json', import.meta.url);
  let cal: Calibration;
  try { cal = JSON.parse(readFileSync(file, 'utf8')) as Calibration; } catch { cal = { schema: 1, blockSize: BLOCK, measuredAt: '', models: {} }; }
  cal = { schema: 1, blockSize: BLOCK, measuredAt: new Date().toISOString(), models: { ...cal.models, [model]: mc } };
  writeFileSync(file, `${JSON.stringify(cal, null, 2)}\n`);
  writeFileSync(
    new URL('../../core/src/llm/cache/calibration.data.ts', import.meta.url),
    `// Generated by \`pnpm llm:calibrate\` (mirror of calibration.json). Do not edit by hand.\nimport type { Calibration } from './calibration';\n\nexport const BUNDLED_CALIBRATION: Calibration = ${JSON.stringify(cal, null, 2)};\n`,
  );
  say(`[calibrate] done in ${calls} calls. TTFT cold ${cold.ttftMs} ms, warm ${warmTtft} ms; cached tokens seen ${nz.join(', ') || 'none'}; cache block ${cacheBlockTokens}; image tokens 768x432 ${w768}, 512x288 ${w512}.`);
  say(`[calibrate] stable prefix tokens: shared ${pShared}, director ${lanes.director?.tokens}, watch ${lanes.watch?.tokens} (each includes a 1-token tail).`);
  say(`[calibrate] refusals: queue_full ${totals.queueFull}, rate_limited ${totals.rateLimited}; retries ${totals.retries}, recovered ${totals.retrySuccess}.`);
}

// Never process.exit() from an async callback: on Windows that races undici's handle teardown
// (UV_HANDLE_CLOSING assertion). Every fetch body is fully read inside measure()/streamChat(), so
// letting the event loop drain is safe; the exit code still reports the failure.
main().catch((e) => {
  console.error(`[calibrate] ${(e as Error).message}`);
  process.exitCode = 1;
});
