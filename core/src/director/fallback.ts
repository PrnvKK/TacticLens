// Rules-side safety net for the live demo. Kimi is still the director; this only steps in when the
// screen has been empty for too long and the menu already contains a valid, live graphic. It never
// invents a fact and never bypasses the menu: it is the same data Kimi sees, picked by priority.
import type { DirectorGraphicId, GraphicsMenu, MenuItem } from './types';

/**
 * Most useful first. Key player / spotlight are cheap, neat and explain the player on the ball;
 * passing lanes and pressure explain the current decision; shape graphics are the fallback.
 */
export const FALLBACK_PRIORITY: DirectorGraphicId[] = [
  'key_player', 'passing_lanes', 'spotlight', 'press_trap', 'overload', 'free_player',
  'formation_a', 'formation_b', 'marking_links', 'switch_arc', 'counter_run', 'space_pocket', 'possession_swing',
];

export interface FallbackOptions {
  /** Wall-clock seconds, the same clock used for `lastShown`. */
  nowS: number;
  /** Do not repeat a graphic shown within this many seconds. */
  repeatS?: number;
  /** Graphic id -> wall seconds when it was last shown (Kimi, rules or the bridge). */
  lastShown?: ReadonlyMap<string, number>;
  /** The previous fallback, skipped when another valid option exists so the demo does not loop one tag. */
  avoid?: DirectorGraphicId | null;
}

const available = (menu: GraphicsMenu): Map<DirectorGraphicId, MenuItem> =>
  new Map(menu.items.map((i) => [i.id, i] as const));

/** Pick a valid menu item, or null when the menu is empty. Never mutates the menu. */
export function pickFallback(menu: GraphicsMenu, o: FallbackOptions): MenuItem | null {
  const items = available(menu);
  if (!items.size) return null;
  const repeatS = o.repeatS ?? 9;
  const recently = (id: DirectorGraphicId): boolean => {
    const at = o.lastShown?.get(id);
    return at !== undefined && o.nowS - at < repeatS;
  };
  // First choice: priority order, not the previous fallback, not recently shown.
  for (const id of FALLBACK_PRIORITY) {
    if (id === o.avoid) continue;
    const item = items.get(id);
    if (item && !recently(id)) return item;
  }
  // Everything good was just on screen: allow the previous fallback rather than going silent.
  for (const id of FALLBACK_PRIORITY) {
    const item = items.get(id);
    if (item && !recently(id)) return item;
  }
  // Last resort: any valid item, even if it repeats. A quiet broadcast is the only wrong answer.
  for (const id of FALLBACK_PRIORITY) {
    const item = items.get(id);
    if (item) return item;
  }
  return null;
}
