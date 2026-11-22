# Contributing

Thanks for taking a look at TacticLens. This is a hackathon project, so the
fastest path to a useful contribution is a small, focused pull request.

## Before you start

- Read the [README](README.md) and [architecture notes](docs/ARCHITECTURE.md).
- For a bug, open an issue with the browser version, the clip type (broadcast,
  game or auto), and what the overlay or engine did.
- For a security issue, follow [SECURITY.md](SECURITY.md) instead of opening a
  public issue.
- Do not commit API keys, bot tokens, chat IDs, exported model weights, or
  match footage you do not have the rights to.

## Development

Requirements: Node 22 or newer, pnpm, and Chrome with WebGPU. The tests and
replay tools do not need an API key or the ONNX models.

```sh
pnpm i
pnpm test
pnpm typecheck
pnpm lint
pnpm replay fixtures/synth-balanced.jsonl
```

Building the extension needs the three ONNX files described in
[models/README.md](models/README.md). Live commentary needs a Cerebras API key
and `CEREBRAS_KIMI_MODEL` in `.env`.

## Pull requests

- Keep the code style and module boundaries of the surrounding code.
- Add or update a test for engine, tracking, director or bridge changes.
- Run `pnpm test`, `pnpm typecheck` and `pnpm lint` before opening the PR.
- Describe the change, how you verified it, and any new configuration or
  third-party asset. Screenshots or a short clip help for overlay changes.

## Licence

By contributing, you agree that your contribution is licensed under the
project's [MIT License](LICENSE).
