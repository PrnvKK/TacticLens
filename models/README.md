# Models

The extension runs three pretrained YOLO11n detectors in the browser via ONNX Runtime Web. No training was done; weights are third-party and are never committed (`weights/` and `onnx/` are gitignored).

| File in `onnx/` | Input | Classes | Role |
|---|---|---|---|
| `soccana_640.onnx` | 640 | player, ball, referee | Main detector ([Adit-jain/soccana](https://huggingface.co/Adit-jain/soccana)) |
| `yolo11n_soccernet_ball_640.onnx` | 640 | ball | Ball search on a 640 crop around the predicted position (`bambezius/yolo11n-soccernet-ball`, no longer on Hugging Face, see below) |
| `yolo11n_soccernet_ball_1280.onnx` | 1280 | ball | Full-frame ball re-acquire (same weights) |

## Build the ONNX files

Tested with Python 3.12 on Windows (ultralytics 8.4, onnx 1.23, onnxslim 0.1, huggingface_hub 2.4). From the repo root:

```
python -m venv models/.venv
models/.venv/Scripts/activate        # Linux/macOS: source models/.venv/bin/activate
pip install -r models/requirements.txt
python models/export_onnx.py         # --out DIR, --weights DIR, --force
```

The script downloads the two `.pt` files into `models/weights/` (about 16 MB total) and exports static-shape, fp32, opset 17, `nms=False`, simplified ONNX into `models/onnx/`. Existing outputs are skipped unless `--force`, and a `.pt` already present at the expected path is used instead of downloading.

**Ball weights are no longer downloadable.** The `bambezius/yolo11n-soccernet-ball` repo returned HTTP 401 on 2026-11-22, so the script stops at that download. The `soccana` detector still downloads normally. To build the two ball files, place a single-class YOLO11n ball detector at `models/weights/yolo11n-soccernet-ball/best.pt` and rerun. The extension build needs all three ONNX files.

## Tensor layout

Input `[1, 3, S, S]`: RGB, `/255`, letterboxed with pad value 114. Output `[1, 4+nc, N]`: `cx, cy, w, h`, then `nc` class scores (no NMS in the graph; decode and NMS in JS).

## Licences

Both models are ultralytics-derived, so treat them as AGPL-3.0. The soccana repo states no licence and the ball model's SoccerNet training data has its own terms. Fine for research and demos; check before redistributing the weights.

## Why these three

Measured on 30 stills from one 1280x720 match video (CPU onnxruntime; not WebGPU timings; frames not ground-truthed, so "ball hits" counts frames with at least one ball box, not recall).

| Candidate | ms/frame | Ball hits /30 | Verdict |
|---|---|---|---|
| soccana 640 | 224 | 5 | Chosen: ~16 players/frame, noisy referee class |
| soccana 1280 | 889 | 10 | Better recall, too slow for the default path |
| yolo11n SoccerNet ball 1280 | 907 | 18 | Chosen: best ball recall, mostly true balls |
| yolo11n SoccerNet ball 640 | 314 | 4 | Too weak on full frames; used only on crops |
| yolo11n COCO 640 | 264 | 0 | Rejected: never found the ball |
