// Streaming-JSON helpers: pull a string field out of partial JSON, and best-effort parse of partial JSON.

/** Extract the (possibly incomplete) string value of a key, e.g. "say". */
export function extractStringField(text: string, key: string): { value: string; complete: boolean } | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  let out = '';
  const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') return { value: out, complete: true };
    if (ch === '\\') {
      if (i + 1 >= text.length) break; // incomplete escape
      const n = text[i + 1]!;
      if (n === 'u') {
        if (i + 6 > text.length) break;
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += map[n] ?? n;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return { value: out, complete: false };
}

/** Tracks growth of one string field across deltas; returns the new full value only when it changed. */
export class StreamingField {
  private buf = '';
  private last = '';
  complete = false;
  constructor(private key = 'say') {}
  push(delta: string): string | null {
    this.buf += delta;
    const r = extractStringField(this.buf, this.key);
    if (!r) return null;
    this.complete = r.complete;
    if (r.value === this.last) return null;
    this.last = r.value;
    return r.value;
  }
  get value(): string { return this.last; }
}

/** Best-effort parse of truncated JSON. Returns undefined if nothing sensible can be recovered. */
export function parsePartialJson(text: string): unknown {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  // Safe cut points: just before a ',' or just after an opening bracket, with the stack at that moment.
  let safe: { pos: number; stack: string[] } | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
      safe = { pos: i + 1, stack: stack.slice() };
    } else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',') safe = { pos: i, stack: stack.slice() };
  }
  let t = text;
  if (inStr) {
    if (esc) t = t.slice(0, -1);
    t = t.replace(/\\u[0-9a-fA-F]{0,3}$/, '');
    t += '"';
  }
  const close = stack.slice().reverse().join('');
  const attempts = [
    t + close,
    t.replace(/,\s*$/, '') + close,
    t.replace(/:\s*$/, ':null') + close,
    t.replace(/,?\s*"[^"]*"\s*$/, '') + close,
  ];
  if (safe) attempts.push(text.slice(0, safe.pos) + safe.stack.slice().reverse().join(''));
  for (const a of attempts) {
    try { return JSON.parse(a); } catch { /* next */ }
  }
  return undefined;
}
