// Chat lines must sound like a commentator, never like a tool reading its inputs. This drops every sentence
// that talks about pictures, the JSON payload, trackers or memory. It is the last line of defence behind the prompts.
const MEDIA_TALK = /\b(?:jpe?g|jpg|png|images?|screenshots?|snapshots?|photos?|pictures?|annotated|annotations?|frames?|trackers?|payloads?|json|metadata|rings?|data|memory)\b/i;

/**
 * Drop every sentence that mentions a picture, a frame, the tracker, the payload or the JSON, collapse the
 * whitespace and return what is left ('' when nothing remains).
 */
export function stripMediaTalk(text: string): string {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((s) => s.trim() && !MEDIA_TALK.test(s))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
