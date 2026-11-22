# Record and replay

```
pnpm replay fixtures/<x>.jsonl [--frames] [--events N] [--json]   # replay a session through the engine
pnpm replay:gen                                                   # regenerate the synthetic fixtures
pnpm --filter core test                                           # Vitest assertions on the fixtures
```

`pnpm replay` runs Node 24 with type stripping plus a resolve hook (`register.mjs`), so no extra dependency is needed.
If the file has `raw` detections it re-runs the tracking layers (ByteTrackLite, TeamAssigner, SceneAnalyzer or scene hints,
BallTracker) and then the engine. Without raw it starts at `FrameState`. `--frames` forces the recorded `FrameState`
even when raw is present. Output: possession %, scene timeline, ball visible/searching/absent %, liveness shares, the
event list and a summary.

## Session JSONL (version 1)

One JSON object per line. Numbers rounded to 4 decimals. Unknown `kind`s are skipped by the reader.

Line 1, the header:

```json
{"kind":"header","version":1,"source":"extension","createdAt":"2026-11-21T10:05:00Z","hz":8,"hasRaw":true,
 "video":{"name":"footage.mp4","w":1280,"h":720,"durationS":90},"meta":{"detector":"yolo..","quality":"Q0"}}
```

Every following line, one perception cycle:

```json
{"kind":"frame",
 "frame": { ...FrameState as in core/src/types.ts... },
 "raw":   { "persons":[{"cls":"player","score":0.91,"box":[x1,y1,x2,y2]}],
            "labs":[[L,a,b], null],
            "ballCands":[{"xy":[x,y],"score":0.8}],
            "thumb":"<base64 of 64x36 RGBA = 9216 bytes>",
            "scene":{"kind":"WIDE","confidence":0.9,"cut":false} } }
```

- `frame` is the brain output of that cycle (`FrameState`). If `raw` is present, `frame` may be only the clocks:
  `{t, tMedia, playbackRate, quality, frameIdx}`.
- `raw` is optional. Replay re-runs the tracking layers from it: `persons` are the decoded person detections (normalised boxes),
  `labs[i]` the torso Lab sample for `persons[i]` (null when unsampled), `ballCands` the ball candidates,
  `thumb` the exact 64x36 RGBA grid fed to `SceneAnalyzer` (when absent, `scene` is used as a hint: `cut` marks a camera cut).
- `t` is video time, `tMedia` the frame media time. Coordinates are normalised to the video.
- All frames of a file are either all full or all raw-carrying (mixed files are rejected).

Recording from the extension: use `SessionRecorder` from `core/src/replay` (`new SessionRecorder(line => ..., {source:'extension', hz})`,
then `rec.push(frameState, raw?)` once per cycle). It has no DOM or fs dependency; the extension decides where lines go
(array, Blob, download). `parseSession(text)` reads it back, `serializeSession(header, frames)` writes whole files.

## Labels

`fixtures/<name>.labels.json` holds ground truth for assertions (type `SessionLabels`): `possession {A,B}` (percent of
credited time, excluding replay, close-up, ball-absent and calibration), `turnovers [{t,to}]`, `absent`, `replay`, `close`
(`[t0,t1]` windows in video seconds) and `calibratedAtS`. For real clips, label by hand in the same shape.

## Synthetic fixtures

`core/src/replay/synth.ts` (seeded, deterministic): 22 players in two 4-4-2 teams (goalkeepers included), a referee, a ball
passed player to player, scheduled turnovers, ball-absent gaps, a replay segment (different layout, ball flipping teams,
to catch any leak) and a close-up. Fixtures: `synth-a-dominant` (frames), `synth-balanced` (frames, two gaps, replay,
close-up), `synth-raw-b-dominant` (raw detections: exercises tracker, team assigner and ball tracker).
`pnpm replay:gen` rewrites them and a test fails if the committed files drift from the generator.
