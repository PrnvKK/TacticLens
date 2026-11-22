# TacticLens bridge

Local, loopback-only state hub between the TacticLens extension and OpenClaw.

```bash
pnpm bridge          # from the repo root; HTTP + MCP on 127.0.0.1:8787
pnpm bridge:dry      # 3 recorded-fixture updates via Cerebras, no Telegram
```

- `POST /state` — compact match state, ~1/s from the Theatre
- `POST /snapshot` — JPEG (max 1280 px) of video + overlay, every ~30 s of live play
- `GET /commands`, `POST /commands/ack` — validated graphics requested by the agent
- `POST /mcp` — MCP Streamable HTTP (tools, no SDK)
- `GET /health` — unauthenticated liveness only

By default the 10 s live-play ping forwards the latest line from the Theatre side chat through the
Telegram Bot API, so it costs no extra model call. `BRIDGE_PING_MODE=agent` restores the OpenClaw
analyst as the proactive writer. Cadence and gap are configurable with `BRIDGE_CADENCE_MS` and
`BRIDGE_MIN_GAP_MS`.

All data/tool routes require `Authorization: Bearer $BRIDGE_TOKEN` (or `x-bridge-token`).
The server binds `127.0.0.1` and never logs the token.

The fixture is generated from a real engine replay:

```bash
node --no-warnings --experimental-transform-types --import ./tools/replay/register.mjs \
  tools/bridge/scripts/record-fixture.ts
```

## Setup

The bridge is optional: the extension and the tests run without it. Set these in the repo-root `.env` (see
`.env.example`; never commit real values), then rebuild the extension so it picks up the token:

- `BRIDGE_TOKEN`: shared secret for the bridge routes; the extension build and the bridge must use the same value
- `BRIDGE_URL`: where the extension reaches the bridge (default `http://127.0.0.1:8787`)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`: where pings are sent
- `OPENCLAW_HOOK_URL`, `OPENCLAW_HOOK_TOKEN`, `OPENCLAW_AGENT_ID`: how the bridge triggers the OpenClaw agent
- `CEREBRAS_API_KEY`, `CEREBRAS_KIMI_MODEL`: used by `pnpm bridge:dry`

### Telegram pings only

1. In Telegram, ask @BotFather for `/newbot` and copy the bot token. Message the bot once, then read your numeric
   chat id from `https://api.telegram.org/bot<token>/getUpdates`.
2. Fill `BRIDGE_TOKEN`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, rebuild (`pnpm build`) and run `pnpm bridge`.
3. Tick "Telegram live bridge" in the extension popup (or open the Theatre with `?bridge=1`) and play a clip.
   After about 10 s of live play the first ping arrives.

### OpenClaw analyst (questions, graphics, agent-written pings)

OpenClaw runs separately and does not read this repo's `.env`; give it the same secrets in `~/.openclaw/.env`
(`CEREBRAS_API_KEY`, `TELEGRAM_BOT_TOKEN`, `BRIDGE_TOKEN`, `OPENCLAW_HOOK_TOKEN`). `BRIDGE_TOKEN` and
`OPENCLAW_HOOK_TOKEN` must match the values here. Follow the OpenClaw docs for each piece:

1. Install OpenClaw, add the Cerebras provider and use `cerebras/<CEREBRAS_KIMI_MODEL>` as the agent's model.
2. Add the Telegram channel with your bot token and approve the pairing for your account.
3. Register the bridge as an MCP server: URL `http://127.0.0.1:8787/mcp`, transport `streamable-http`, header
   `Authorization: Bearer <BRIDGE_TOKEN>`. `openclaw mcp doctor <name> --probe` should list the six tools.
4. Enable the inbound webhook (`POST /hooks/agent`) with `OPENCLAW_HOOK_TOKEN`; `OPENCLAW_HOOK_URL` defaults to
   `http://127.0.0.1:18789/hooks/agent`.
5. Optional: `BRIDGE_PING_MODE=agent` makes OpenClaw write each proactive update instead of mirroring the screen.

Then message the bot a question while a clip plays; the agent answers from the live tools.
