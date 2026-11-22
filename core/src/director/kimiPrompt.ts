// The block-aligned Kimi prompt: one shared layer for every lane, then a lane layer per lane.
// Director lane = decisions from compact state. Watch lane = one annotated frame per second.
import { createPromptSpec, type MatchBlock, type PromptSpec } from '../llm/cache/spec';
import { KIMI_GLOSSARY, KIMI_PERSONA, fewShotText, schemasText } from '../llm/cache/shared';
import { DIRECTOR_SCHEMA, DIRECTOR_SCHEMA_NAME } from './prompts';

export const WATCH_SCHEMA_NAME = 'watch_observation';
export const WATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['phase', 'shape', 'hot', 'ball_side', 'pressure'],
  properties: {
    phase: { type: 'string', enum: ['build_up', 'press', 'transition', 'settled', 'set_piece', 'none'] },
    shape: { type: 'string' },
    hot: { type: 'array', items: { type: 'integer' } },
    ball_side: { type: 'string', enum: ['left', 'centre', 'right', 'none'] },
    pressure: { type: 'string', enum: ['none', 'low', 'high'] },
  },
} as const;

export interface WatchObservation {
  phase: 'build_up' | 'press' | 'transition' | 'settled' | 'set_piece' | 'none';
  shape: string;
  hot: number[];
  ball_side: 'left' | 'centre' | 'right' | 'none';
  pressure: 'none' | 'low' | 'high';
}

// Completion caps only (not part of the cached prompt prefix). Sized to the schemas: a director decision with
// a full say line is about 130 tokens; a watch observation is about 70.
export const DIRECTOR_MAX_TOKENS_FAST = 280;
export const WATCH_MAX_TOKENS = 220;

const DIRECTOR_LANE = `LANE director (text only, many calls per second, each one stateless)
Input: the live message, a compact JSON object: clock, t (video seconds), scene, ball {state,x,y}, possession, live (ids you may target), events (rule events of the last few seconds), trail (ball x,y in percent over the last ~5 s, oldest first), menu (valid graphics with their facts), screen (what is on screen now, null if nothing), sinceLastGraphicS, calm, recent (your last accepted decisions: ago seconds, a action, g graphic), seen (what the latest annotated frame showed).
Output schema: director_decision.
- Choose only an id from menu. Never invent a graphic, a player, a number or a fact.
- One graphic at a time: while screen is not null you may only keep, hide or none.
- Keep the broadcast alive. If screen is null and menu is non-empty, show the simplest useful graphic. Aim for a new graphic every 6-10 seconds of live play; do not stay silent for more than about 10 seconds while the menu has an item.
- Prefer key_player (a neat tag on the player who has the ball) or spotlight (a clean ring on the same player) for small, frequent moments. Use passing_lanes when the next pass is the story, press_trap when the carrier is trapped, overload only with a clear two-player edge, and shape/momentum graphics when the picture is calm.
- key_player and spotlight menu items list the carrier first; keep that id first in targets.
- Check recent: do not repeat the same graphic within about 8 seconds, and do not flip between show and hide.
- If the play has moved on, hide what is on screen. If it still explains the play, keep it. When the ball changes hands, the old carrier's graphic is finished: hide it.
- If calm.state is busy, key_player and spotlight are still allowed; heavier graphics should wait or choose none.
- duration_s is 3 to 10; use 4 to 6 normally, 4 to 5 for key_player/spotlight. caption at most 10 words, say at most 20 words, either may be empty.
- targets must be live ids that belong to the chosen menu item.
- Numbers only if they appear in menu facts, poss, c or ev.
- action: show puts menu graphic on screen; hide removes it; keep leaves it and extends it; none changes nothing.`;

const WATCH_LANE = `LANE watch (one annotated frame per second)
Input: one JPEG frame with a ring and a tracker id above each player (ring colour = team) and the ball circled in yellow, then a tiny live message with t and the live ids.
Output schema: watch_observation.
- phase: what the play is, one of the enum values.
- shape: at most 14 words on what the frame shows, plain words, no digits (for example "back four compact, right winger isolated").
- hot: up to 4 ids from the live message that matter right now (carrier, free man, pressers). Never an id that is not in live.
- ball_side: which third of the picture the ball is in, left, centre or right, or none if you cannot see it.
- pressure: none, low or high on the ball carrier.
- Describe only what is visible. If the shot is not a wide pitch view, answer phase none, empty hot and say so in shape.`;

const EXAMPLES = [
  {
    lane: 'director',
    live: { clock: '23:10', t: 1390, scene: 'WIDE', ball: { state: 'visible', x: 0.62, y: 0.4 }, live: [3, 7, 9, 14, 21], menu: [{ id: 'key_player', label: 'key player', targets: [3], team: 'A', confidence: 0.7, sinceS: 3, carrier: 3, score: 3, touches: 2, carries: 0, received: 1 }], screen: null, sinceLastGraphicS: 9, calm: { state: 'ready' }, recent: [] },
    out: { action: 'show', graphic: 'key_player', targets: [3], caption: 'the man on the ball', say: 'Team A are playing through [[3]].', duration_s: 5, confidence: 0.78 },
  },
  {
    lane: 'director',
    live: { clock: '23:14', t: 1394, scene: 'WIDE', ball: { state: 'visible', x: 0.7, y: 0.45 }, live: [3, 7, 9, 14, 21, 22], menu: [{ id: 'overload', label: '4 v 2 overload', targets: [3, 7, 9, 14, 21, 22], team: 'A', margin: 2, attackers: 4, defenders: 2 }], screen: null, sinceLastGraphicS: 35, calm: { state: 'ready' }, recent: [{ ago: 6, a: 'show', g: 'key_player' }] },
    out: { action: 'show', graphic: 'overload', targets: [3, 7, 9, 14, 21, 22], caption: 'four against two on the right', say: 'Team A have the numbers on [[7]]s side.', duration_s: 5, confidence: 0.82 },
  },
  {
    lane: 'director',
    live: { clock: '23:19', t: 1399, scene: 'WIDE', ball: { state: 'visible', x: 0.48, y: 0.52 }, live: [3, 7, 9, 14, 21, 22], menu: [{ id: 'passing_lanes', label: 'passing lanes', targets: [7, 9, 14], team: 'A', carrier: 7 }], screen: { graphic: 'key_player', forS: 6 }, sinceLastGraphicS: 6, calm: { state: 'busy', reason: 'pan 300px/s' }, recent: [{ ago: 6, a: 'show', g: 'key_player' }] },
    out: { action: 'hide', graphic: 'key_player', targets: [], caption: '', say: '', duration_s: 4, confidence: 0.8 },
  },
  {
    lane: 'watch',
    live: { t: 1394, live: [3, 7, 9, 14, 21] },
    out: { phase: 'build_up', shape: 'back four wide, midfielder dropping between centre backs', hot: [7, 3], ball_side: 'left', pressure: 'low' },
  },
];

const SHARED = [
  KIMI_PERSONA,
  KIMI_GLOSSARY,
  schemasText({ [DIRECTOR_SCHEMA_NAME]: DIRECTOR_SCHEMA, [WATCH_SCHEMA_NAME]: WATCH_SCHEMA }),
  fewShotText(EXAMPLES),
].join('\n\n');

export const KIMI_PROMPT_SPEC: PromptSpec = createPromptSpec(SHARED, { director: DIRECTOR_LANE, watch: WATCH_LANE });

/** A typical match block, used to calibrate lane padding. Real blocks of similar size keep the same alignment. */
export const REFERENCE_MATCH: MatchBlock = {
  teams: { A: { name: 'Team A', kit: '#2255cc', formation: '4-3-3' }, B: { name: 'Team B', kit: '#cc2222', formation: '4-4-2' } },
  attack: { A: 'right', B: 'left' },
  extra: { teamsCalibrated: true },
};
