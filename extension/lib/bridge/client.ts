// Extension-side bridge client. Enabled only by ?bridge=1 or the popup toggle.
// The render loop only calls onState(); all network work is async, dropped on failure and backed off.
import type { SnapshotJpeg } from './capture';
import type { BridgeCommand, BridgeEvent, BridgeState, CommandAck } from './types';

declare const __TL_BRIDGE_TOKEN__: string;
declare const __TL_BRIDGE_URL__: string;

export function bridgeEndpoint(): { url: string; token: string } {
  const url = typeof __TL_BRIDGE_URL__ === 'string' && __TL_BRIDGE_URL__.trim()
    ? __TL_BRIDGE_URL__.trim()
    : 'http://127.0.0.1:8787';
  const token = typeof __TL_BRIDGE_TOKEN__ === 'string' ? __TL_BRIDGE_TOKEN__.trim() : '';
  return { url: url.replace(/\/+$/, ''), token };
}

export interface CommandOutcome { accepted: boolean; reason?: string }

export interface BridgeClientOpts {
  url?: string;
  token?: string;
  onCommand: (cmd: BridgeCommand) => CommandOutcome | Promise<CommandOutcome>;
  captureSnapshot?: () => Promise<SnapshotJpeg | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  stateIntervalMs?: number;
  snapshotEveryMs?: number;
  pollMs?: number;
  timeoutMs?: number;
}

export type BridgeStatus = 'off' | 'ok' | 'error';

export class BridgeClient {
  status: BridgeStatus = 'off';
  lastError = '';
  private readonly url: string;
  private readonly token: string;
  private readonly onCommand: BridgeClientOpts['onCommand'];
  private readonly capture?: BridgeClientOpts['captureSnapshot'];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly stateIntervalMs: number;
  private readonly snapshotEveryMs: number;
  private readonly pollMs: number;
  private readonly timeoutMs: number;

  private latest: BridgeState | null = null;
  /** Events are batched until a state POST succeeds, so a 1 Hz post never drops 8 Hz events. */
  private pendingEvents: BridgeEvent[] = [];
  private eventKeys = new Set<string>();
  private started = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private stateInFlight = false;
  private snapshotInFlight = false;
  private pollInFlight = false;
  private lastStateAt = -Infinity;
  private lastFrameAt: number | null = null;
  private liveMs = 0;
  private failures = 0;
  private nextAttemptAt = 0;
  private statePosts = 0;
  private snapshotPosts = 0;

  constructor(o: BridgeClientOpts) {
    const ep = bridgeEndpoint();
    this.url = (o.url ?? ep.url).replace(/\/+$/, '');
    this.token = o.token ?? ep.token;
    this.onCommand = o.onCommand;
    this.capture = o.captureSnapshot;
    this.fetchImpl = o.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = o.now ?? (() => Date.now());
    this.stateIntervalMs = o.stateIntervalMs ?? 1000;
    this.snapshotEveryMs = o.snapshotEveryMs ?? 30_000;
    this.pollMs = o.pollMs ?? 3000;
    this.timeoutMs = o.timeoutMs ?? 1500;
  }

  get stats(): { statePosts: number; snapshots: number; failures: number; liveMs: number } {
    return { statePosts: this.statePosts, snapshots: this.snapshotPosts, failures: this.failures, liveMs: this.liveMs };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.pollTimer = setInterval(() => { void this.pollNow(); }, this.pollMs);
    this.flushTimer = setInterval(() => { void this.flushState(); }, 250);
    void this.pollNow();
  }

  stop(): void {
    this.started = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.pollTimer = null;
    this.flushTimer = null;
  }

  /** Called from the perception tap. Synchronous and exception-free by construction. */
  onState(s: BridgeState): void {
    try {
      const now = this.now();
      const dt = this.lastFrameAt === null ? 0 : Math.max(0, Math.min(1000, now - this.lastFrameAt));
      this.lastFrameAt = now;
      this.latest = s;
      this.addEvents(s.events);
      if (s.liveness === 'LIVE' && s.scene === 'WIDE' && !s.paused && s.playing !== false) this.liveMs += dt;
      else this.liveMs = 0;
      if (this.liveMs >= this.snapshotEveryMs && !this.snapshotInFlight) {
        this.liveMs = 0;
        void this.sendSnapshotNow();
      }
    } catch { /* never surface into the render loop */ }
  }

  /** Post the newest state if one is due. Failures are swallowed and backed off. */
  async flushState(): Promise<void> {
    if (this.stateInFlight || !this.latest) return;
    const now = this.now();
    if (now < this.nextAttemptAt || now - this.lastStateAt < this.stateIntervalMs) return;
    this.stateInFlight = true;
    const sent = this.pendingEvents.slice();
    const body = JSON.stringify({ ...this.latest, events: sent });
    try {
      const r = await this.request('/state', { method: 'POST', body });
      if (r.ok) {
        this.lastStateAt = now;
        this.statePosts++;
        this.pendingEvents.splice(0, sent.length);
        this.ok();
      } else this.fail(r.error);
    } catch {
      this.fail('network');
    } finally {
      this.stateInFlight = false;
    }
  }

  async sendSnapshotNow(): Promise<void> {
    if (this.snapshotInFlight || !this.capture) return;
    this.snapshotInFlight = true;
    try {
      const shot = await this.capture();
      if (!shot) return;
      const r = await this.request('/snapshot', {
        method: 'POST',
        body: JSON.stringify({ jpegBase64: shot.base64, t: shot.t, width: shot.width, height: shot.height }),
      });
      if (r.ok) { this.snapshotPosts++; this.ok(); } else this.fail(r.error);
    } catch {
      this.fail('snapshot');
    } finally {
      this.snapshotInFlight = false;
    }
  }

  async pollNow(): Promise<void> {
    if (this.pollInFlight) return;
    if (this.now() < this.nextAttemptAt) return;
    this.pollInFlight = true;
    try {
      const r = await this.request('/commands', { method: 'GET' });
      if (!r.ok) { this.fail(r.error); return; }
      const commands = (r.json as { commands?: BridgeCommand[] }).commands ?? [];
      if (!commands.length) { this.ok(); return; }
      const acks: CommandAck[] = [];
      for (const cmd of commands) {
        try {
          const out = await this.onCommand(cmd);
          acks.push({ id: cmd.id, accepted: out.accepted, reason: out.reason });
        } catch {
          acks.push({ id: cmd.id, accepted: false, reason: 'command handler failed' });
        }
      }
      const ack = await this.request('/commands/ack', { method: 'POST', body: JSON.stringify({ acks }) });
      if (ack.ok) { this.ok(); this.statePosts++; } else this.fail(ack.error);
    } catch {
      this.fail('poll');
    } finally {
      this.pollInFlight = false;
    }
  }

  private addEvents(events: BridgeEvent[] | undefined): void {
    if (!events?.length) return;
    for (const e of events) {
      const key = `${e.t.toFixed(1)}|${e.type}|${e.team}`;
      if (this.eventKeys.has(key)) continue;
      this.eventKeys.add(key);
      this.pendingEvents.push(e);
    }
    while (this.pendingEvents.length > 200) {
      const old = this.pendingEvents.shift();
      if (old) this.eventKeys.delete(`${old.t.toFixed(1)}|${old.type}|${old.team}`);
    }
  }

  private ok(): void {
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.status = 'ok';
    this.lastError = '';
  }

  private fail(error?: string): void {
    this.failures++;
    const delay = Math.min(60_000, 5000 * 2 ** Math.min(this.failures - 1, 4));
    this.nextAttemptAt = this.now() + delay;
    this.status = 'error';
    this.lastError = error || 'request failed';
  }

  private async request(path: string, init: { method: string; body?: string }): Promise<{ ok: boolean; status: number; json: unknown; error?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.url}${path}`, {
        method: init.method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: init.body,
        signal: controller.signal,
      });
      const text = await res.text().catch(() => '');
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (!res.ok) {
        const msg = json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string'
          ? (json as { error: string }).error
          : `HTTP ${res.status}`;
        return { ok: false, status: res.status, json, error: msg };
      }
      return { ok: true, status: res.status, json };
    } catch (e) {
      return { ok: false, status: 0, json: null, error: (e as Error)?.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }
}
