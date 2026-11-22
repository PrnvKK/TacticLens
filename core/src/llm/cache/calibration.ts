// Calibration data: measured by `pnpm llm:calibrate`, read by the prompt builder. Keyed by model id and
// prompt version, so changing a prompt string or the model falls back to the estimate until re-measured.

export interface LaneCalibration {
  /** Characters of [bridge B][lane][match][pad][bridge A] for the reference match block. */
  segChars: number;
  /** Measured prompt_tokens of the full stable prefix plus a one-token tail. */
  tokens: number;
}

export interface PromptCalibration {
  /** Characters of [shared][pad][bridge A]. */
  sharedChars: number;
  sharedTokens: number;
  lanes: Record<string, LaneCalibration>;
}

export interface ModelCalibration {
  charsPerToken: number;
  imageTokens: { w768: number; w512: number };
  ttftMs: { cold: number; warm: number };
  /** Smallest observed cached_tokens step. */
  cacheBlockTokens: number;
  prompts: Record<string, PromptCalibration>;
}

export interface Calibration {
  schema: 1;
  blockSize: number;
  measuredAt: string;
  models: Record<string, ModelCalibration>;
}

export const EMPTY_CALIBRATION: Calibration = { schema: 1, blockSize: 1024, measuredAt: '', models: {} };
export const DEFAULT_CHARS_PER_TOKEN = 3.9;
/** Tokens of [bridge B] + chat template + a one-token tail: where the measured boundary sits past a block edge. */
export const BOUNDARY_OFFSET_TOKENS = 50;
