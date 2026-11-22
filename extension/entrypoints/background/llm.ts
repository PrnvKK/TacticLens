// Background LLM host: owns API keys and all provider fetches. Pages talk to it over a runtime port.
import { browser } from 'wxt/browser';
import {
  BUNDLED_CALIBRATION, Governor, KIMI_PROMPT_SPEC, LaneRunner, PromptBuilder, REFERENCE_MATCH,
  race, warmUp, type LLMEvent, type PresetId,
} from '@tacticlens/core';
import { LLM_PORT, type FromBg, type ToBg } from '../../lib/llm/protocol';
import { getKey, getSettings } from '../../lib/llm/storage';
import { providerFor } from '../../lib/llm/model';

const PRESET_IDS: PresetId[] = ['cerebras-kimi', 'gpu-baseline', 'mock'];

export function registerLlmHost(): void {
  const runner = new LaneRunner(new Governor());
  const cancels = new Map<string, () => void>();
  // Same clock for the whole worker; the page converts with the difference of the two timeOrigins.
  const tOrigin = typeof performance !== 'undefined' ? performance.timeOrigin : 0;

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== LLM_PORT) return;
    const send = (m: FromBg) => { try { port.postMessage(m); } catch { /* page went away */ } };
    /** Stamp at the network-read point (streamChat's emit is synchronous with the SSE decode). */
    const sendEvent = (id: string, event: LLMEvent, side?: 'a' | 'b'): void => {
      const tRecv = typeof performance !== 'undefined' ? performance.now() : 0;
      send({ id, kind: 'event', side, event, tRecv, tOrigin });
    };
    const own = new Set<string>();
    port.onDisconnect.addListener(() => { for (const id of own) cancels.get(id)?.(); });

    port.onMessage.addListener(async (m: ToBg) => {
      try {
        if (m.type === 'cancel') { cancels.get(m.id)?.(); return; }
        if (m.type === 'stats') { send({ id: m.id, kind: 'stats', stats: runner.tracker.stats(), pulse: runner.tracker.pulse() }); return; }
        if (m.type === 'keys') {
          const keys: Partial<Record<PresetId, boolean>> = {};
          for (const p of PRESET_IDS) keys[p] = p === 'mock' ? true : (await getKey(p)).length > 0;
          send({ id: m.id, kind: 'keys', keys });
          return;
        }
        const settings = await getSettings();
        if (m.type === 'warmup') {
          const provider = providerFor(m.preset, await getKey(m.preset), settings.kimiModel);
          // Prime the exact stable prefix the director will send, not just the TCP connection. The
          // old 'ping' warm-up opened TLS but left the first real call to pay the full ~3k-token
          // prefill, which is the expensive cold start the demo cannot afford.
          const builder = new PromptBuilder(KIMI_PROMPT_SPEC, { model: provider.model, calibration: BUNDLED_CALIBRATION });
          const warm = builder.build({ lane: 'director', match: REFERENCE_MATCH, tail: '.' });
          send({ id: m.id, kind: 'warmup', ms: await warmUp(provider, undefined, warm.stable) });
          return;
        }
        if (m.type === 'call') {
          own.add(m.id);
          const provider = providerFor(m.preset, await getKey(m.preset), settings.kimiModel);
          // Per-lane cancel-and-replace is done by the governor; this handle cancels on explicit request.
          cancels.set(m.id, m.policy === 'parallel' ? () => runner.cancelCall(m.id) : () => runner.governor.cancel(m.request.lane));
          const outcome = await runner.run(provider, m.request, { policy: m.policy, callId: m.id, mockProfile: m.mockProfile ?? settings.mockProfile, onEvent: (e: LLMEvent) => sendEvent(m.id, e) });
          cancels.delete(m.id); own.delete(m.id);
          send({ id: m.id, kind: 'outcome', outcome });
          return;
        }
        if (m.type === 'race') {
          own.add(m.id);
          const ac = new AbortController();
          cancels.set(m.id, () => ac.abort());
          const res = await race(
            { provider: providerFor(m.a, await getKey(m.a), settings.kimiModel), mockProfile: m.mockA ?? 'cerebras' },
            { provider: providerFor(m.b, await getKey(m.b), settings.kimiModel), mockProfile: m.mockB ?? 'gpu' },
            m.request,
            { signal: ac.signal, onEvent: (side, e) => sendEvent(m.id, e, side) },
          );
          cancels.delete(m.id); own.delete(m.id);
          send({ id: m.id, kind: 'race', result: res });
        }
      } catch (err) {
        send({ id: m.id, kind: 'error', error: String((err as Error)?.message ?? err) });
      }
    });
  });
}
