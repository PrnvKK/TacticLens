"""Download the two pretrained YOLO11n weights and export the three ONNX files the extension needs.

Run from the repo root or from models/:  python models/export_onnx.py [--out DIR] [--weights DIR] [--force]
"""
import argparse
import shutil
from pathlib import Path

from huggingface_hub import hf_hub_download
from ultralytics import YOLO

HERE = Path(__file__).resolve().parent

# (HF repo, file in repo, [(output name, imgsz), ...])
MODELS = [
    ("Adit-jain/soccana", "Model/weights/best.pt", [("soccana_640", 640)]),
    ("bambezius/yolo11n-soccernet-ball", "best.pt",
     [("yolo11n_soccernet_ball_640", 640), ("yolo11n_soccernet_ball_1280", 1280)]),
]

ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
ap.add_argument("--out", type=Path, default=HERE / "onnx", help="ONNX output dir (default: models/onnx)")
ap.add_argument("--weights", type=Path, default=HERE / "weights", help="weights download dir (default: models/weights)")
ap.add_argument("--force", action="store_true", help="re-export files that already exist")
args = ap.parse_args()
args.out.mkdir(parents=True, exist_ok=True)

for repo, filename, exports in MODELS:
    todo = [(n, s) for n, s in exports if args.force or not (args.out / f"{n}.onnx").exists()]
    if not todo:
        print(f"skip {repo} (outputs exist)")
        continue
    pt = args.weights / repo.split("/")[1] / filename
    if not pt.exists():  # a weights file placed by hand is used as is
        pt = hf_hub_download(repo, filename, local_dir=args.weights / repo.split("/")[1])
    for name, size in todo:
        exported = YOLO(pt).export(format="onnx", opset=17, imgsz=size, nms=False,
                                   simplify=True, dynamic=False, half=False)
        shutil.move(exported, args.out / f"{name}.onnx")
        print("wrote", args.out / f"{name}.onnx")
