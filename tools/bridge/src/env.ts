// .env loading without dependencies. Values are never printed; only missing-key names are reported.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function findEnvFile(start = process.cwd()): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    const p = join(dir, '.env');
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

/** Process env wins over .env, so a shell override is always possible. */
export function loadEnv(start = process.cwd()): Record<string, string> {
  const file = findEnvFile(start);
  const fromFile = file ? parseEnv(readFileSync(file, 'utf8')) : {};
  const out: Record<string, string> = { ...fromFile };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  return out;
}

export type PingMode = 'commentary' | 'agent';

export interface BridgeConfig {
  host: string;
  port: number;
  token: string;
  snapshotDir: string;
  stateIntervalMs: number;
  snapshotEveryMs: number;
  /** Live-play ms between proactive pings (default 10 s). */
  cadenceMs: number;
  /** Hard minimum wall-clock gap between pings (default 10 s). */
  minGapMs: number;
  /** `commentary` reuses the on-screen Kimi line (no model call); `agent` triggers OpenClaw. */
  pingMode: PingMode;
}

function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function bridgeConfigFromEnv(env: Record<string, string | undefined>): BridgeConfig {
  const token = (env.BRIDGE_TOKEN || '').trim();
  if (!token) {
    throw new Error(
      'BRIDGE_TOKEN is not set. Add it to .env (any long random string), e.g. ' +
      'BRIDGE_TOKEN=<64 hex chars>. The extension build and the bridge must use the same value.',
    );
  }
  const port = Number(env.BRIDGE_PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BRIDGE_PORT must be a valid TCP port');
  return {
    host: env.BRIDGE_HOST || '127.0.0.1',
    port,
    token,
    snapshotDir: env.BRIDGE_SNAPSHOT_DIR || join(process.cwd(), '.snapshots'),
    stateIntervalMs: Number(env.BRIDGE_STATE_MS || 1000),
    snapshotEveryMs: Number(env.BRIDGE_SNAPSHOT_MS || 30_000),
    cadenceMs: positive(env.BRIDGE_CADENCE_MS, 10_000),
    minGapMs: positive(env.BRIDGE_MIN_GAP_MS, 10_000),
    pingMode: (env.BRIDGE_PING_MODE || 'commentary').trim().toLowerCase() === 'agent' ? 'agent' : 'commentary',
  };
}
