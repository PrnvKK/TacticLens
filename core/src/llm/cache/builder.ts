import type { ChatContentPart, ChatMessage } from '../providers';
import { BLOCK_TOKENS, BRIDGE_A, BRIDGE_B, type MatchBlock, type PromptSpec } from './spec';
import { DEFAULT_CHARS_PER_TOKEN, EMPTY_CALIBRATION, type Calibration, type ModelCalibration, type PromptCalibration } from './calibration';
import { fillerText } from './filler';
import { hashString, quantHex, stableStringify } from './serialize';

export interface BuildInput {
  lane: string;
  match?: MatchBlock | null;
  /** Volatile tail: a string, or an object serialised deterministically. */
  tail: string | object;
  /** Optional base64 data URL; placed in the user message before the tail text. */
  image?: string;
}

export interface BuiltPrompt {
  messages: ChatMessage[];
  /** The system message: the stable, block-aligned prefix. */
  stable: string;
  /** Hash of the stable prefix; equal fingerprints mean byte-identical prefixes. */
  fingerprint: string;
  info: { sharedChars: number; laneChars: number; padShared: number; padLane: number; calibrated: boolean; estStableTokens: number };
}

export function renderMatchBlock(m: MatchBlock | null | undefined): string {
  if (!m) return 'MATCH: not yet known.\n';
  const q: MatchBlock = {
    ...m,
    teams: {
      A: { ...m.teams.A, kit: quantHex(m.teams.A.kit) },
      B: { ...m.teams.B, kit: quantHex(m.teams.B.kit) },
    },
  };
  return `MATCH (changes rarely)\n${stableStringify(q, 2)}\n`;
}

export interface PromptBuilderOptions {
  model: string;
  calibration?: Calibration;
}

interface Stable { stable: string; padShared: number; padLane: number; sharedChars: number; laneChars: number }

export class PromptBuilder {
  private cache = new Map<string, Stable>();
  private forced: { sharedPad?: number; lanePad?: Record<string, number> } = {};
  constructor(readonly spec: PromptSpec, private o: PromptBuilderOptions) {}

  get model(): string { return this.o.model; }
  private get cal(): Calibration { return this.o.calibration ?? EMPTY_CALIBRATION; }
  private get modelCal(): ModelCalibration | undefined { return this.cal.models[this.o.model]; }
  private get promptCal(): PromptCalibration | undefined { return this.modelCal?.prompts[this.spec.version]; }
  get charsPerToken(): number { return this.modelCal?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN; }
  get calibrated(): boolean { return !!this.promptCal; }

  /** Override padding explicitly (used by the calibration script while it searches for the aligned size). */
  force(f: { sharedPad?: number; lanePad?: Record<string, number> } | null): void { this.forced = f ?? {}; this.cache.clear(); }

  private blockChars(): number { return Math.round(BLOCK_TOKENS * this.charsPerToken); }

  /** Pad characters so that [shared][pad][bridge A] ends on a block boundary. */
  private sharedPadChars(): number {
    if (this.forced.sharedPad !== undefined) return this.forced.sharedPad;
    const have = this.spec.shared.length + BRIDGE_A.length;
    const c = this.promptCal;
    const total = c ? c.sharedChars : Math.max(1, Math.ceil(have / this.blockChars())) * this.blockChars();
    let pad = total - have;
    while (pad < 0) pad += this.blockChars();
    return pad;
  }

  private lanePadChars(lane: string, withoutPad: number): number {
    const f = this.forced.lanePad?.[lane];
    if (f !== undefined) return f;
    const c = this.promptCal?.lanes[lane];
    const total = c ? c.segChars : Math.max(1, Math.ceil(withoutPad / this.blockChars())) * this.blockChars();
    let pad = total - withoutPad;
    while (pad < 0) pad += this.blockChars();
    return pad;
  }

  private stableFor(lane: string, match: MatchBlock | null | undefined): Stable {
    const instr = this.spec.lanes[lane];
    if (instr === undefined) throw new Error(`unknown lane ${lane}`);
    const matchText = renderMatchBlock(match);
    const key = `${lane}|${matchText}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const padShared = this.sharedPadChars();
    const shared = this.spec.shared + fillerText(padShared) + BRIDGE_A;
    const laneNoPad = BRIDGE_B + instr + '\n' + matchText;
    const padLane = this.lanePadChars(lane, laneNoPad.length + BRIDGE_A.length);
    const laneSeg = laneNoPad + fillerText(padLane) + BRIDGE_A;
    const out: Stable = { stable: shared + laneSeg, padShared, padLane, sharedChars: shared.length, laneChars: laneSeg.length };
    if (this.cache.size > 32) this.cache.clear();
    this.cache.set(key, out);
    return out;
  }

  /** The shared layer alone (plus the opening of the next layer), for calibration of the first boundary. */
  sharedOnly(): string {
    return this.spec.shared + fillerText(this.sharedPadChars()) + BRIDGE_A + BRIDGE_B;
  }

  build(input: BuildInput): BuiltPrompt {
    const s = this.stableFor(input.lane, input.match);
    const tailText = typeof input.tail === 'string' ? input.tail : stableStringify(input.tail, 2);
    const user: ChatMessage['content'] = input.image
      ? ([{ type: 'image_url', image_url: { url: input.image } }, { type: 'text', text: tailText }] as ChatContentPart[])
      : tailText;
    return {
      messages: [{ role: 'system', content: s.stable }, { role: 'user', content: user }],
      stable: s.stable,
      fingerprint: hashString(s.stable),
      info: {
        sharedChars: s.sharedChars, laneChars: s.laneChars, padShared: s.padShared, padLane: s.padLane,
        calibrated: this.calibrated, estStableTokens: Math.round(s.stable.length / this.charsPerToken),
      },
    };
  }
}
