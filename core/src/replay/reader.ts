import type { FrameRecord, Session, SessionHeader } from './format';
import { SESSION_VERSION } from './format';

/** Parse JSONL text. Blank lines are ignored; a bad line throws with its line number. */
export function parseSession(text: string): Session {
  let header: SessionHeader | null = null;
  const frames: FrameRecord[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!.trim();
    if (!ln) continue;
    let o: { kind?: string };
    try { o = JSON.parse(ln) as { kind?: string }; } catch (e) { throw new Error(`session line ${i + 1}: invalid JSON (${(e as Error).message})`); }
    if (o.kind === 'header') {
      if (header) throw new Error(`session line ${i + 1}: second header`);
      header = o as SessionHeader;
      if (header.version !== SESSION_VERSION) throw new Error(`unsupported session version ${String(header.version)}`);
    } else if (o.kind === 'frame') frames.push(o as FrameRecord);
    // unknown kinds are skipped: forward compatible
  }
  if (!header) throw new Error('session has no header line');
  return { header, frames };
}
