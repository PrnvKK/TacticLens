# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private
vulnerability reporting from the repository's **Security** tab
(**Report a vulnerability**) so the report stays private while it is triaged.

Include the affected version or commit, the platform and browser, reproduction
steps, and the impact you expect. Do not include real API keys, bot tokens,
Telegram chat IDs, or private match footage in the report; redact them.

## Secrets

TacticLens reads `CEREBRAS_API_KEY`, `BRIDGE_TOKEN`, `TELEGRAM_BOT_TOKEN` and
related values from a local `.env` that is gitignored. The extension stores the
Cerebras key in `chrome.storage.local` and only the background worker reads it.
If you believe a key was committed or exposed, revoke it with the provider
first, then rotate the value in `.env`.

## Scope

The bridge binds to loopback only and is intended for local use. Do not expose
it to a network or the public internet. The pretrained model weights and
third-party services (Cerebras, Telegram, OpenClaw) are outside this project's
security scope; report issues in those components to their maintainers.
