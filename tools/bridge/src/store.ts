// Owns the in-process bridge state and writes snapshots to disk (the MCP tool returns the file).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CommandQueue } from './commands';
import { MatchMemory } from './memory';
import type { BridgeState, SnapshotPost, SnapshotRef, StoredUpdate } from './protocol';

const MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024;

export interface StoreOpts {
  snapshotDir?: string;
  now?: () => number;
}

export class BridgeStore {
  readonly memory = new MatchMemory();
  readonly commands = new CommandQueue();
  readonly snapshotDir: string;
  private readonly now: () => number;
  private seq = 0;

  constructor(o: StoreOpts = {}) {
    this.snapshotDir = resolve(o.snapshotDir ?? join(process.cwd(), '.snapshots'));
    this.now = o.now ?? (() => Date.now());
    mkdirSync(this.snapshotDir, { recursive: true });
  }

  ingest(s: BridgeState, receivedAt = this.now()): void {
    this.memory.ingest(s, receivedAt);
  }

  addSnapshot(p: SnapshotPost): SnapshotRef {
    const raw = p.jpegBase64.replace(/^data:image\/jpeg;base64,/, '');
    const bytes = Buffer.from(raw, 'base64');
    if (!bytes.length) throw new Error('snapshot: empty JPEG');
    if (bytes.length > MAX_SNAPSHOT_BYTES) throw new Error(`snapshot: ${bytes.length} bytes exceeds limit`);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('snapshot: not a JPEG');
    const id = `snap-${++this.seq}-${Math.random().toString(36).slice(2, 8)}`;
    const path = join(this.snapshotDir, `${id}.jpg`);
    writeFileSync(path, bytes);
    const ref: SnapshotRef = {
      id, path,
      t: p.t,
      width: p.width,
      height: p.height,
      bytes: bytes.length,
      receivedAt: this.now(),
    };
    this.memory.addSnapshot(ref);
    return ref;
  }

  addUpdate(text: string, skipped = false): StoredUpdate {
    return this.memory.addUpdate(text, skipped);
  }

  health(): Record<string, unknown> {
    const s = this.memory.latest;
    return {
      ok: true,
      hasState: !!s,
      latestT: s?.t ?? null,
      stateAgeS: s ? Math.round((this.now() - s.receivedAt) / 100) / 10 : null,
      snapshots: this.memory.snapshots.length,
      updates: this.memory.updates.length,
      queuedCommands: this.commands.list().length,
      teamLabels: this.memory.teamLabels,
    };
  }
}
