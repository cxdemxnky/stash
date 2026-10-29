#!/usr/bin/env python3
"""Click-to-select segmentation with MobileSAM, for cutting elements out of a person layer.

Run with the ML venv's python (onnxruntime-gpu, numpy, opencv) as a long-lived worker:
the downloader starts it on the first click and keeps it while clicks keep coming.
Reads JSON lines on stdin, writes one JSON line per request on stdout:

  {"person": P, "background": B, "cache": C, "points": [[x, y, label], ...]}
      -> {"masks": [{"mask": "<base64 PNG>", "score": s, "area": fraction}, ...], "pick": i}

P is the cut's person layer (RGBA) and B its filled background: the person over the
background is the photo the model looks at. x, y are pixels of P; label 1 means
"this is part of it", 0 "this isn't". The image's embedding (the slow part, once per
cut) is kept in C (.npy). Masks are white where the element is, at P's size. One
click is ambiguous (the phone, the hand holding it, the whole person), so it gets the
model's three guesses, smallest first, and "pick" is the smallest it's fairly sure
of; more clicks get one mask.
"""
import base64
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parallax import session  # noqa: E402  (shared ONNX session setup: GPU when available)

ENCODER_FILE = "mobile_sam_image_encoder.onnx"
DECODER_FILE = "sam_mask_decoder_multi.onnx"
SIDE = 1024  # the encoder's input: longest side


def photo(person_path, bg_path):
    """The person layer over its background, as RGB float32 (the original photo, near enough)."""
    fg = cv2.imread(person_path, cv2.IMREAD_UNCHANGED)
    if fg is None:
        raise ValueError("cannot read %s" % person_path)
    bg = cv2.imread(bg_path, cv2.IMREAD_COLOR)
    rgb = fg[:, :, :3].astype(np.float32)
    if fg.shape[2] == 4 and bg is not None:
        bg = cv2.resize(bg, (fg.shape[1], fg.shape[0]), interpolation=cv2.INTER_AREA).astype(np.float32)
        a = fg[:, :, 3:4].astype(np.float32) / 255
        rgb = rgb * a + bg * (1 - a)
    return cv2.cvtColor(rgb, cv2.COLOR_BGR2RGB), fg.shape[1], fg.shape[0]


class Segmenter:
    def __init__(self, models):
        self.encoder = session(os.path.join(models, ENCODER_FILE))
        self.decoder = session(os.path.join(models, DECODER_FILE))
        self.loaded = None  # (cache path, embedding, w, h)

    def embedding(self, req):
        if self.loaded and self.loaded[0] == req["cache"]:
            return self.loaded[1:]
        img, w, h = photo(req["person"], req["background"])
        if os.path.exists(req["cache"]):
            emb = np.load(req["cache"])
        else:
            k = SIDE / max(w, h)
            small = cv2.resize(img, (round(w * k), round(h * k)), interpolation=cv2.INTER_AREA)
            emb = self.encoder.run(None, {"input_image": small})[0]
            np.save(req["cache"], emb)
        self.loaded = (req["cache"], emb, w, h)
        return emb, w, h

    def mask(self, req):
        emb, w, h = self.embedding(req)
        pts = req.get("points") or []
        if not pts:
            raise ValueError("no points")
        k = SIDE / max(w, h)
        coords = np.array([[[x * k, y * k] for x, y, _ in pts] + [[0, 0]]], np.float32)
        labels = np.array([[1 if lab else 0 for _, _, lab in pts] + [-1]], np.float32)  # -1: the "no box" padding point
        masks, scores, _ = self.decoder.run(None, {
            "image_embeddings": emb, "point_coords": coords, "point_labels": labels,
            "mask_input": np.zeros((1, 1, 256, 256), np.float32), "has_mask_input": np.zeros(1, np.float32),
            "orig_im_size": np.array([h, w], np.float32),
        })
        # outputs 1-3 are the one-click guesses; 0 is the answer for several clicks
        out = []
        for i in ([1, 2, 3] if len(pts) == 1 else [0]):
            m = masks[0, i] > 0
            area = float(m.mean())
            if area == 0 or any(abs(area - o["area"]) < 0.002 for o in out):
                continue  # empty, or the same as another guess
            ok, png = cv2.imencode(".png", m.astype(np.uint8) * 255)
            out.append({"mask": base64.b64encode(png.tobytes()).decode(), "score": float(scores[0, i]), "area": area})
        if not out:
            raise ValueError("nothing found there")
        out.sort(key=lambda o: o["area"])
        sure = [i for i, o in enumerate(out) if o["score"] >= 0.8]
        return {"masks": out, "pick": sure[0] if sure else int(np.argmax([o["score"] for o in out]))}


def main():
    models = sys.argv[sys.argv.index("--models") + 1]
    seg = Segmenter(models)
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        try:
            out = seg.mask(json.loads(line))
        except Exception as e:  # report it and keep serving
            out = {"error": str(e)}
        print(json.dumps(out), flush=True)


if __name__ == "__main__":
    main()
