// Graphics requests queued for the extension. The extension polls, runs a command through the
// existing director validator + calm gate, then acks with the outcome.
import type { CommandAck, GraphicCommand, GraphicId } from './protocol';

const MAX_PENDING = 20;

export class CommandQueue {
  private seq = 0;
  private pending: GraphicCommand[] = [];

  push(graphic: GraphicId, targets: number[], reason: string, at = Date.now()): GraphicCommand {
    const cmd: GraphicCommand = {
      id: `g${++this.seq}-${at.toString(36)}`,
      graphic,
      targets: [...new Set(targets.filter((t) => Number.isInteger(t)))],
      reason: reason.trim().slice(0, 160),
      at,
    };
    this.pending.push(cmd);
    while (this.pending.length > MAX_PENDING) this.pending.shift();
    return cmd;
  }

  /** Commands still awaiting an ack. Repeated polls return the same list. */
  list(): GraphicCommand[] {
    return this.pending.map((c) => ({ ...c, targets: [...c.targets] }));
  }

  ack(acks: CommandAck[]): number {
    const ids = new Set(acks.map((a) => a.id));
    const before = this.pending.length;
    this.pending = this.pending.filter((c) => !ids.has(c.id));
    return before - this.pending.length;
  }

  clear(): void {
    this.pending.length = 0;
  }
}
