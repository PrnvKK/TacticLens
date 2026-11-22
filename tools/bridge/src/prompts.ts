// Prompt and context builders shared by the OpenClaw trigger and the dry-run generator.
// The MCP context is already sanitised by expose.ts: only legal stats and qualitative facts survive.
import { exposeEvent, exposeFacts, exposeMinute, exposeState, type ExposedEvent, type ExposedFact, type ExposedState } from './expose';
import { labelTeams, teamLabelLine } from './labels';
import type { MatchMemory } from './memory';

export const ANALYST_SYSTEM = `You are the TacticLens analyst: a concise TV pundit texting a friend about a live football match.
You receive rule-computed TacticLens data and qualitative tactical facts. Talk about the pattern and its consequence.

Hard rules:
- You are a live match analyst watching the game. NEVER mention or allude to images, JPEG/JPG/PNG, snapshots, screenshots, photos, pictures, frames, annotations, rings, tracker ids, files, attachments, tools, the bridge, memory, JSON, data, payloads, stats feeds or how you got the information. Never write "as seen in the image", "the attached snapshot", "the data shows", "according to the tool" or similar. Any visual is an optional aid the system may attach by itself: your text must read perfectly without it.
- Name the teams ONLY by their jersey-colour labels from teamLabels, exactly as written: "Team Red", "Team Yellow". Never write "Team A", "Team B", the letters A or B for a side, "A side", a club name or any other colour word. The A/B keys in the data are internal: map them through teamLabels (every event and fact carries its teamLabel). If teamLabels is absent, use teamNames exactly as given.
- Ground every claim in the supplied tool data. Never invent numbers, players, shots, xG or context.
- 2-3 sentences, maximum ~45 words.
- Describe the pattern: who is pressing, where the space is, who is dominating, and what it forces the other team to do.
- At most ONE number per update, and only possession %, passes, shots or turnovers. Never quote tempo, momentum scores, free-player counts or confidences.
- When includeStatLine is false, use NO numbers at all: describe dominance qualitatively ("Team Red are dominating possession"). When it is true, use the one supplied statLine category only.
- Never quote a video timestamp. Say "just now", "in the last minute" or "this spell" instead.
- Do not repeat the main subject or angle of your previous 3 updates. The context lists avoidAngles; treat every listed angle as banned and choose a different pattern, or reply SKIP.
- When includeStatLine is true, append the supplied statLine text (one category only).
- If nothing meaningful changed since your previous update, reply exactly SKIP and nothing else.
- No greetings, no emoji, no markdown headings, no hashtags.
- Each trigger carries a triggerId and triggeredAt. An update EXPIRES 60 s after triggeredAt: if it is later than that when you start, or record_update answers STALE, send nothing. Always pass triggerId to record_update.
- For a user question, answer in at most 4 sentences from the same data; if the data cannot answer it, say what is not measured.
- You may ask TacticLens to show one graphic with request_graphic when it makes the pattern clearer.`;

export interface ContextOpts {
  updateNumber: number;
  includeStatLine: boolean;
  chatId?: string;
  snapshotPath?: string | null;
  triggerId?: string;
  triggeredAt?: number;
}

export interface AnalystContext extends ExposedState {
  eventsSinceLastUpdate: ExposedEvent[];
  facts: ExposedFact[];
  avoidAngles: string[];
  memory: {
    minutes: Array<Record<string, unknown>>;
    previousUpdates: Array<{ text: string; skipped: boolean }>;
    meaningfulSinceLastUpdate: boolean;
  };
  snapshotAvailable: boolean;
  updateNumber: number;
  includeStatLine: boolean;
}

const ANGLE_RULES: Array<[RegExp, string]> = [
  [/press|pressing|pressured|squeez/i, 'pressing'],
  [/overload/i, 'overload'],
  [/switch|opposite flank|far post/i, 'switch of play'],
  [/wide|flank|winger|touchline/i, 'wide play'],
  [/space|pocket|between the lines|half-space/i, 'space between the lines'],
  [/counter/i, 'counter-attack'],
  [/low block|deep block|parked/i, 'low block'],
  [/midfield|engine room|pivot/i, 'midfield control'],
  [/turnover|gave the ball away|lost possession/i, 'turnovers'],
  [/tempo|rhythm/i, 'tempo'],
  [/build-up|build up|playing out/i, 'build-up'],
  [/set.?piece|corner|free.?kick|throw.?in/i, 'set pieces'],
  [/marking|man.?mark|tightly marked/i, 'marking'],
  [/fatigue|tired|leggy/i, 'fatigue'],
  [/isolat|one.?v.?one|1v1/i, 'isolation'],
];

/** Coarse subjects used to ban repetition without another model call. */
export function anglesOf(text: string): string[] {
  const out: string[] = [];
  for (const [re, angle] of ANGLE_RULES) if (re.test(text)) out.push(angle);
  return out;
}

export function buildAnalystContext(memory: MatchMemory, o: ContextOpts): AnalystContext | null {
  const s = memory.latest;
  if (!s) return null;
  const lastSent = [...memory.updates].reverse().find((u) => !u.skipped);
  const sinceT = lastSent ? lastSent.t : s.t - 90;
  const live = exposeState(s, o.includeStatLine);
  const labels = memory.teamLabels;
  const previous = memory.updates.filter((u) => !u.skipped).slice(-3);
  const avoidAngles = [...new Set(previous.flatMap((u) => anglesOf(u.text)))];
  return {
    ...live,
    facts: exposeFacts(s.facts, labels),
    avoidAngles,
    eventsSinceLastUpdate: memory.eventsSince(sinceT).map((e) => exposeEvent(e, labels)).filter((e): e is ExposedEvent => e !== null),
    memory: {
      minutes: o.includeStatLine
        ? memory.minutes.slice(-10).map(exposeMinute).filter((m) => Object.keys(m).length > 0)
        : [],
      previousUpdates: memory.updates.slice(-6).map((u) => ({ text: labelTeams(u.text, labels), skipped: u.skipped })),
      meaningfulSinceLastUpdate: memory.meaningful(),
    },
    snapshotAvailable: !!(o.snapshotPath ?? memory.snapshot?.path),
    updateNumber: o.updateNumber,
    includeStatLine: o.includeStatLine,
  };
}

/** Message for POST /hooks/agent. The skill carries the persona; this carries the run-specific facts. */
export function buildTriggerMessage(memory: MatchMemory, o: ContextOpts): string {
  const c = buildAnalystContext(memory, o);
  const chat = o.chatId || '<TELEGRAM_CHAT_ID>';
  const labelLine = teamLabelLine(memory.teamLabels);
  const lines = [
    `TacticLens live update #${o.updateNumber}.`,
    ...(o.triggerId && o.triggeredAt !== undefined
      ? [
        `Trigger id: ${o.triggerId}. Triggered at: ${new Date(o.triggeredAt).toISOString()}.`,
        'This update EXPIRES 60 s after triggeredAt: if it is later than that when you start, or if record_update answers STALE, send NOTHING and stop; always pass triggerId to record_update.',
      ]
      : []),
    `Telegram chat id: ${chat}`,
    `Include the compact stat line: ${o.includeStatLine ? 'yes' : 'no'} (one category only).`,
    `Avoid these recent angles: ${c?.avoidAngles.length ? c.avoidAngles.join(', ') : 'none'}.`,
    ...(labelLine ? [labelLine] : []),
    'Write as a live match analyst. Never mention images, snapshots, frames, tools, memory, JSON, data or how you know what you know.',
    '',
    'Workflow:',
    `1. Call get_live_state({includeStats:${o.includeStatLine}}), get_events_since (t is optional) and get_match_memory({includeStats:${o.includeStatLine}}).`,
    `2. Write 2-3 sentences, maximum ~45 words, following the tacticlens-analyst skill. ${o.includeStatLine ? 'Append the one supplied stat line.' : 'Use no numbers at all.'}${memory.teamLabels ? ` Name the teams only as "${memory.teamLabels.A}" and "${memory.teamLabels.B}".` : ''}`,
    '3. If nothing meaningful changed, reply exactly SKIP, call record_update with {"text":"SKIP","skipped":true,"triggerId":"<trigger id above>"}, and send nothing to Telegram.',
    '4. Otherwise call record_update with {"text":"<your update>","triggerId":"<trigger id above>"}. It returns the final "text" with the team labels enforced and any media wording removed. If it comes back empty, skipped, or STALE, send nothing.',
    '5. Send exactly one Telegram message with the message tool, using that returned text unchanged, as text only:',
    `   action=send, channel=telegram, to=${chat}, message=<returned text>.`,
    'Do not attach or add any media yourself. Do not ask the user a question. Do not send a second message.',
    '',
    c ? `Context: ${JSON.stringify(c)}` :'No state is available yet: reply SKIP and call record_update.',
  ];
  return lines.join('\n');
}

/** Plain chat-completions messages for `pnpm bridge --dry` (no OpenClaw, no Telegram). */
export function buildDryRunMessages(memory: MatchMemory, o: ContextOpts): Array<{ role: 'system' | 'user'; content: string }> {
  const c = buildAnalystContext(memory, o);
  const user = c
    ? [
      `Write proactive update #${o.updateNumber}.`,
      `includeStatLine=${o.includeStatLine}.`,
      `Avoid these recent angles: ${c.avoidAngles.length ? c.avoidAngles.join(', ') : 'none'}.`,
      teamLabelLine(memory.teamLabels),
      o.includeStatLine ? `statLine=${c.statLine}` : '',
      'Data:',
      JSON.stringify(c),
    ].filter(Boolean).join('\n')
    : 'No match state is available. Reply exactly SKIP.';
  return [{ role: 'system', content: ANALYST_SYSTEM }, { role: 'user', content: user }];
}

/**
 * Append-only analyst conversation. The system prompt and every earlier turn stay byte-identical, so the
 * provider's prefix cache keeps hitting; each new turn only appends a tiny trigger (state delta) at the end.
 * Oldest whole turns are dropped only when the thread is long (one deliberate cache miss).
 */
export class AnalystThread {
  private turns: Array<{ user: string; assistant: string | null }> = [];
  constructor(private maxTurns = 12) {}

  /** Messages for the next call: system, all earlier turns unchanged, then the new tiny trigger last. */
  next(memory: MatchMemory, o: ContextOpts): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const first = this.turns.length === 0;
    let user: string;
    if (first) {
      user = buildDryRunMessages(memory, o)[1]!.content;
    } else {
      const c = buildAnalystContext(memory, o);
      if (!c) user = 'No match state is available. Reply exactly SKIP.';
      else {
        // The earlier turns already hold the minutes and the previous updates: send only what changed.
        const { memory: _m, ...delta } = c;
        user = [
          `Update #${o.updateNumber}. includeStatLine=${o.includeStatLine}.`,
          `Avoid: ${c.avoidAngles.length ? c.avoidAngles.join(', ') : 'none'}.`,
          teamLabelLine(memory.teamLabels),
          o.includeStatLine ? `statLine=${c.statLine}` : '',
          `Delta: ${JSON.stringify({ ...delta, meaningful: c.memory.meaningfulSinceLastUpdate })}`,
        ].filter(Boolean).join('\n');
      }
    }
    const msgs: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [{ role: 'system', content: ANALYST_SYSTEM }];
    for (const t of this.turns) {
      msgs.push({ role: 'user', content: t.user });
      if (t.assistant !== null) msgs.push({ role: 'assistant', content: t.assistant });
    }
    msgs.push({ role: 'user', content: user });
    this.turns.push({ user, assistant: null });
    return msgs;
  }

  /** Record the reply to the last trigger. */
  commit(reply: string): void {
    const last = this.turns[this.turns.length - 1];
    if (last && last.assistant === null) last.assistant = reply;
    while (this.turns.length > this.maxTurns) this.turns.shift();
  }

  get length(): number { return this.turns.length; }
}
