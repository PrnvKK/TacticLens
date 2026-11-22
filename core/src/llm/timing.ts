import type { KimiLane, LatencyStamp } from '../types';

export interface CallTiming {
  provider: string;
  lane: KimiLane | 'scout';
  tRequest: number;       // ms, monotonic clock
  tFirstByte: number | null;
  tFirstToken: number | null;
  tDone: number | null;
  ttftMs: number;         // tFirstToken - tRequest (total if no token arrived)
  totalMs: number;
  tokensIn: number;
  tokensOut: number;
  /** usage.prompt_tokens_details.cached_tokens (0 when not reported). */
  cachedTokens?: number;
  tokPerS: number;        // output tokens over generation time (first token -> done)
  framesSent: number;
  usageReported: boolean; // false => token counts are estimates
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}

export function toStamp(t: CallTiming): LatencyStamp {
  return {
    provider: t.provider, lane: t.lane, ttftMs: Math.round(t.ttftMs), totalMs: Math.round(t.totalMs),
    tokensIn: t.tokensIn, tokensOut: t.tokensOut, tokPerS: Math.round(t.tokPerS), framesSent: t.framesSent,
  };
}

export interface ProviderStats {
  provider: string; calls: number; ttftP50: number; ttftP95: number; totalP50: number; totalP95: number;
  tokPerSP50: number; callsPerMin: number; tokensIn: number; tokensOut: number; framesSent: number;
}

/** HUD data model: p50/p95 per provider, calls per minute (60 s span), pulse ticks. */
export class LatencyTracker {
  private all: { t: CallTiming; at: number }[] = [];
  constructor(private now: () => number = () => Date.now()) {}
  record(t: CallTiming): void { this.all.push({ t, at: this.now() }); }
  stats(provider?: string): ProviderStats[] {
    const by = new Map<string, { t: CallTiming; at: number }[]>();
    for (const r of this.all) {
      if (provider && r.t.provider !== provider) continue;
      let arr = by.get(r.t.provider);
      if (!arr) { arr = []; by.set(r.t.provider, arr); }
      arr.push(r);
    }
    const nowMs = this.now();
    return [...by.entries()].map(([p, rs]) => {
      const ttft = rs.map((r) => r.t.ttftMs);
      const tot = rs.map((r) => r.t.totalMs);
      return {
        provider: p, calls: rs.length,
        ttftP50: percentile(ttft, 50), ttftP95: percentile(ttft, 95),
        totalP50: percentile(tot, 50), totalP95: percentile(tot, 95),
        tokPerSP50: percentile(rs.map((r) => r.t.tokPerS), 50),
        callsPerMin: rs.filter((r) => nowMs - r.at <= 60_000).length,
        tokensIn: rs.reduce((a, r) => a + r.t.tokensIn, 0),
        tokensOut: rs.reduce((a, r) => a + r.t.tokensOut, 0),
        framesSent: rs.reduce((a, r) => a + r.t.framesSent, 0),
      };
    });
  }
  /** Last n calls for the pulse strip: bar height = ttft. */
  pulse(n = 60): { at: number; provider: string; ttftMs: number }[] {
    return this.all.slice(-n).map((r) => ({ at: r.at, provider: r.t.provider, ttftMs: r.t.ttftMs }));
  }
}
