// Team labels: the extension names each side by jersey colour ("Team Red", "Team Yellow"). The analyst
// and every Telegram text must use only those labels, never "Team A/Team B", the bare letters or club names.
// The A/B keys stay internal to the wire contract; this module validates the labels and enforces them in text.

export interface TeamLabels { A: string; B: string }

const LABEL_RE = /^[\p{L}\p{N}][\p{L}\p{N} '’-]{0,31}$/u;
/** A label that is itself an A/B placeholder would defeat the point (and could loop the sanitizer). */
const PLACEHOLDER_RE = /^(?:team[\s_-]*)?[ab]$/i;

function cleanLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  if (!LABEL_RE.test(t) || PLACEHOLDER_RE.test(t)) return null;
  return t;
}

/** Accepts two distinct, short, printable labels; anything else is ignored (the previous labels stay). */
export function parseTeamLabels(v: unknown): TeamLabels | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { A?: unknown; B?: unknown };
  const A = cleanLabel(o.A);
  const B = cleanLabel(o.B);
  if (!A || !B || A.toLowerCase() === B.toLowerCase()) return null;
  return { A, B };
}

// "Team A", "team b", "TEAM-A", "teamA" (+ a trailing possessive, which is left in place).
const TEAM_LETTER_RE = /\bteam[\s_-]*([AB])\b/gi;
// "A side", "B-side" with an upper-case letter only: a lower-case "a side" is ordinary English, and
// "A side-footed pass" / "a side-step" must survive.
const SIDE_RE = /(?<![\w'])([AB])[ -]side\b(?!-)/g;

/**
 * Final sanitizer for every outbound analyst/Telegram text. Rewrites the A/B placeholders to the jersey
 * labels; leaves the text untouched while no labels are known. Idempotent.
 */
export function labelTeams(text: string, labels: TeamLabels | null | undefined): string {
  if (!text || !labels) return text;
  const pick = (letter: string): string => (letter.toUpperCase() === 'A' ? labels.A : labels.B);
  return text
    .replace(TEAM_LETTER_RE, (_m, l: string) => pick(l))
    .replace(SIDE_RE, (_m, l: string) => pick(l));
}

/** The one instruction line shared by the trigger message and the dry-run prompts. Empty until labels are known. */
export function teamLabelLine(labels: TeamLabels | null | undefined): string {
  if (!labels) return '';
  return `Team labels: A = "${labels.A}", B = "${labels.B}". Refer to the teams ONLY as "${labels.A}" and "${labels.B}". Never write Team A, Team B, the letters A or B for a side, or a club name.`;
}
