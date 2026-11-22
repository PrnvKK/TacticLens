// Director contract checks at the trust boundary. The model may choose a subset of a fact's targets,
// but the anchor (carrier) must stay first and paired graphics must stay paired.
import type { MenuItem } from './types';

/** Returns a rejection reason when the chosen targets would draw a different graphic than the fact. */
export function anchorError(item: MenuItem, picked: number[]): string | undefined {
  const first = item.targets[0];
  switch (item.id) {
    case 'press_trap':
      return picked[0] === first ? undefined : `anchor: ${item.id} must start with the carrier ${first}`;
    case 'passing_lanes':
    case 'free_player':
      if (picked.length < 2) return `anchor: ${item.id} needs a carrier and a target`;
      return picked[0] === first ? undefined : `anchor: ${item.id} must start with the carrier ${first}`;
    case 'switch_arc':
      return picked.length >= 2 && picked[0] === item.targets[0] && picked[1] === item.targets[1]
        ? undefined
        : `anchor: switch_arc needs [${item.targets.slice(0, 2).join(',')}]`;
    case 'space_pocket':
      return picked.length >= 2 ? undefined : 'anchor: space_pocket needs both sides';
    case 'marking_links': {
      const pairs = (item.fact as { pairs?: { attacker: number; defender: number }[] }).pairs ?? [];
      if (picked.length % 2 !== 0) return 'anchor: marking_links must be attacker/defender pairs';
      for (let i = 0; i < picked.length; i += 2) {
        if (!pairs.some((p) => p.attacker === picked[i] && p.defender === picked[i + 1])) {
          return `anchor: [${picked[i]},${picked[i + 1]}] is not a marking pair`;
        }
      }
      return undefined;
    }
    case 'counter_run':
      return picked.length >= 1 ? undefined : 'anchor: counter_run needs a runner';
    case 'key_player':
      return picked[0] === first ? undefined : `anchor: key_player must be the carrier ${first}`;
    case 'spotlight':
      return picked.includes(first!) ? undefined : `anchor: spotlight must include the carrier ${first}`;
    case 'overload':
      return picked.length >= 2 ? undefined : 'anchor: overload needs a cluster';
    default:
      return undefined;
  }
}
