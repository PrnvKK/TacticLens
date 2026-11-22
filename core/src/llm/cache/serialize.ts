// Deterministic serialisation for prompt text: sorted keys, fixed decimal rounding, no undefined.
// The same input always yields the same string, so the cached prefix never drifts.

export function roundTo(v: number, decimals: number): number {
  if (!Number.isFinite(v)) return 0;
  const k = 10 ** decimals;
  const r = Math.round(v * k) / k;
  return Object.is(r, -0) ? 0 : r;
}

/** Compact JSON with sorted keys; numbers are rounded to `decimals` (default 2); undefined fields are dropped. */
export function stableStringify(value: unknown, decimals = 2): string {
  const walk = (v: unknown): string | undefined => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'number': return String(roundTo(v, decimals));
      case 'boolean': return v ? 'true' : 'false';
      case 'string': return JSON.stringify(v);
      case 'undefined': case 'function': case 'symbol': return undefined;
      default: break;
    }
    if (Array.isArray(v)) return `[${v.map((x) => walk(x) ?? 'null').join(',')}]`;
    const o = v as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(o).sort()) {
      const s = walk(o[k]);
      if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`);
    }
    return `{${parts.join(',')}}`;
  };
  return walk(value) ?? 'null';
}

/** FNV-1a 32-bit hash as 8 hex chars: version keys and prefix fingerprints. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** Quantise a #rrggbb colour to 4 bits per channel so tiny measurement noise never rewrites the match block. */
export function quantHex(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const q = (c: number): string => (Math.min(15, Math.round(c / 17)) * 17).toString(16).padStart(2, '0');
  return `#${q((n >> 16) & 255)}${q((n >> 8) & 255)}${q(n & 255)}`;
}
