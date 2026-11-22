# Changelog

All notable changes to TacticLens are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-22

First public release, built for the Cerebras x Kimi x OpenClaw 2026 hackathon.

### Added

- Chrome MV3 extension (WXT + Preact) with a Theatre page that plays a local
  match clip and draws the live overlay over it.
- In-browser perception: YOLO11n ONNX detectors for players and the ball via
  ONNX Runtime Web on WebGPU, with tracking, team assignment, shot
  classification and ball re-acquisition.
- Pure TypeScript engine (`core/`) for possession, passes, pressing,
  overloads, formations, match events, confidence gates and match statistics.
- Kimi director on Cerebras: the engine exposes only currently valid graphics
  and facts, and Kimi chooses what to show and writes the commentary. Every
  decision is validated against the menu; a rule fallback keeps the overlay
  alive when the director leaves it empty.
- Live commentary side chat, on-screen analyst cards, pause-and-ask about the
  match, and an optional annotated-frame vision lane.
- Local bridge (`tools/bridge`) that sends live Telegram pings and exposes the
  match to an OpenClaw analyst over six MCP tools, including
  `request_graphic`. Pings pause during replays, close-ups, pauses, half-time
  and long ball absence.
- OpenClaw setup guide, config template and `tacticlens-analyst` skill.
- Replay tooling, synthetic fixtures with ground-truth labels, model export
  script, and calibration/soak scripts for the LLM lanes.
- Unit and integration suites across the engine, extension and bridge, plus
  typecheck and dependency-boundary checks.

### Known limitations

- No match clip ships with the repository; use footage you have the rights to.
- The ball-detector weights are no longer hosted upstream. Supply your own
  single-class YOLO11n ball `best.pt` before exporting the ONNX models.
- Live commentary requires a Cerebras API key and the Kimi model id for your
  account. The tests and replay tools work offline.
- The pretrained detector weights are third-party and are not covered by this
  project's MIT licence; see [Models and third-party licences](README.md#models-and-third-party-licences).

[0.1.0]: https://github.com/PrnvKK/TacticLens/releases/tag/v0.1.0
