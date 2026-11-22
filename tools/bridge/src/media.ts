// Backstop for outbound analyst text: the analyst is a live pundit, never a describer of its inputs.
// The prompts already forbid media and machinery talk; this drops any sentence that still carries it.
const MEDIA_TALK_RE = /\b(?:jpe?g|png|images?|screenshots?|snapshots?|photos?|pictures?|annotated|annotations?|frames?|trackers?|payloads?|json|metadata|attachments?|attached)\b/i;

/**
 * Drops every sentence that mentions an image, snapshot, file format or other machinery (case-insensitive),
 * collapses whitespace and returns '' when nothing is left. The caller treats '' as a skipped update.
 */
export function stripMediaTalk(text: string): string {
  if (!text) return '';
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !MEDIA_TALK_RE.test(sentence))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
