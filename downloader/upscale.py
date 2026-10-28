#!/usr/bin/env python3
"""AI upscaling with Real-ESRGAN (realesr-general-x4v3), for stills, images and video.

Run with the ML venv's python (onnxruntime-gpu, numpy, opencv). Used as a module
by parallax.py (upscaling a still before the cut-out) and interpolate.py (video
frames), and from the command line for Stash images:

  upscale.py INPUT OUTPUT --models DIR [--factor 2|4]
  upscale.py --batch LIST.json --models DIR [--factor 2|4]    (LIST: [[input, output], ...])

The model always upscales 4x; 2x is its result scaled down by half (sharper than
a 2x model would be). --strength below 1 mixes the result with a plain (bicubic)
enlargement: the model smooths skin into a "painted" look, and some of the plain
enlargement keeps its texture while edges stay crisp. NATURAL is the default. Big inputs go through in overlapping tiles so they fit in
the GPU's memory. Prints {"file": i, "total": n} after each file of a batch and
{"done": true, "width": w, "height": h} when finished.
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parallax import session  # noqa: E402  (shared ONNX session setup: GPU when available)

UPSCALE_FILE = "realesr-general-x4v3.onnx"
NATURAL = 0.6  # default strength
TILE = 512  # input pixels per tile side
OVERLAP = 16  # input pixels of context around each tile, cut off afterwards


def _run(sess, img):
    x = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32).transpose(2, 0, 1)[None] / 255
    y = sess.run(None, {sess.get_inputs()[0].name: x})[0][0].transpose(1, 2, 0)
    return cv2.cvtColor((np.clip(y, 0, 1) * 255).astype(np.uint8), cv2.COLOR_RGB2BGR)


def upscale(img, factor, models_dir, strength=NATURAL, size=None):
    """img (BGR uint8) upscaled by factor (2 or 4), or to size (w, h) from one 4x
    pass (e.g. 720p to 4K: better than two 2x passes, which build on their own
    invented detail); strength 1 is the model alone."""
    sess = session(os.path.join(models_dir, UPSCALE_FILE))
    h, w = img.shape[:2]
    if h * w <= TILE * TILE * 1.5:
        out = _run(sess, img)
    else:
        out = np.zeros((h * 4, w * 4, 3), np.uint8)
        for y in range(0, h, TILE):
            for x in range(0, w, TILE):
                # the tile plus context on each side, run, then the context cut off
                y0, x0 = max(0, y - OVERLAP), max(0, x - OVERLAP)
                y1, x1 = min(h, y + TILE + OVERLAP), min(w, x + TILE + OVERLAP)
                up = _run(sess, img[y0:y1, x0:x1])
                th, tw = min(TILE, h - y), min(TILE, w - x)
                oy, ox = (y - y0) * 4, (x - x0) * 4
                out[y * 4:(y + th) * 4, x * 4:(x + tw) * 4] = up[oy:oy + th * 4, ox:ox + tw * 4]
    if size:
        out = cv2.resize(out, size, interpolation=cv2.INTER_AREA if size[0] < w * 4 else cv2.INTER_CUBIC)
    elif factor == 2:
        out = cv2.resize(out, (w * 2, h * 2), interpolation=cv2.INTER_AREA)
    if strength < 1:
        plain = cv2.resize(img, (out.shape[1], out.shape[0]), interpolation=cv2.INTER_CUBIC)
        out = cv2.addWeighted(out, strength, plain, 1 - strength, 0)
    return out


def upscale_file(src, dst, factor, models_dir, strength=NATURAL):
    img = cv2.imread(src, cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit("cannot read %s" % src)
    out = upscale(img, factor, models_dir, strength)
    params = [cv2.IMWRITE_JPEG_QUALITY, 95] if dst.lower().endswith((".jpg", ".jpeg")) else []
    if not cv2.imwrite(dst, out, params):
        raise SystemExit("cannot write %s" % dst)
    return out.shape[1], out.shape[0]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("input", nargs="?")
    ap.add_argument("output", nargs="?")
    ap.add_argument("--models", required=True)
    ap.add_argument("--factor", type=int, choices=[2, 4], default=2)
    ap.add_argument("--batch", help="a JSON list of [input, output] pairs")
    ap.add_argument("--strength", type=float, default=NATURAL, help="1 = the model alone; lower keeps more texture")
    args = ap.parse_args()
    if args.batch:
        with open(args.batch) as f:
            pairs = json.load(f)
        for i, (src, dst) in enumerate(pairs):
            w, h = upscale_file(src, dst, args.factor, args.models, args.strength)
            print(json.dumps({"file": i + 1, "total": len(pairs)}), flush=True)
    else:
        w, h = upscale_file(args.input, args.output, args.factor, args.models, args.strength)
    print(json.dumps({"done": True, "width": w, "height": h}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        if isinstance(e.code, str):
            print(json.dumps({"error": e.code}), flush=True)
            sys.exit(1)
        raise
