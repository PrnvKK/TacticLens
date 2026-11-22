// Incremental Server-Sent-Events parser (hand-written, no deps). Feed arbitrary string chunks.
export interface SseEvent { event: string; data: string }

export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    let idx: number;
    // Lines end with \n, \r\n or \r. A trailing lone \r is held back (could be half of \r\n).
    while ((idx = this.nextBreak()) >= 0) {
      const line = this.buf.slice(0, idx);
      const skip = this.buf[idx] === '\r' && this.buf[idx + 1] === '\n' ? 2 : 1;
      this.buf = this.buf.slice(idx + skip);
      if (line === '') {
        const ev = this.flush();
        if (ev) out.push(ev);
        continue;
      }
      if (line.startsWith(':')) continue; // comment / keep-alive
      const c = line.indexOf(':');
      let field = line;
      let value = '';
      if (c >= 0) {
        field = line.slice(0, c);
        value = line.slice(c + 1);
        if (value.startsWith(' ')) value = value.slice(1);
      }
      if (field === 'event') this.event = value;
      else if (field === 'data') this.data.push(value);
    }
    return out;
  }

  /** Call at end of stream to flush an unterminated final event. */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf.length) out.push(...this.push('\n'));
    const ev = this.flush();
    if (ev) out.push(ev);
    return out;
  }

  private nextBreak(): number {
    for (let i = 0; i < this.buf.length; i++) {
      const ch = this.buf[i];
      if (ch === '\n') return i;
      if (ch === '\r') {
        if (i === this.buf.length - 1) return -1;
        return i;
      }
    }
    return -1;
  }

  private flush(): SseEvent | null {
    if (!this.data.length && !this.event) return null;
    const ev = { event: this.event || 'message', data: this.data.join('\n') };
    this.event = '';
    this.data = [];
    return ev;
  }
}
