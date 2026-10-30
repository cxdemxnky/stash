"""ONNX helpers shared by interpolate.py (AI frames) and upscale.py: model sessions
(on the GPU when this python has onnxruntime-gpu) and RIFE frame interpolation.
Run with the ML venv's python (onnxruntime, numpy, opencv)."""
import os

import cv2
import numpy as np
import onnxruntime as ort

RIFE_FILE = "rife49.onnx"

_sessions = {}


def session(path):
    """An onnxruntime session, on the GPU when this python has onnxruntime-gpu."""
    if path in _sessions:
        return _sessions[path]
    if not os.path.exists(path):
        raise SystemExit("model not found: %s" % path)
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = max(1, (os.cpu_count() or 2) // 2)
    providers = ["CPUExecutionProvider"]
    if "CUDAExecutionProvider" in ort.get_available_providers():
        if hasattr(ort, "preload_dlls"):
            ort.preload_dlls()  # the CUDA/cuDNN libraries installed from pip
        providers.insert(0, "CUDAExecutionProvider")
    _sessions[path] = ort.InferenceSession(path, opts, providers=providers)
    return _sessions[path]


def rife(sess, a, b, t):
    """The frame a fraction t of the way from a to b (BGR uint8), by RIFE."""
    h, w = a.shape[:2]
    ph, pw = (32 - h % 32) % 32, (32 - w % 32) % 32  # the model works on multiples of 32
    prep = lambda im: np.pad(cv2.cvtColor(im, cv2.COLOR_BGR2RGB).astype(np.float32) / 255,
                             ((0, ph), (0, pw), (0, 0)), mode="edge").transpose(2, 0, 1)[None]
    out = sess.run(None, {"img0": prep(a), "img1": prep(b), "timestep": np.array([t], np.float32)})[0]
    out = np.clip(out[0].transpose(1, 2, 0)[:h, :w], 0, 1)
    return cv2.cvtColor((out * 255).astype(np.uint8), cv2.COLOR_RGB2BGR)
