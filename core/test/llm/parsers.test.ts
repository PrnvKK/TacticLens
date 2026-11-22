import { describe, expect, it } from 'vitest';
import { SseParser } from '../../src/llm/sse';
import { StreamingField, extractStringField, parsePartialJson } from '../../src/llm/partialJson';

describe('SseParser', () => {
  it('parses events split at arbitrary chunk boundaries', () => {
    const raw = 'data: {"a":1}\n\n: keepalive\ndata: {"b":\ndata: 2}\n\nevent: x\ndata: [DONE]\n\n';
    for (let size = 1; size <= raw.length; size += 3) {
      const p = new SseParser();
      const out = [];
      for (let i = 0; i < raw.length; i += size) out.push(...p.push(raw.slice(i, i + size)));
      out.push(...p.end());
      expect(out.map((e) => e.data)).toEqual(['{"a":1}', '{"b":\n2}', '[DONE]']);
      expect(out[2].event).toBe('x');
    }
  });
  it('handles CRLF and flushes an unterminated final event', () => {
    const p = new SseParser();
    expect(p.push('data: one\r\n\r\ndata: two')).toEqual([{ event: 'message', data: 'one' }]);
    expect(p.end()).toEqual([{ event: 'message', data: 'two' }]);
  });
});

describe('partial JSON', () => {
  const full = JSON.stringify({ say: 'He said "go" é now', phase: 'press', focus: [7, 12], gfx: [{ type: 'lanes', ids: [7] }], confidence: 0.8 });
  it('streams the say field, including escapes, as it grows', () => {
    const f = new StreamingField('say');
    const seen: string[] = [];
    for (let i = 0; i < full.length; i += 2) {
      const v = f.push(full.slice(i, i + 2));
      if (v !== null) seen.push(v);
    }
    expect(seen.length).toBeGreaterThan(3);
    expect(seen[seen.length - 1]).toBe('He said "go" é now');
    expect(f.complete).toBe(true);
    for (let i = 1; i < seen.length; i++) expect(seen[i].startsWith(seen[i - 1])).toBe(true);
  });
  it('does not emit a half escape', () => {
    expect(extractStringField('{"say":"a\\', 'say')).toEqual({ value: 'a', complete: false });
    expect(extractStringField('{"say":"a\\u00', 'say')).toEqual({ value: 'a', complete: false });
    expect(extractStringField('{"x":1}', 'say')).toBeNull();
  });
  it('recovers a parse at every prefix once the structure has started', () => {
    let ok = 0;
    for (let i = 1; i <= full.length; i++) {
      const v = parsePartialJson(full.slice(0, i));
      if (v !== undefined) ok++;
    }
    expect(ok).toBeGreaterThan(full.length * 0.8);
    expect(parsePartialJson(full)).toEqual(JSON.parse(full));
    expect(parsePartialJson('{"say":"hi","focus":[7,')).toEqual({ say: 'hi', focus: [7] });
    expect(parsePartialJson('{"say":"hi","phase"')).toEqual({ say: 'hi' });
  });
});
