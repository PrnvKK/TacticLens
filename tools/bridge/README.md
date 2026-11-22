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

## Optional setup

The bridge is optional. You do not need it to run the extension or the tests. If you use it, set these in the
repo-root `.env` (see `.env.example`; never commit real values):

- `BRIDGE_TOKEN`: shared secret for the bridge routes; the extension build and the bridge must use the same value
- `BRIDGE_URL`: where the extension reaches the bridge
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`: Telegram ping destination (optional)
- `OPENCLAW_HOOK_URL`, `OPENCLAW_HOOK_TOKEN`, `OPENCLAW_AGENT_ID`: OpenClaw agent hook (optional)
- `CEREBRAS_API_KEY`: used by `pnpm bridge:dry` (optional)
