// The live Cerebras-vs-GPU race. The request is built once and handed to core's race harness in the
// background (keys never reach the page); this file only maps the two real streams into RaceStore
// using receipt-time stamps. The port is injected so the mapping is testable without a browser.
import { gpuBaselineStatus, type LLMEvent, type LLMRequest, type PresetId, type RaceResult } from '@tacticlens/core';
import { kimiModelId } from '../llm/model';
import { localizeEvent, receiptTime, toLocalClock, type RecvStamp } from './receipt';
import type { RaceSide, RaceStore } from './store';

export const RACE_A: PresetId = 'cerebras-kimi';
export const RACE_B: PresetId = 'gpu-baseline';

/** One identical prompt for both providers. Kept short so the race finishes inside a demo beat. */
export const RACE_PROMPT =
  'Live match, 1-1, 67th minute. The opposition left-back has stepped into midfield to press, and the space ' +
  'behind him is open. Explain in under 80 words the two best ways to attack that space, with the runs and ' +
  'the pass each needs. Be concrete and do not repeat the question.';

export function raceRequest(): LLMRequest {
  return { lane: 'ask', messages: [{ role: 'user', content: RACE_PROMPT }], maxCompletionTokens: 420, reasoningEffort: 'low' };
}

export interface RaceSideInfo {
  preset: PresetId;
  /** Provider name from the preset, e.g. OPENROUTER. Configured in core, not here. */
  label: string;
  sub: string;
  configured: boolean;
  /** Core's honest reason when this side cannot run. */
  reason: string | null;
}
export interface RacePrep {
  a: RaceSideInfo;
  b: RaceSideInfo;
  ready: boolean;
  /** 'GPU baseline not configured' when the second preset has no key or no pinned host. */
  note: string | null;
}

export type PresetKeys = Partial<Record<PresetId, boolean>>;

/**
 * Both sides are checked without inventing anything: the Cerebras side needs a saved key and the
 * configured Kimi model id; the GPU side uses core's own preset status (pinned host + key + model).
 */
export function racePrep(keys: PresetKeys, kimiModel?: string): RacePrep {
  const model = kimiModelId(kimiModel);
  const hasCerebrasKey = !!keys[RACE_A];
  const gpu = gpuBaselineStatus(keys[RACE_B] ? 'saved' : '');
  const a: RaceSideInfo = {
    preset: RACE_A, label: 'CEREBRAS KIMI', sub: model || 'no model id',
    configured: hasCerebrasKey && !!model,
    reason: !hasCerebrasKey ? 'Set the Cerebras key in the extension popup' : !model ? 'Set CEREBRAS_KIMI_MODEL (popup or build env)' : null,
  };
  const b: RaceSideInfo = {
    preset: RACE_B,
    // The provider name comes from the preset/core config, so a rename there renames the lane here.
    label: gpu.provider ? gpu.provider.toUpperCase() : 'GPU BASELINE',
    sub: gpu.model,
    configured: gpu.configured,
    reason: gpu.reason ?? null,
  };
  const note = !a.configured ? 'Cerebras key not configured' : !b.configured ? 'GPU baseline not configured' : null;
  return { a, b, ready: note === null, note };
}

export interface RacePort {
  start(
    a: PresetId, b: PresetId, request: LLMRequest,
    onEvent: (side: 'a' | 'b', e: LLMEvent, stamp?: RecvStamp) => void,
  ): { done: Promise<RaceResult>; cancel(): void };
}

export interface RaceDriverOptions {
  /** Page clock origin (performance.timeOrigin); injected in tests. */
  localOrigin?: number;
  onError?: (message: string | null) => void;
  onDone?: (result: RaceResult) => void;
  /** Always fires once the harness settles (success or transport failure), for button state. */
  onSettled?: () => void;
}
export interface RaceHandle { cancel(): void }

/**
 * Drive a RaceStore from a real race. The stopwatch starts at the request stamp (not at the click),
 * every delta is placed with its network-receipt time, and usage.completion_tokens replaces the
 * delta count on completion.
 */
export function driveRace(race: RaceStore, port: RacePort, prep: RacePrep, opts: RaceDriverOptions = {}): RaceHandle {
  const localOrigin = opts.localOrigin ?? (typeof performance !== 'undefined' ? performance.timeOrigin : Date.now());
  let began = false;
  let cancelled = false;
  const beginAt = (t: number): void => {
    if (began) return;
    began = true;
    race.begin(t);
  };
  const fail = (side: RaceSide, msg: string, at: number): void => {
    opts.onError?.(msg.slice(0, 160));
    race.fail(side, msg.slice(0, 160), at);
  };

  const handle = port.start(RACE_A, RACE_B, raceRequest(), (side, e, stamp) => {
    if (cancelled) return;
    const local = (t: number): number => (stamp ? toLocalClock(t, stamp, localOrigin) : t);
    const at = stamp ? receiptTime(stamp, localOrigin) : (typeof performance !== 'undefined' ? performance.now() : 0);
    const ev = stamp ? localizeEvent(e, stamp, localOrigin) : e;
    switch (ev.type) {
      case 'start':
        beginAt(ev.tRequest);
        break;
      case 'first_token':
        beginAt(ev.tFirstToken - ev.ttftMs);
        break;
      case 'delta':
      case 'reasoning':
        // Reasoning is an output token for the TPS window and usage, but it is not shown in the race text.
        beginAt(at);
        race.delta(side, ev.type === 'delta' ? ev.text ?? '' : '', 1, at);
        break;
      case 'done': {
        const t = ev.result.timing;   // localizeEvent already moved these onto the page clock
        beginAt(t.tRequest);
        if (t.usageReported) race.usage(side, t.tokensOut);
        if (ev.result.ok) race.end(side, t.tDone ?? at);
        else fail(side, ev.result.error ?? `HTTP ${ev.result.status}`, t.tDone ?? at);
        break;
      }
      case 'error':
        fail(side, ev.error || 'call failed', at);
        break;
      default:
        break;
    }
  });

  void handle.done.then((r) => {
    if (cancelled) return;
    opts.onDone?.(r);
    opts.onSettled?.();
  }, (e: unknown) => {
    if (cancelled) return;
    opts.onError?.(String((e as Error)?.message ?? e).slice(0, 160));
    opts.onSettled?.();
  });

  return {
    cancel(): void {
      cancelled = true;
      handle.cancel();
    },
  };
}

/** Labels from the prep, ready for RaceStore.setLabels. */
export function raceLabels(prep: RacePrep): { a: [string, string]; b: [string, string] } {
  return { a: [prep.a.label, prep.a.sub], b: [prep.b.label, prep.b.sub] };
}
