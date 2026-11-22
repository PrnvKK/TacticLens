// The client authorises. Kimi requests a graphic; this validator rejects anything that is not a live,
// valid, fresh menu item and clamps the rest. Every rejection carries a reason for the ?perf=1 log.
import { GRAPHIC_IDS, type DirectorDecision, type DirectorGraphicChoice, type GraphicsMenu, type OnScreenGraphic } from './types';
import { anchorError } from './anchors';

const ACTIONS = new Set(['show', 'hide', 'keep', 'none']);
const CHOICES = new Set<string>(['none', ...GRAPHIC_IDS]);

export interface ValidateOptions {
  decision: unknown;
  menu: GraphicsMenu;
  liveIds: ReadonlySet<number>;
  /** Seconds between the snapshot the decision saw and its arrival (video seconds, 2x playback counts double). */
  ageS: number;
  nowS: number;
  onScreen: OnScreenGraphic | null;
  calm: { ready: boolean; reason: string };
  /** Graphic id -> wall seconds of its last accepted show. */
  lastShown: ReadonlyMap<string, number>;
  staleS?: number;
  repeatS?: number;
  minDurationS?: number;
  maxDurationS?: number;
}

export interface ValidateResult {
  ok: boolean;
  decision?: DirectorDecision;
  reason?: string;
}

const words = (s: string, max: number): string => s.trim().split(/\s+/).filter(Boolean).slice(0, max).join(' ');
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Short intent label: plain text, no digits, at most 18 characters. */
export function labelFromCaption(caption: string, fallback: string): string {
  const clean = caption.replace(/\[\[\d+\]\]/g, '').replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
  const fb = fallback.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
  return (clean || fb || 'graphic').slice(0, 18).trim();
}

/** Caption and say are prose; drops control characters and bounds the length before the word limit. */
export function cleanText(v: unknown, maxChars: number, maxWords: number): string {
  if (typeof v !== 'string') return '';
  return words(v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maxChars), maxWords);
}

export function validateDecision(o: ValidateOptions): ValidateResult {
  const staleS = o.staleS ?? 3;
  const repeatS = o.repeatS ?? 9;
  const minD = o.minDurationS ?? 3;
  const maxD = o.maxDurationS ?? 10;
  const d = o.decision as Partial<DirectorDecision> | null | undefined;
  if (!d || typeof d !== 'object') return { ok: false, reason: 'schema: not an object' };
  if (typeof d.action !== 'string' || !ACTIONS.has(d.action)) return { ok: false, reason: `schema: action ${String(d.action)}` };
  const action = d.action as DirectorDecision['action'];
  if (typeof d.graphic !== 'string' || !CHOICES.has(d.graphic)) return { ok: false, reason: `schema: graphic ${String(d.graphic)}` };
  let graphic = d.graphic as DirectorGraphicChoice;
  if (!Array.isArray(d.targets) || d.targets.some((t) => !Number.isInteger(t))) return { ok: false, reason: 'schema: targets' };
  if (typeof d.duration_s !== 'number' || !Number.isFinite(d.duration_s)) return { ok: false, reason: 'schema: duration_s' };
  if (typeof d.confidence !== 'number' || !Number.isFinite(d.confidence)) return { ok: false, reason: 'schema: confidence' };
  const caption = cleanText(d.caption, 160, 10);
  const say = cleanText(d.say, 360, 20);
  const duration = clamp(d.duration_s, minD, maxD);
  const confidence = clamp(d.confidence, 0, 1);
  const targets = [...new Set((d.targets as number[]).filter((t) => Number.isInteger(t)))];
  const burst = { targets, caption, say, duration_s: duration, confidence };

  // A decision is about a moment. If the moment has clearly passed, drop it for every action, not only
  // for show: an old hide/keep/none is just as out of date as an old show.
  if (o.ageS > staleS) return { ok: false, reason: `stale: ${o.ageS.toFixed(1)} s > ${staleS} s` };

  if (action === 'none') {
    return { ok: true, decision: { action, graphic: 'none', ...burst } };
  }

  if (action === 'hide') {
    if (!o.onScreen) return { ok: false, reason: 'hide: nothing on screen' };
    if (graphic !== 'none' && graphic !== o.onScreen.id) return { ok: false, reason: `hide: ${graphic} is not on screen (${o.onScreen.id})` };
    return { ok: true, decision: { action, graphic: o.onScreen.id, ...burst } };
  }

  if (action === 'keep') {
    if (!o.onScreen) return { ok: false, reason: 'keep: nothing on screen' };
    if (graphic !== 'none' && graphic !== o.onScreen.id) return { ok: false, reason: `keep: ${graphic} is not on screen (${o.onScreen.id})` };
    return { ok: true, decision: { action, graphic: o.onScreen.id, ...burst } };
  }

  // show
  if (graphic === 'none') return { ok: false, reason: 'show: graphic none' };
  const item = o.menu.items.find((i) => i.id === graphic);
  if (!item) return { ok: false, reason: `show: ${graphic} not in menu` };
  if (!item.fact.valid) return { ok: false, reason: `fact: ${graphic} is no longer valid` };
  if (o.onScreen) return { ok: false, reason: `show: ${o.onScreen.id} already on screen` };
  // tag (key player) and spotlight are deliberately light: they may enter on busy play.
  const light = item.kind === 'tag' || item.kind === 'spotlight';
  if (!o.calm.ready && !light) return { ok: false, reason: `calm: ${o.calm.reason || 'busy'}` };
  const last = o.lastShown.get(graphic);
  if (last !== undefined && o.nowS - last < repeatS) return { ok: false, reason: `repeat: ${graphic} ${(o.nowS - last).toFixed(0)} s ago < ${repeatS} s` };

  const picked = targets.length ? targets : item.targets.slice();
  if (picked.some((id) => !o.liveIds.has(id))) return { ok: false, reason: `target: not live [${picked.filter((id) => !o.liveIds.has(id)).join(',')}]` };
  if (item.targets.length && picked.some((id) => !item.targets.includes(id))) {
    return { ok: false, reason: `target: not in ${graphic} fact` };
  }
  if (!picked.length && item.targets.length) return { ok: false, reason: `target: ${graphic} needs a fact target` };
  const anchor = anchorError(item, picked);
  if (anchor) return { ok: false, reason: anchor };

  return { ok: true, decision: { action, graphic, ...burst, targets: picked } };
}
