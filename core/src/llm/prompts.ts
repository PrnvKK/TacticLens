// Output schema for the model's one-line tactical reply.
// The live prompts are DIRECTOR_SYSTEM_PROMPT (director/prompts.ts) and the commentary/ask prompts in the extension.

export const GFX_TYPES = ['spotlight', 'tag', 'lanes', 'hull', 'overload', 'links', 'run', 'line', 'switch', 'pocket', 'none'] as const;
export const PHASES = ['build_up', 'press', 'transition', 'settled', 'set_piece', 'none'] as const;

/** Strict, flat, no oneOf. `say` first so it streams. All properties required (strict mode). */
export const OUTPUT_SCHEMA_NAME = 'tactic_line';
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['say', 'phase', 'focus', 'gfx', 'tiles', 'predict', 'confidence'],
  properties: {
    say: { type: 'string' },
    phase: { type: 'string', enum: [...PHASES] },
    focus: { type: 'array', items: { type: 'integer' } },
    gfx: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'ids', 'team', 'label'],
        properties: {
          type: { type: 'string', enum: [...GFX_TYPES] },
          ids: { type: 'array', items: { type: 'integer' } },
          team: { type: 'string', enum: ['A', 'B', 'none'] },
          label: { type: 'string' },
        },
      },
    },
    tiles: { type: 'array', items: { type: 'string' } },
    predict: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id', 'side', 'within_s'],
      properties: {
        kind: { type: 'string', enum: ['pass_to', 'switch', 'turnover', 'none'] },
        id: { type: 'integer' },
        side: { type: 'string', enum: ['left', 'right', 'none'] },
        within_s: { type: 'number' },
      },
    },
    confidence: { type: 'number' },
  },
} as const;

export interface TacticLineOutput {
  say: string;
  phase: (typeof PHASES)[number];
  focus: number[];
  gfx: { type: (typeof GFX_TYPES)[number]; ids: number[]; team: 'A' | 'B' | 'none'; label: string }[];
  tiles: string[];
  predict: { kind: 'pass_to' | 'switch' | 'turnover' | 'none'; id: number; side: 'left' | 'right' | 'none'; within_s: number };
  confidence: number;
}

/** Light structural check used by the mock tests (not the guardrail layer). */
export function isTacticLine(x: unknown): x is TacticLineOutput {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.say === 'string' && typeof o.phase === 'string' && Array.isArray(o.focus) && Array.isArray(o.gfx) &&
    Array.isArray(o.tiles) && typeof o.predict === 'object' && o.predict !== null && typeof o.confidence === 'number';
}
