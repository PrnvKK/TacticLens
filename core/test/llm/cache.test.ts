import { describe, expect, it } from 'vitest';
import { KIMI_PROMPT_SPEC, REFERENCE_MATCH } from '../../src/director/kimiPrompt';
import {
  BRIDGE_A, BUNDLED_CALIBRATION, DEFAULT_CHARS_PER_TOKEN, PromptBuilder, fillerText, quantHex, renderMatchBlock, stableStringify,
  type Calibration, type MatchBlock,
} from '../../src/llm/cache';

const MATCH: MatchBlock = { teams: { A: { name: 'Blue', kit: '#1f3fa1' }, B: { name: 'Red', kit: '#c8202a' } }, attack: { A: 'right', B: 'left' } };

describe('deterministic serialisation', () => {
  it('sorts keys and rounds numbers identically regardless of insertion order', () => {
    const a = { z: 1.23456, a: [1.006, { y: 2, x: 3 }], m: null, u: undefined };
    const b = { m: null, a: [1.006, { x: 3, y: 2 }], z: 1.23456 };
    expect(stableStringify(a, 2)).toBe(stableStringify(b, 2));
    expect(stableStringify(a, 2)).toBe('{"a":[1.01,{"x":3,"y":2}],"m":null,"z":1.23}');
  });
  it('quantises kit colours so measurement noise does not change the match block', () => {
    expect(quantHex('#1f3fa1')).toBe(quantHex('#203fa0'));
    expect(renderMatchBlock({ ...MATCH, teams: { ...MATCH.teams, A: { name: 'Blue', kit: '#203fa0' } } })).toBe(renderMatchBlock(MATCH));
  });
  it('same input gives an identical prefix string, with nothing volatile before the tail', () => {
    const b1 = new PromptBuilder(KIMI_PROMPT_SPEC, { model: 'm' });
    const b2 = new PromptBuilder(KIMI_PROMPT_SPEC, { model: 'm' });
    const x = b1.build({ lane: 'director', match: MATCH, tail: { t: 7777.77, live: [1, 2] } });
    const y = b2.build({ lane: 'director', match: MATCH, tail: { t: 8888.88, live: [7] } });
    expect(x.stable).toBe(y.stable);
    expect(x.fingerprint).toBe(y.fingerprint);
    expect(x.messages[1]!.content).not.toBe(y.messages[1]!.content);
    expect(x.stable).not.toMatch(/7777|8888/);
  });
});

describe('block alignment', () => {
  const block = Math.round(1024 * DEFAULT_CHARS_PER_TOKEN);
  it('pads the shared layer and each lane layer to whole 1024-token blocks (estimate)', () => {
    const b = new PromptBuilder(KIMI_PROMPT_SPEC, { model: 'm' });
    for (const lane of ['director', 'watch']) {
      const p = b.build({ lane, match: MATCH, tail: 'x' });
      expect(p.info.sharedChars % block).toBe(0);
      expect(p.info.laneChars % block).toBe(0);
      expect(p.info.padShared).toBeGreaterThanOrEqual(0);
      expect(p.info.padLane).toBeGreaterThanOrEqual(0);
    }
  });
  it('all lanes share the first block-aligned layer byte for byte', () => {
    const b = new PromptBuilder(KIMI_PROMPT_SPEC, { model: 'm' });
    const d = b.build({ lane: 'director', match: MATCH, tail: 'x' });
    const w = b.build({ lane: 'watch', match: MATCH, tail: 'x' });
    const n = d.info.sharedChars;
    expect(d.stable.slice(0, n)).toBe(w.stable.slice(0, n));
    expect(d.stable.slice(0, n).endsWith(BRIDGE_A)).toBe(true);
    expect(d.stable).not.toBe(w.stable);
  });
  it('a changed match block only rewrites the lane layer; the shared layer stays', () => {
    const b = new PromptBuilder(KIMI_PROMPT_SPEC, { model: 'm' });
    const a = b.build({ lane: 'director', match: MATCH, tail: 'x' });
    const c = b.build({ lane: 'director', match: { ...MATCH, teams: { ...MATCH.teams, B: { name: 'Green', kit: '#20a040' } } }, tail: 'x' });
    expect(a.stable.slice(0, a.info.sharedChars)).toBe(c.stable.slice(0, c.info.sharedChars));
    expect(a.stable).not.toBe(c.stable);
    expect(a.info.laneChars).toBe(c.info.laneChars); // still block aligned, same size
  });
  it('uses calibrated sizes when present and keeps the aligned length when the match block grows', () => {
    const probe = new PromptBuilder(KIMI_PROMPT_SPEC, { model: 'm' }).build({ lane: 'director', match: MATCH, tail: 'x' });
    const cal: Calibration = {
      schema: 1, blockSize: 1024, measuredAt: 't',
      models: { m: { charsPerToken: 4, imageTokens: { w768: 448, w512: 209 }, ttftMs: { cold: 1, warm: 1 }, cacheBlockTokens: 1024, prompts: {
        [KIMI_PROMPT_SPEC.version]: { sharedChars: probe.info.sharedChars + 4096, sharedTokens: 0, lanes: { director: { segChars: probe.info.laneChars + 100, tokens: 0 } } },
      } } },
    };
    const b = new PromptBuilder(KIMI_PROMPT_SPEC, { model: 'm', calibration: cal });
    const p = b.build({ lane: 'director', match: MATCH, tail: 'x' });
    expect(p.info.calibrated).toBe(true);
    expect(p.info.sharedChars).toBe(probe.info.sharedChars + 4096);
    expect(p.info.laneChars).toBe(probe.info.laneChars + 100);
    const bigger = b.build({ lane: 'director', match: { ...MATCH, extra: { note: 'x'.repeat(50) } }, tail: 'x' });
    expect(bigger.info.laneChars).toBe(probe.info.laneChars + 100);
  });
  it('filler is exact length and deterministic', () => {
    expect(fillerText(1234)).toHaveLength(1234);
    expect(fillerText(500)).toBe(fillerText(1000).slice(0, 500));
    expect(fillerText(0)).toBe('');
  });
  it('the bundled calibration puts each lane past the third 1024-token block', () => {
    // Regression: calibration measured prompt_tokens with the response_format schema, which is
    // appended after the messages and can never be cached. The lane was ~200 tokens short, so
    // Cerebras only ever cached 2048 of ~3100 tokens. This asserts the message prefix itself
    // reaches the third block.
    const b = new PromptBuilder(KIMI_PROMPT_SPEC, { model: 'moonshotai-kimi-k3.1-pro-trial', calibration: BUNDLED_CALIBRATION });
    for (const lane of ['director', 'watch']) {
      const p = b.build({ lane, match: REFERENCE_MATCH, tail: '.' });
      expect(p.info.calibrated).toBe(true);
      const tokens = p.stable.length / b.charsPerToken;
      expect(tokens).toBeGreaterThanOrEqual(3 * 1024);
    }
  });
});
