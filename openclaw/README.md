# TacticLens on Telegram (OpenClaw)

TacticLens texts you a tactical read of the match you are watching, with an annotated snapshot, and
answers your questions in Telegram. The analyst is an OpenClaw agent on Kimi via Cerebras.

```
Theatre tab ──POST /state, /snapshot──▶ local bridge 127.0.0.1:8787
                                          │  10 s live-play scheduler
                                          ├─ default: forward Theatre line ──▶ Telegram
                                          └─ questions / BRIDGE_PING_MODE=agent ──▶ OpenClaw ──▶ Telegram
                                              │
                                              └──GET /commands──▶ Theatre (director validator + calm gate)
```

Official docs used:

- Cerebras provider: <https://docs.openclaw.ai/providers/cerebras>
- MCP servers (Streamable HTTP, headers): <https://docs.openclaw.ai/tools/mcp>
- Telegram setup and pairing: <https://docs.openclaw.ai/channels/telegram/setup>
- Inbound webhook `POST /hooks/agent`: <https://docs.openclaw.ai/automation/cron-jobs/webhooks>
- Skills: <https://docs.openclaw.ai/tools/skills>
- Custom providers / config tools: <https://docs.openclaw.ai/gateway/config-tools>

Why the bridge schedules instead of an OpenClaw automation: Automations are excellent for wall-clock
schedules, but an update is due after ~10 seconds of *live play* and must stop during replays, close-ups,
pauses, half-time and long ball-absence. Only the extension knows that. The bridge counts live seconds and
either forwards the line already visible in the Theatre side chat (default, no extra model call) or calls
OpenClaw's documented inbound webhook (`POST /hooks/agent`) when `BRIDGE_PING_MODE=agent`. The MCP server is
Streamable HTTP so there is one process and one source of truth (no extra stdio child).

## What you need

- Windows 10/11, macOS or Linux, Node 22+ and pnpm
- Chrome (or Chromium) and a local football video file
- A Cerebras API key and a Telegram account

## 1. Install OpenClaw

Official installer (from the OpenClaw docs):

```powershell
# Windows PowerShell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

```bash
# macOS / Linux / WSL2
curl -fsSL https://openclaw.ai/install.sh | bash
```

Then install the Cerebras provider and authenticate (docs: `/providers/cerebras`):

```bash
openclaw plugins install @openclaw/cerebras-provider
openclaw onboard --auth-choice cerebras-api-key
openclaw models list --provider cerebras
```

## 2. Create the Telegram bot

1. In Telegram chat with **@BotFather** (or its web app), run `/newbot`, pick a name and handle, and copy
   the bot token.
2. Put the token in OpenClaw (docs: `/channels/telegram/setup`):

   ```bash
   openclaw channels add --channel telegram --token <bot-token>
   ```

   or set `TELEGRAM_BOT_TOKEN` in `~/.openclaw/.env` (default account only).
3. DM your new bot once, then approve the pairing:

   ```bash
   openclaw pairing list telegram
   openclaw pairing approve telegram <CODE>
   ```

4. Get your numeric chat id from `openclaw logs --follow` after DMing the bot, or from
   `https://api.telegram.org/bot<token>/getUpdates` (do not paste the token into a shared terminal).
   This is the `TELEGRAM_CHAT_ID` the bridge passes to the agent.

## 3. Fill the environment

Copy `.env.example` to `.env` in the repository root and fill it:

| Variable | Used by | Purpose |
| --- | --- | --- |
| `CEREBRAS_API_KEY` | bridge dry run, OpenClaw | Cerebras auth |
| `CEREBRAS_KIMI_MODEL` | extension build, dry run | Kimi model id; blank = `gpt-oss-120b` |
| `BRIDGE_TOKEN` | bridge + extension + OpenClaw | shared secret; generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `TELEGRAM_CHAT_ID` | bridge | chat the update is sent to |
| `OPENCLAW_HOOK_TOKEN` | bridge + OpenClaw hooks | dedicated webhook secret |
| `OPENCLAW_HOOK_URL` | bridge | default `http://127.0.0.1:18789/hooks/agent` |

OpenClaw does not read the project `.env`. Put the same values it needs in `~/.openclaw/.env`
(or the Gateway service environment): `CEREBRAS_API_KEY`, `TELEGRAM_BOT_TOKEN`, `BRIDGE_TOKEN`,
`OPENCLAW_HOOK_TOKEN`. `BRIDGE_TOKEN` and `OPENCLAW_HOOK_TOKEN` **must match** the project values.

Never commit `.env`; it is gitignored. The bridge and extension never print secret values.

## 4. Build the extension

```bash
pnpm install
pnpm build
```

Load `extension/.output/chrome-mv3` as an unpacked extension at `chrome://extensions` (Developer mode).
The build injects `BRIDGE_TOKEN` and `BRIDGE_URL`; rebuild after changing either.

## 5. Start the bridge

Start this before OpenClaw so the MCP endpoint is reachable:

```bash
pnpm bridge
```

It binds `127.0.0.1:8787` only and logs `POST /state 200`, `POST /mcp 200`, etc. Snapshots are written to
`.snapshots/` (gitignored) and exposed to the agent as a file path plus image content.

Quick health check (no token needed; no data is returned):

```bash
curl http://127.0.0.1:8787/health
```

## 6. Configure OpenClaw

Merge `openclaw/openclaw.json5` into `~/.openclaw/openclaw.json`:

- Set `agents.defaults.model.primary` to `cerebras/<CEREBRAS_KIMI_MODEL>` when you use a custom Kimi id;
  the template uses the documented `cerebras/gpt-oss-120b` fallback. Or let the env decide:

  ```powershell
  $model = if ($env:CEREBRAS_KIMI_MODEL) { $env:CEREBRAS_KIMI_MODEL } else { 'gpt-oss-120b' }
  openclaw config set agents.defaults.model.primary "cerebras/$model"
  ```

  ```bash
  openclaw config set agents.defaults.model.primary "cerebras/${CEREBRAS_KIMI_MODEL:-gpt-oss-120b}"
  ```
- Replace `<YOUR_TELEGRAM_USER_ID>` in `channels.telegram.allowFrom`.
- `hooks.token` is `${OPENCLAW_HOOK_TOKEN}`; `mcp.servers.tacticlens.headers.Authorization` is
  `Bearer ${BRIDGE_TOKEN}`.

Validate and restart:

```bash
openclaw config validate
openclaw gateway restart
openclaw mcp doctor tacticlens --probe
```

The doctor probe must list the six tools: `get_live_state`, `get_events_since`, `get_match_memory`,
`get_latest_snapshot`, `request_graphic`, `record_update`.

Install the analyst skill (docs: `/tools/skills`):

```bash
openclaw skills install ./openclaw/skills/tacticlens-analyst --global
openclaw skills list
```

## 7. Watch a match

1. Open the Theatre (`chrome-extension://<extension-id>/theatre.html`), drop a video, press play.
2. Enable the bridge: append `?bridge=1` to the Theatre URL, **or** open the toolbar popup and tick
   **Telegram live bridge**. The toggle is stored in `chrome.storage.local` and applies to open tabs.
3. After 10 seconds of live play the bridge sends the first ping. By default it forwards the latest line
   already shown in the Theatre side chat, so Telegram mirrors the screen with no extra model call. Set
   `BRIDGE_PING_MODE=agent` if you want OpenClaw to write each proactive update instead. Pings stop during
   replay/close-up/pause/ball-absence.
4. Reply in Telegram with a question. The agent answers from the same live tools, in at most 4 sentences,
   and may request a validated on-screen graphic.

## Dry run (no Telegram, no OpenClaw)

```bash
pnpm bridge:dry
# equivalent: pnpm bridge --dry
```

This replays `tools/bridge/fixtures/synth-balanced.recorded.json` (recorded through the real engine) through
the same analyst prompt, generates three updates 20 s apart against Cerebras, and prints latency and text.
It never contacts Telegram. Use `--gap-ms 0` for a fast check, `--fixture <path>` for another recording.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `401 unauthorized` in the bridge log | `BRIDGE_TOKEN` differs between `.env` and the extension build; rebuild after changing it |
| `openclaw mcp doctor` cannot connect | bridge is running; URL is `http://127.0.0.1:8787/mcp`; `transport: "streamable-http"`; bearer header present |
| `404` from the hook | `hooks.enabled`, `hooks.path`, and the URL (`/hooks/agent`) |
| No Telegram messages | bot paired; `TELEGRAM_CHAT_ID` correct; `openclaw channels status --probe`; agent logs |
| Telegram pings are text only | default `BRIDGE_PING_MODE=commentary` mirrors the on-screen line; set `BRIDGE_PING_MODE=agent` to send OpenClaw's snapshot media |
| Agent sends text without the image | snapshot path missing: watch live for ~30 s; `.snapshots/` writable |
| Updates never trigger | Theatre has `?bridge=1` (or popup toggle); state is LIVE/WIDE and the ball is present |
| Graphic never appears | expected if the calm gate or on-screen graphic blocks it; the ack reason is in the bridge log |

## Security notes

- The bridge binds loopback only and every data/tool route needs the shared bearer token.
- Hook tokens and bot tokens live only in env files; the skill and config templates contain references.
- `get_latest_snapshot` returns the current video frame plus the overlay. Only enable the bridge when you
  are comfortable sending that frame to your model and your Telegram chat.
