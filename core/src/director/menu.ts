// Graphics menu: every tick, list the graphics whose facts are currently valid. The model may only
// choose an id from this list; the validator rejects anything else. No prompts here.
import type { EngineOutput } from '../engine';
import type { DirectorGraphicId, GraphicsMenu, MenuItem } from './types';

const liveTargets = (ids: number[], live: ReadonlySet<number>): number[] => ids.filter((id) => live.has(id));

function add(out: MenuItem[], live: ReadonlySet<number>, item: MenuItem, strict = false): void {
  const targets = liveTargets(item.targets, live);
  // Facts that are about specific players must still point at someone alive.
  if (item.targets.length > 0 && targets.length === 0) return;
  // Paired/required-target graphics (links, switch, lanes, key player) must be complete:
  // half a marking pair would draw a line to the wrong player.
  if (strict && targets.length !== item.targets.length) return;
  out.push({ ...item, targets });
}

/**
 * Build the menu from rule-computed facts. A graphic is included only when its fact is valid; the
 * data block carries the numbers the model is allowed to cite. `live` is the current track id set.
 */
export function buildMenu(out: EngineOutput, t: number, live: ReadonlySet<number>): GraphicsMenu {
  const f = out.detail.facts;
  const items: MenuItem[] = [];

  if (f.overload.valid && f.overload.team) {
    add(items, live, {
      id: 'overload',
      label: `${f.overload.attackers} v ${f.overload.defenders} overload`,
      kind: 'overload',
      targets: f.overload.targets,
      team: f.overload.team,
      fact: f.overload,
      data: { attackers: f.overload.attackers, defenders: f.overload.defenders, margin: f.overload.attackers - f.overload.defenders, heldS: Math.round(f.overload.sinceS) },
    });
  }

  for (const tm of ['A', 'B'] as const) {
    const ff = f.formation[tm];
    if (!ff.valid) continue;
    add(items, live, {
      id: tm === 'A' ? 'formation_a' : 'formation_b',
      label: ff.label ? `${tm} ${ff.label}` : `${tm} formation`,
      kind: 'line',
      targets: ff.targets,
      team: tm,
      fact: ff,
      data: { lines: ff.lines, outfielders: ff.outfielders, heldS: Math.round(ff.sinceS), shape: ff.label ?? '' },
    });
  }

  if (f.links.valid && f.links.team) {
    const pairs = f.links.pairs.filter((p) => live.has(p.attacker) && live.has(p.defender));
    if (pairs.length >= 2) {
      add(items, live, {
        id: 'marking_links',
        label: 'marking links',
        kind: 'links',
        targets: pairs.flatMap((p) => [p.attacker, p.defender]),
        team: f.links.team,
        fact: f.links,
        data: { pairs: pairs.length, heldS: Math.round(f.links.sinceS) },
      }, true);
    }
  }

  if (f.passing.valid && live.has(f.passing.carrierId)) {
    add(items, live, {
      id: 'passing_lanes',
      label: 'passing lanes',
      kind: 'lanes',
      targets: f.passing.targets,
      team: f.passing.team ?? undefined,
      fact: f.passing,
      data: { options: f.passing.options.length, carrier: f.passing.carrierId, topScore: f.passing.options[0]?.score ?? 0 },
    });
  }

  if (f.freePlayer.valid && f.freePlayer.freeId !== null) {
    add(items, live, {
      id: 'free_player',
      label: 'free player',
      kind: 'lanes',
      targets: f.freePlayer.targets,
      team: f.freePlayer.team ?? undefined,
      fact: f.freePlayer,
      data: { spaceM: f.freePlayer.spaceM, freeId: f.freePlayer.freeId, carrier: f.freePlayer.carrierId },
    }, true);
  }

  if (f.press.valid && live.has(f.press.carrierId)) {
    add(items, live, {
      id: 'press_trap',
      label: `${f.press.pressers}-man press`,
      kind: 'pressure',
      targets: f.press.targets,
      team: f.press.team ?? undefined,
      fact: f.press,
      data: { pressers: f.press.pressers, carrier: f.press.carrierId, heldS: Math.round(f.press.sinceS) },
    });
  }

  const cands = f.keyPlayer.candidates.filter((c) => live.has(c.id));
  const carrier = f.keyPlayer.carrierId !== null ? cands.find((c) => c.id === f.keyPlayer.carrierId) : undefined;
  // Key-player graphics only mean something while that player is on the ball. The carrier is the lead,
  // and the item stays in the menu as long as they are live (no all-of-top-3 requirement).
  if (f.keyPlayer.valid && carrier) {
    const ordered = [carrier, ...cands.filter((c) => c.id !== carrier.id)];
    const ranked = ordered.slice(0, 3).map((c) => `${c.id}:${c.score}`).join(',');
    const targets = ordered.slice(0, 3).map((c) => c.id);
    add(items, live, {
      id: 'spotlight',
      label: 'spotlight',
      kind: 'spotlight',
      targets,
      team: carrier.team,
      fact: f.keyPlayer,
      data: { score: carrier.score, touches: carrier.touches, carries: carrier.carries, received: carrier.received, ranked, carrier: carrier.id },
    });
    add(items, live, {
      id: 'key_player',
      label: 'key player',
      kind: 'tag',
      targets: [carrier.id],
      team: carrier.team,
      fact: f.keyPlayer,
      data: { score: carrier.score, touches: carrier.touches, carries: carrier.carries, received: carrier.received, ranked, carrier: carrier.id },
    });
  }

  if (f.swing.valid && f.swing.team) {
    add(items, live, {
      id: 'possession_swing',
      label: `${f.swing.team} possession swing`,
      kind: 'hull',
      targets: [],
      team: f.swing.team,
      fact: f.swing,
      data: { deltaPct: f.swing.deltaPct, windowS: f.swing.windowS },
    });
  }

  if (f.switchArc.valid) {
    add(items, live, {
      id: 'switch_arc',
      label: 'switch of play',
      kind: 'switch',
      targets: f.switchArc.targets,
      team: f.switchArc.team ?? undefined,
      fact: f.switchArc,
      data: { carrier: f.switchArc.carrierId, target: f.switchArc.targetId ?? -1 },
    }, true);
  }

  if (f.counter.valid) {
    add(items, live, {
      id: 'counter_run',
      label: 'counter run',
      kind: 'run',
      targets: f.counter.targets,
      team: f.counter.team ?? undefined,
      fact: f.counter,
      data: { runner: f.counter.runnerId ?? -1 },
    }, true);
  }

  if (f.pocket.valid) {
    add(items, live, {
      id: 'space_pocket',
      label: 'space between the lines',
      kind: 'pocket',
      targets: f.pocket.targets,
      fact: f.pocket,
      data: { gapM: f.pocket.gapM },
    }, true);
  }

  return { t, items };
}

/** Ids only, for the schema/test surface. */
export function menuIds(menu: GraphicsMenu): DirectorGraphicId[] {
  return menu.items.map((i) => i.id);
}
