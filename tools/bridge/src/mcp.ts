// Minimal MCP Streamable HTTP server implementation (JSON-RPC 2.0, tools only).
// No SDK: the tool surface is small and the bridge must stay dependency-free.
import { readFileSync } from 'node:fs';
import type { CommandQueue } from './commands';
import { exposeEvent, exposeSummary, exposeState } from './expose';
import { labelTeams } from './labels';
import { stripMediaTalk } from './media';
import type { MatchMemory } from './memory';
import { GRAPHIC_IDS, isGraphicId, type CommandAck } from './protocol';

export interface McpStore {
  memory: MatchMemory;
  commands: CommandQueue;
}

export interface McpHooks {
  /** May answer `{ stale: true }` when the trigger has expired; the text is then not stored or reported. */
  recordUpdate?: (text: string, skipped: boolean, triggerId?: string) => unknown;
}

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const STALE_REPLY = 'STALE: this update expired. Send nothing.';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const TOOLS = [
  {
    name: 'get_live_state',
    description: 'Current TacticLens picture: teamLabels (the jersey-colour names, e.g. "Team Red", the ONLY names to use for the sides; the A/B keys are internal), liveness, ball, qualitative tactical facts (press, overload, space) and a qualitative possession leader. Numeric possession/passes/turnovers are only included when includeStats is true (the bridge asks for them only when a stat line is due). Invalid, low-confidence and impossible overload facts are already removed.',
    inputSchema: {
      type: 'object',
      properties: { includeStats: { type: 'boolean', description: 'Include possession/passes/turnovers numbers. Default false.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_events_since',
    description: 'Recent rule-computed event types and teams: turnovers, presses, switches, overloads, momentum flips and more. Each event carries teamLabel (e.g. "Team Red"); say that, never the A/B key. Timestamps, confidences and numeric detail are not exposed.',
    inputSchema: {
      type: 'object',
      properties: { t: { type: 'number', description: 'Optional video time in seconds; omit for the recent event log.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_match_memory',
    description: 'Rolling match memory: recent event types, your previous updates, and whether anything meaningful changed. Per-minute possession/passes/turnovers are only included when includeStats is true.',
    inputSchema: {
      type: 'object',
      properties: { includeStats: { type: 'boolean', description: 'Include per-minute stat numbers. Default false.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_latest_snapshot',
    description: 'Optional background reference only: the latest visual of the current picture. Never mention it, its file or its contents in any update; your text must read perfectly without it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'request_graphic',
    description: 'Ask TacticLens to draw a graphic on screen. The extension still runs the request through its director validator and calm gate.',
    inputSchema: {
      type: 'object',
      properties: {
        graphic: { type: 'string', enum: [...GRAPHIC_IDS], description: 'Graphic id from the TacticLens director vocabulary.' },
        targets: { type: 'array', items: { type: 'integer' }, description: 'Optional live track ids; omit to use the fact targets.' },
        reason: { type: 'string', description: 'Short reason for the request; becomes the on-screen label when nothing better exists.' },
      },
      required: ['graphic'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_update',
    description: 'Save your update (or report SKIP) so future updates do not repeat it. Call after every proactive update. The result returns the final text with the team labels enforced ("Team Red", never Team A/B) and media or tool wording removed; send exactly that text to Telegram, or nothing if it comes back empty or skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The update text you will send to Telegram, or SKIP.' },
        skipped: { type: 'boolean', description: 'True when you decided not to send an update.' },
        triggerId: { type: 'string', description: 'The triggerId from the trigger message. Required for live triggers; an update for an expired trigger comes back STALE.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
] as const;

function textResult(text: string): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return { content: [{ type: 'text', text }] };
}

function jsonResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return textResult(JSON.stringify(value));
}

function toolCall(store: McpStore, name: string, args: Record<string, unknown>, hooks: McpHooks): unknown {
  switch (name) {
    case 'get_live_state': {
      const s = store.memory.latest;
      if (!s) return jsonResult({ state: null, note: 'No live state yet. Is the Theatre open with ?bridge=1?' });
      return jsonResult({
        ...exposeState(s, args.includeStats === true),
        meaningfulSinceLastUpdate: store.memory.meaningful(),
      });
    }
    case 'get_events_since': {
      const t = typeof args.t === 'number' && Number.isFinite(args.t) ? args.t : 0;
      const labels = store.memory.teamLabels;
      const events = store.memory.eventsSince(t).map((e) => exposeEvent(e, labels)).filter((e) => e !== null);
      return jsonResult({ ...(labels ? { teamLabels: labels } : {}), events });
    }
    case 'get_match_memory':
      return jsonResult(exposeSummary(store.memory, args.includeStats === true));
    case 'get_latest_snapshot': {
      const snap = store.memory.snapshot;
      if (!snap) return textResult('No background reference yet. Write from the live state and events alone.');
      try {
        const data = readFileSync(snap.path).toString('base64');
        return {
          content: [
            { type: 'image', data, mimeType: 'image/jpeg' },
            { type: 'text', text: `Background reference only; do not mention it in any update. File: ${snap.path}` },
          ],
        };
      } catch (e) {
        return { ...textResult(`Background reference unavailable: ${(e as Error).message}`), isError: true };
      }
    }
    case 'request_graphic': {
      const graphic = args.graphic;
      if (!isGraphicId(graphic)) return { ...textResult(`Unknown graphic: ${String(graphic)}`), isError: true };
      const targets = Array.isArray(args.targets)
        ? args.targets.filter((v): v is number => typeof v === 'number' && Number.isInteger(v))
        : [];
      const reason = typeof args.reason === 'string' ? args.reason : '';
      const cmd = store.commands.push(graphic, targets, reason);
      return jsonResult({ queued: true, id: cmd.id, graphic: cmd.graphic, targets: cmd.targets, note: 'The extension polls /commands and validates it against the live menu and calm gate.' });
    }
    case 'record_update': {
      const text = typeof args.text === 'string' ? args.text : '';
      if (!text.trim()) return { ...textResult('text is required'), isError: true };
      // Final sanitizers: media/machinery sentences are dropped and Team A/Team B (and "A side") become the
      // jersey labels before the text is stored or reported. Empty after cleaning means nothing may be sent.
      const clean = labelTeams(stripMediaTalk(text.trim()), store.memory.teamLabels);
      const skipped = args.skipped === true || text.trim().toUpperCase() === 'SKIP' || clean === '';
      const triggerId = typeof args.triggerId === 'string' && args.triggerId ? args.triggerId : undefined;
      // The bridge decides first: a stale answer is neither counted nor kept in the match memory.
      const verdict = hooks.recordUpdate?.(clean, skipped, triggerId);
      if (typeof verdict === 'object' && verdict !== null && (verdict as { stale?: unknown }).stale === true) {
        return textResult(STALE_REPLY);
      }
      store.memory.addUpdate(clean, skipped);
      return jsonResult({ recorded: true, skipped, text: clean });
    }
    default:
      return { ...textResult(`Unknown tool: ${name}`), isError: true };
  }
}

function handleOne(store: McpStore, req: JsonRpcRequest, hooks: McpHooks): JsonRpcResponse | null {
  const id = req.id ?? null;
  const method = req.method ?? '';
  if (method.startsWith('notifications/')) return null;
  if (!req.jsonrpc && req.jsonrpc !== undefined) {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
  }
  switch (method) {
    case 'initialize': {
      const requested = req.params?.protocolVersion;
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: typeof requested === 'string' ? requested : MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'tacticlens-bridge', version: '0.1.0' },
          instructions: 'TacticLens live match data. Read get_live_state, get_events_since and get_match_memory before writing an update; use request_graphic to put a validated graphic on screen. Write as a live match analyst watching the game: never mention images, snapshots, frames, tools, memory, JSON or data. Refer to the teams only by their teamLabels (jersey colours such as "Team Red"), never Team A/Team B or club names.',
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const name = req.params?.name;
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      if (typeof name !== 'string') return { jsonrpc: '2.0', id, error: { code: -32602, message: 'tools/call requires a name' } };
      return { jsonrpc: '2.0', id, result: toolCall(store, name, args, hooks) };
    }
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

/** Handles one JSON-RPC message or a batch. Returns null when every message was a notification. */
export function handleMcp(store: McpStore, body: unknown, hooks: McpHooks = {}): unknown {
  if (Array.isArray(body)) {
    const out = body.map((b) => handleOne(store, b as JsonRpcRequest, hooks)).filter((r): r is JsonRpcResponse => r !== null);
    return out.length ? out : null;
  }
  if (!body || typeof body !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
  }
  return handleOne(store, body as JsonRpcRequest, hooks);
}

export function applyAcks(store: McpStore, acks: CommandAck[]): number {
  return store.commands.ack(acks);
}

export { TOOLS };
