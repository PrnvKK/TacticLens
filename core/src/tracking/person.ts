import type { Team } from '../types';

export type PersonCls = 'player' | 'goalkeeper' | 'referee';

/**
 * A person detection, normalised video coordinates.
 * Optional `team` and `hist` are the appearance inputs for the v2 tracker: `team` is the team the detector or
 * the team assigner already knows, `hist` a normalised torso+shorts colour histogram (any bin count, same bins
 * for every detection). Both are optional; without them the tracker falls back to motion/geometry only.
 */
export interface PersonDet {
  cls: PersonCls;
  score: number;
  box: [number, number, number, number];
  team?: Team;
  hist?: number[];
}
