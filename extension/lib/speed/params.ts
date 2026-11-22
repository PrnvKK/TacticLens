// URL switches for the speed demo. Pure so the parsing/priority rules can be tested without a DOM.
//
//   ?speed=wall|race|burst   explicit view (?speed=... alone means the compact wall)
//   ?mock=1                  offline data source (unchanged)
//   ?autorace=1              start the live race as soon as both presets are ready
//   ?peak=NNNN               a real peak copied from an earlier run (never invented)
//   ?record=1                hide the dev toolbar + cursor for a clean capture
//
// The old ?mock=1&mode=race|burst|wall form still works when ?speed is absent.

export type SpeedView = 'compact' | 'wall' | 'race' | 'burst';

export interface SpeedParams {
  mock: boolean;
  view: SpeedView;
  seed: number;
  record: boolean;
  autorace: boolean;
  /** A real, previously measured peak supplied on the URL. */
  peak: number | null;
}

function view(v: string | null): SpeedView | null {
  const s = (v ?? '').trim().toLowerCase();
  return s === 'compact' || s === 'wall' || s === 'race' || s === 'burst' ? s : null;
}

function positive(n: string | null): number | null {
  const v = Number(n);
  return n != null && n !== '' && Number.isFinite(v) && v > 0 ? v : null;
}

export function speedParams(search: string): SpeedParams {
  const q = new URLSearchParams(search);
  const explicit = view(q.get('speed'));
  const legacy = view(q.get('mode'));
  return {
    mock: q.get('mock') === '1',
    // ?speed=<unknown> still means "the demo is on", so use the safe compact view rather than full screen.
    view: explicit ?? legacy ?? 'compact',
    seed: Number(q.get('seed')) || 7,
    record: q.get('record') === '1',
    autorace: q.get('autorace') === '1',
    peak: positive(q.get('peak')),
  };
}

/**
 * The burst must land on a real number: a real measured session peak, or a real value carried in
 * on the URL. It returns null (and the caller keeps waiting) when neither exists yet; it never
 * substitutes a decorative number.
 */
export function resolveBurstTarget(provided: number | null, sessionPeak: number): number | null {
  if (provided != null && Number.isFinite(provided) && provided > 0) return provided;
  return Number.isFinite(sessionPeak) && sessionPeak > 0 ? sessionPeak : null;
}
