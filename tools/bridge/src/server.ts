// Local HTTP server. Binds loopback only, authenticates every data/tool route with a shared token,
// and exposes /state, /snapshot, /commands, /commands/ack and /mcp.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { applyAcks, handleMcp } from './mcp';
import { isBridgeState, type CommandAck, type SnapshotPost } from './protocol';
import { BridgeStore } from './store';

export interface BridgeServerOpts {
  token: string;
  host?: string;
  port?: number;
  /** Reuse a store owned by the caller (the CLI does this so the scheduler sees MCP updates). */
  store?: BridgeStore;
  snapshotDir?: string;
  recordUpdate?: (text: string, skipped: boolean, triggerId?: string) => unknown;
  logger?: (line: string) => void;
  now?: () => number;
}

export interface BridgeServer {
  server: Server;
  store: BridgeStore;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

const STATE_LIMIT = 256 * 1024;
const SNAPSHOT_LIMIT = 5 * 1024 * 1024;
const MCP_LIMIT = 512 * 1024;

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  const text = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-bridge-token, mcp-session-id',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  });
  res.end(text);
}

function tokenOk(req: IncomingMessage, token: string): boolean {
  const auth = req.headers.authorization;
  const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const raw = bearer || (typeof req.headers['x-bridge-token'] === 'string' ? req.headers['x-bridge-token'] : '');
  if (!raw) return false;
  const a = Buffer.from(raw);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (err: Error): void => { if (!done) { done = true; reject(err); } };
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) { fail(new Error('body too large')); req.resume(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(text)); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', fail);
  });
}

export function createBridgeServer(o: BridgeServerOpts): BridgeServer {
  const store = o.store ?? new BridgeStore({ snapshotDir: o.snapshotDir, now: o.now });
  const log = o.logger ?? (() => undefined);
  const host = o.host ?? '127.0.0.1';
  let boundPort = o.port ?? 0;

  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/';
    const method = req.method ?? 'GET';
    const reply = (status: number, body: unknown): void => {
      send(res, status, body);
      log(`${method} ${url} ${status}`);
    };

    if (method === 'OPTIONS') { send(res, 204, ''); return; }
    if (url === '/health' && method === 'GET') { reply(200, store.health()); return; }
    if (url !== '/health' && !tokenOk(req, o.token)) {
      reply(401, { ok: false, error: 'unauthorized' });
      return;
    }
    if (url === '/mcp' && method === 'GET') {
      res.setHeader('Allow', 'POST, DELETE');
      reply(405, { ok: false, error: 'Use POST for MCP Streamable HTTP' });
      return;
    }

    if (url === '/state' && method === 'POST') {
      void readJson(req, STATE_LIMIT).then((body) => {
        if (!isBridgeState(body)) { reply(400, { ok: false, error: 'invalid state' }); return; }
        store.ingest(body);
        reply(200, { ok: true });
      }).catch((e: Error) => reply(e.message === 'body too large' ? 413 : 400, { ok: false, error: e.message }));
      return;
    }

    if (url === '/snapshot' && method === 'POST') {
      void readJson(req, SNAPSHOT_LIMIT).then((body) => {
        const p = body as Partial<SnapshotPost>;
        if (typeof p.jpegBase64 !== 'string' || typeof p.t !== 'number' || typeof p.width !== 'number' || typeof p.height !== 'number') {
          reply(400, { ok: false, error: 'invalid snapshot' });
          return;
        }
        try {
          const ref = store.addSnapshot({ jpegBase64: p.jpegBase64, t: p.t, width: p.width, height: p.height });
          reply(200, { ok: true, id: ref.id });
        } catch (e) {
          reply(400, { ok: false, error: (e as Error).message });
        }
      }).catch((e: Error) => reply(e.message === 'body too large' ? 413 : 400, { ok: false, error: e.message }));
      return;
    }

    if (url === '/commands' && method === 'GET') {
      reply(200, { commands: store.commands.list() });
      return;
    }

    if (url === '/commands/ack' && method === 'POST') {
      void readJson(req, 64 * 1024).then((body) => {
        const acks = (body as { acks?: unknown }).acks;
        if (!Array.isArray(acks)) { reply(400, { ok: false, error: 'acks[] required' }); return; }
        const clean: CommandAck[] = acks
          .filter((a): a is CommandAck => !!a && typeof a === 'object' && typeof (a as CommandAck).id === 'string' && typeof (a as CommandAck).accepted === 'boolean')
          .map((a) => ({ id: a.id, accepted: a.accepted, reason: typeof a.reason === 'string' ? a.reason.slice(0, 200) : undefined }));
        reply(200, { ok: true, acked: applyAcks(store, clean) });
      }).catch((e: Error) => reply(400, { ok: false, error: e.message }));
      return;
    }

    if (url === '/mcp' && method === 'POST') {
      void readJson(req, MCP_LIMIT).then((body) => {
        const out = handleMcp(store, body, { recordUpdate: o.recordUpdate });
        if (out === null) { send(res, 202, ''); log(`${method} ${url} 202`); return; }
        res.setHeader('Mcp-Session-Id', 'tacticlens-bridge');
        reply(200, out);
      }).catch((e: Error) => reply(e.message === 'body too large' ? 413 : 400, { ok: false, error: e.message }));
      return;
    }

    if (url === '/mcp' && method === 'DELETE') { reply(200, { ok: true }); return; }
    reply(404, { ok: false, error: 'not found' });
  });

  return {
    server,
    store,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(boundPort, host, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') boundPort = addr.port;
        resolve({ host, port: boundPort });
      });
    }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
