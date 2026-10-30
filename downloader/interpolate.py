#!/usr/bin/env python3
"""Add AI frames to a video with RIFE: a smoother, higher frame rate, or slow motion.

Run with the ML venv's python (onnxruntime-gpu, numpy, opencv); the downloader
calls it as a subprocess for the scene-page "AI frames" button.

  interpolate.py INPUT OUTPUT --models DIR [--mode smooth|slowmo|clip|upscale] [--factor 2|4]
                 [--start SECONDS --duration SECONDS]

Decodes INPUT with ffmpeg and writes each frame followed by factor - 1 RIFE frames
on the way to the next. --mode smooth encodes them at factor x the frame rate (same
speed and length, audio copied); --mode slowmo keeps the frame rate, so the video
plays factor x slower and longer (audio slowed to match, pitch kept). Output is
H.264, CRF 18. --start/--duration work on just that part of INPUT (a marker), and
--mode clip only cuts that part out, without AI frames; --mode upscale makes every
frame 2x bigger with Real-ESRGAN (upscale.py) instead, or --target-width W wide
(e.g. 3840 for 4K) from a single 4x pass. At a hard cut (the next frame looks nothing like this one) the frame
is repeated instead, since RIFE would morph between unrelated shots. Prints JSON
lines: {"frames": done, "total": n, "fps": source frames per second} and finally
{"done": true}.
"""
import argparse
import json
import os
import subprocess
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from onnx_models import RIFE_FILE, rife, session  # noqa: E402
from upscale import upscale  # noqa: E402

CUT_DIFF = 40  # mean absolute difference (0..255) at a quarter size that counts as a hard cut


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,r_frame_rate,nb_frames:format=duration", "-of", "json", path],
        capture_output=True, text=True, check=True).stdout
    info = json.loads(out)
    s = info["streams"][0]
    num, den = (int(x) for x in s["r_frame_rate"].split("/"))
    fps = num / den if den else 30.0
    duration = float(info.get("format", {}).get("duration") or 0)
    total = int(s.get("nb_frames") or 0) or int(round(duration * fps))
    has_audio = bool(json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "json", path],
        capture_output=True, text=True).stdout or "{}").get("streams"))
    return int(s["width"]), int(s["height"]), s["r_frame_rate"], fps, total, has_audio


def report(**kw):
    print(json.dumps(kw), flush=True)


def upscale_video(args, part, w, h, rate, total, has_audio):
    """Every frame 2x bigger (or --target-width wide), same rate and speed, audio kept."""
    if args.target_width:
        ow = args.target_width - args.target_width % 2
        oh = int(round(h * ow / w / 2)) * 2
    else:
        ow, oh = w * 2, h * 2
    dec = subprocess.Popen(["ffmpeg", "-v", "error"] + part + ["-i", args.input, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                           stdout=subprocess.PIPE)
    enc_cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", "%dx%d" % (ow, oh),
               "-r", rate, "-i", "-"]
    if has_audio:
        enc_cmd += part + ["-i", args.input, "-map", "0:v", "-map", "1:a"] + (["-c:a", "aac", "-b:a", "192k"] if part else ["-c:a", "copy"])
    enc_cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
                "-movflags", "+faststart", "-f", "mp4", args.output]
    enc = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE)
    size = w * h * 3
    t0 = time.time()
    done = 0
    while True:
        buf = dec.stdout.read(size)
        if len(buf) < size:
            break
        frame = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
        out = upscale(frame, 4, args.models, size=(ow, oh)) if args.target_width else upscale(frame, 2, args.models)
        enc.stdin.write(out.tobytes())
        done += 1
        if done % 10 == 0:
            report(frames=done, total=total, fps=round(done / (time.time() - t0), 3))
    enc.stdin.close()
    if enc.wait() != 0 or dec.wait() != 0:
        raise SystemExit("ffmpeg failed")
    report(frames=total, total=total, fps=round(done / max(1e-6, time.time() - t0), 3), done=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--models", required=True)
    ap.add_argument("--mode", choices=["smooth", "slowmo", "clip", "upscale"], default="smooth")
    ap.add_argument("--factor", type=int, choices=[2, 4], default=2)
    ap.add_argument("--start", type=float, default=0)
    ap.add_argument("--duration", type=float, default=0, help="0: to the end")
    ap.add_argument("--target-width", type=int, default=0, help="--mode upscale: this wide (aspect kept) instead of 2x")
    args = ap.parse_args()
    n = args.factor
    # the part of the input to use (before each -i that reads it)
    part = (["-ss", "%.3f" % args.start] if args.start else []) + (["-t", "%.3f" % args.duration] if args.duration else [])

    w, h, rate, fps, total, has_audio = probe(args.input)
    if args.duration:
        total = int(round(args.duration * fps))
    if args.mode == "clip":
        # just the part, re-encoded so it starts cleanly
        report(frames=0, total=total, fps=0)
        p = subprocess.run(["ffmpeg", "-v", "error", "-y"] + part + ["-i", args.input, "-c:v", "libx264", "-preset", "medium",
                            "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
                            "-f", "mp4", args.output], capture_output=True, text=True)
        if p.returncode != 0:
            raise SystemExit("ffmpeg failed: " + p.stderr.strip()[-300:])
        report(frames=total, total=total, fps=0, done=True)
        return
    num, den = (int(x) for x in rate.split("/"))
    if args.mode == "upscale":
        upscale_video(args, part, w, h, rate, total, has_audio)
        return
    out_rate = "%d/%d" % (num * n, den) if args.mode == "smooth" else rate
    sess = session(os.path.join(args.models, RIFE_FILE))

    dec = subprocess.Popen(["ffmpeg", "-v", "error"] + part + ["-i", args.input, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                           stdout=subprocess.PIPE)
    enc_cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", "%dx%d" % (w, h),
               "-r", out_rate, "-i", "-"]
    if has_audio and args.mode == "smooth":
        # a part's audio is re-encoded (a stream copy can't start between packets)
        enc_cmd += part + ["-i", args.input, "-map", "0:v", "-map", "1:a"] + (["-c:a", "aac", "-b:a", "192k"] if part else ["-c:a", "copy"])
    elif has_audio:
        # slowed to match, pitch kept (atempo takes 0.5 at most per step)
        enc_cmd += part + ["-i", args.input, "-map", "0:v", "-map", "1:a", "-af", ",".join(["atempo=0.5"] * (n // 2)),
                           "-c:a", "aac", "-b:a", "192k"]
    enc_cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
                "-movflags", "+faststart", "-f", "mp4", args.output]
    enc = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE)

    size = w * h * 3
    read = lambda: dec.stdout.read(size)
    small = lambda im: im[::4, ::4].astype(np.int16)

    t0 = time.time()
    done = 0
    buf = read()
    if len(buf) < size:
        raise SystemExit("no video frames in %s" % args.input)
    a = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    while True:
        enc.stdin.write(a.tobytes())
        buf = read()
        if len(buf) < size:
            for _ in range(n - 1):
                enc.stdin.write(a.tobytes())  # keep the length: the last frame held
            break
        b = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
        cut = np.abs(small(a) - small(b)).mean() > CUT_DIFF  # a hard cut: don't morph between shots
        for k in range(1, n):
            enc.stdin.write((a if cut else rife(sess, a, b, k / n)).tobytes())
        a = b
        done += 1
        if done % 30 == 0:
            report(frames=done, total=total, fps=round(done / (time.time() - t0), 2))
    enc.stdin.close()
    if enc.wait() != 0 or dec.wait() != 0:
        raise SystemExit("ffmpeg failed")
    report(frames=total, total=total, fps=round(done / max(1e-6, time.time() - t0), 2), done=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        if isinstance(e.code, str):
            print(json.dumps({"error": e.code}), flush=True)
            sys.exit(1)
        raise
