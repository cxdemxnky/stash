#!/usr/bin/env python3
"""Split a still into a person layer and a filled-in background for Parallax Studio.

Run with the ML venv's python (onnxruntime, numpy, opencv, pillow; the same venv as
credits.py); the downloader calls it as a subprocess so server.py itself stays
standard library only.

  parallax.py SOURCE OUTDIR --models DIR [--model human|general] [--people main|all]
              [--soft N] [--grow N] [--fill lama|fast]
  parallax.py --extend-only OUTDIR --models DIR
  parallax.py --sequence FRAMESDIR OUTDIR --models DIR [--fps N] [same options]

Writes OUTDIR/mask.png (8-bit alpha), person.png (RGBA, transparent background),
background.png (person removed and filled in), background_ext.png (the background
with a generated border of EXTEND of its size on every side, so camera moves can
look past the photo's edges) and meta.json ("pad": [x, y] border fractions).
--extend-only adds background_ext.png to an existing cut. --sequence cuts every
frame in FRAMESDIR (bullet time) into seq/person_NNN.webp and builds one background
plate from all of them. The frames are first lined up with the middle one (a
homography from background features), so a moving source camera neither ghosts
the plate nor slides the person; each plate pixel is then the median of the frames
where the person doesn't cover it, and only what they cover in every frame is
filled in. With --interp N (2, 4), RIFE adds N - 1 frames between each lined-up
pair before the person is cut out of them, for smoother slow motion. person.png
and mask.png are the middle frame's. Prints one JSON line per
stage ({"stage": ..., "progress": 0..1}) so the caller can show progress.

Models (in --models):
  u2net_human_seg.onnx    person segmentation, 320x320 (--model human)
  isnet-general-use.onnx  general foreground segmentation, 1024x1024 (--model general)
  lama_fp32.onnx          LaMa inpainting, 512x512 (--fill lama)
  rife49.onnx             RIFE 4.9 frame interpolation (--interp N, bullet time)
"""
import argparse
import json
import os
import sys
import time

import cv2
import numpy as np
import onnxruntime as ort

MAX_SIDE = 2560  # sources are capped to this; exports are 1080p
MAX_SIDE_UPSCALED = 3840  # ...or to this when upscaled first (--upscale)
SEG_MODELS = {
    # file, input size, mean, std (as rembg uses them)
    "human": ("u2net_human_seg.onnx", 320, (0.485, 0.456, 0.406), (0.229, 0.224, 0.225)),
    "general": ("isnet-general-use.onnx", 1024, (0.5, 0.5, 0.5), (1.0, 1.0, 1.0)),
}
LAMA_FILE = "lama_fp32.onnx"
RIFE_FILE = "rife49.onnx"
LAMA_SIZE = 512
EXTEND = 0.2  # generated border on each side, as a fraction of the width/height


def stage(name, progress):
    print(json.dumps({"stage": name, "progress": round(progress, 3)}), flush=True)


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


def segment(img, models_dir, model):
    """Soft person mask in 0..1 at the image's size."""
    fname, size, mean, std = SEG_MODELS[model]
    sess = session(os.path.join(models_dir, fname))
    rgb = cv2.cvtColor(cv2.resize(img, (size, size), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
    x = rgb.astype(np.float32)
    x /= max(float(x.max()), 1e-6)
    x = (x - np.array(mean, np.float32)) / np.array(std, np.float32)
    x = x.transpose(2, 0, 1)[None]
    out = sess.run(None, {sess.get_inputs()[0].name: x})[0][0, 0]
    out = (out - out.min()) / max(float(out.max() - out.min()), 1e-6)
    return cv2.resize(out, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_LINEAR)


def guided_filter(guide, src, radius, eps):
    """He et al.'s guided filter: snaps the upscaled mask's edges to the photo's edges."""
    k = (2 * radius + 1, 2 * radius + 1)
    mean = lambda a: cv2.boxFilter(a, cv2.CV_32F, k)
    mi, mp = mean(guide), mean(src)
    a = (mean(guide * src) - mi * mp) / (mean(guide * guide) - mi * mi + eps)
    b = mp - a * mi
    return np.clip(mean(a) * guide + mean(b), 0, 1)


def refine(img, mask, people, soft, grow):
    h, w = mask.shape
    scale = max(h, w) / 1500.0  # parameters are in pixels at ~1500 px
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255
    alpha = guided_filter(gray, mask.astype(np.float32), max(2, int(6 * scale)), 1e-3)

    if people == "main":
        binary = (alpha > 0.5).astype(np.uint8)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
        if n > 2:
            biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
            keep = (labels == biggest).astype(np.uint8)
            # keep the soft edge around the chosen person, drop everyone else
            r = max(3, int(12 * scale))
            keep = cv2.dilate(keep, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
            alpha *= keep

    if grow:
        r = max(1, int(abs(grow) * scale))
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
        alpha = cv2.dilate(alpha, kernel) if grow > 0 else cv2.erode(alpha, kernel)

    if soft:
        alpha = cv2.GaussianBlur(alpha, (0, 0), max(0.5, soft * scale))
    else:
        alpha = np.clip((alpha - 0.1) / 0.8, 0, 1)  # crisper edge without feathering
    return alpha


def hole_mask(alpha, grow):
    """Area to fill: the person plus a margin, so no halo of them is left behind."""
    h, w = alpha.shape
    r = max(4, int(max(h, w) * 0.015) + max(0, grow))
    hole = (alpha > 0.05).astype(np.uint8)
    return cv2.dilate(hole, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))


def crop_box(hole):
    """A square-ish crop around the hole with context around it, for the 512px model."""
    h, w = hole.shape
    ys, xs = np.nonzero(hole)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    side = int(max(x1 - x0, y1 - y0) * 1.6)
    side = max(side, min(LAMA_SIZE, w, h))
    cw, ch = min(side, w), min(side, h)
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    left = int(np.clip(cx - cw // 2, 0, w - cw))
    top = int(np.clip(cy - ch // 2, 0, h - ch))
    return left, top, cw, ch


def lama(sess, crop, hole):
    """LaMa on one crop (any size; run at 512x512): the crop with the hole filled."""
    ch, cw = crop.shape[:2]
    x = cv2.cvtColor(cv2.resize(crop, (LAMA_SIZE, LAMA_SIZE), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
    m = (cv2.resize(hole, (LAMA_SIZE, LAMA_SIZE), interpolation=cv2.INTER_NEAREST) > 0).astype(np.float32)
    feeds = {}
    for inp in sess.get_inputs():
        # the image input has 3 channels, the mask 1
        feeds[inp.name] = (x.astype(np.float32) / 255).transpose(2, 0, 1)[None] if inp.shape[1] == 3 else m[None, None]
    out = sess.run(None, feeds)[0][0].transpose(1, 2, 0)
    if out.max() <= 1.5:  # some exports return 0..1, others 0..255
        out = out * 255
    out = cv2.cvtColor(np.clip(out, 0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR)
    return cv2.resize(out, (cw, ch), interpolation=cv2.INTER_CUBIC)


def fill_lama(img, hole, models_dir):
    sess = session(os.path.join(models_dir, LAMA_FILE))
    left, top, cw, ch = crop_box(hole)
    result = img.copy()
    result[top:top + ch, left:left + cw] = lama(sess, img[top:top + ch, left:left + cw], hole[top:top + ch, left:left + cw])
    return result


def extend(bg, models_dir, progress=None):
    """Outpaint a border of EXTEND around the background with LaMa, in square tiles
    along each side (two per side where they fit), sides first so the top and
    bottom tiles can see the filled sides. Returns the bigger image and the pad."""
    h, w = bg.shape[:2]
    mx, my = int(round(w * EXTEND)), int(round(h * EXTEND))
    W, H = w + 2 * mx, h + 2 * my
    canvas = cv2.copyMakeBorder(bg, my, my, mx, mx, cv2.BORDER_REFLECT)
    known = np.zeros((H, W), np.uint8)
    known[my:my + h, mx:mx + w] = 1
    sess = session(os.path.join(models_dir, LAMA_FILE))

    def tiles(band, length, other):
        # squares as big as needed to cover the band with context, at most the image
        s = min(max(3 * band, (length + 1) // 2), length, other)
        n = max(1, int(np.ceil((length - s) / (s * 0.85))) + 1) if length > s else 1
        return s, [int(round(v)) for v in np.linspace(0, length - s, n)]

    windows = []
    s, ys = tiles(mx, H, W)
    windows += [(x0, y0, s) for x0 in (0, W - s) for y0 in ys]
    s, xs = tiles(my, W, H)
    windows += [(x0, y0, s) for y0 in (0, H - s) for x0 in xs]
    for i, (x0, y0, s) in enumerate(windows):
        unknown = 1 - known[y0:y0 + s, x0:x0 + s]
        if unknown.any():
            out = lama(sess, canvas[y0:y0 + s, x0:x0 + s], unknown)
            region = canvas[y0:y0 + s, x0:x0 + s]
            region[unknown > 0] = out[unknown > 0]
            known[y0:y0 + s, x0:x0 + s] = 1
        if progress:
            progress((i + 1) / len(windows))
    # soften the seam between the photo and the generated border
    seam = np.zeros((H, W), np.float32)
    seam[my:my + h, mx:mx + w] = 1
    k = max(3, int(min(w, h) * 0.01)) | 1
    alpha = cv2.GaussianBlur(cv2.erode(seam, np.ones((k, k), np.uint8)), (0, 0), k / 2)[..., None]
    placed = canvas.copy()
    placed[my:my + h, mx:mx + w] = bg
    canvas = (placed * alpha + canvas * (1 - alpha)).astype(np.uint8)
    return canvas, [round(mx / w, 5), round(my / h, 5)]


def extend_only(outdir, models_dir):
    bg = cv2.imread(os.path.join(outdir, "background.png"), cv2.IMREAD_COLOR)
    if bg is None:
        raise SystemExit("no background.png in %s" % outdir)
    stage("extending the background", 0.05)
    ext, pad = extend(bg, models_dir, lambda f: stage("extending the background", 0.05 + 0.9 * f))
    cv2.imwrite(os.path.join(outdir, "background_ext.png"), ext)
    meta_path = os.path.join(outdir, "meta.json")
    with open(meta_path) as f:
        meta = json.load(f)
    meta["pad"] = pad
    with open(meta_path, "w") as f:
        json.dump(meta, f)
    stage("done", 1.0)


def fill_fast(img, hole):
    h, w = hole.shape
    f = min(1.0, 900.0 / max(h, w))
    small = cv2.resize(img, (int(w * f), int(h * f)), interpolation=cv2.INTER_AREA)
    shole = cv2.resize(hole, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST)
    filled = cv2.inpaint(small, shole, 7, cv2.INPAINT_TELEA)
    return cv2.resize(filled, (w, h), interpolation=cv2.INTER_CUBIC)


def blend_fill(img, filled, hole):
    """Use the fill inside the hole only, with a soft seam; the rest stays full resolution."""
    h, w = hole.shape
    feather = cv2.GaussianBlur(hole.astype(np.float32), (0, 0), max(2, max(h, w) * 0.004))
    feather = np.maximum(feather, hole.astype(np.float32))[..., None]
    return (img * (1 - feather) + filled * feather).astype(np.uint8)


def align(img, alpha, ref_gray, ref_kp, ref_des, orb):
    """Homography taking img onto the reference frame, from features off the person;
    the identity if there aren't enough good matches."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    keep = (hole_mask(alpha, 0) == 0).astype(np.uint8) * 255
    kp, des = orb.detectAndCompute(gray, keep)
    if des is None or ref_des is None or len(kp) < 20:
        return np.eye(3)
    matches = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True).match(des, ref_des)
    if len(matches) < 20:
        return np.eye(3)
    src = np.float32([kp[m.queryIdx].pt for m in matches])
    dst = np.float32([ref_kp[m.trainIdx].pt for m in matches])
    H, inl = cv2.findHomography(src, dst, cv2.RANSAC, 3.0)
    if H is None or inl.sum() < 15:
        return np.eye(3)
    return H


def rife(sess, a, b, t):
    """The frame a fraction t of the way from a to b (BGR uint8), by RIFE."""
    h, w = a.shape[:2]
    ph, pw = (32 - h % 32) % 32, (32 - w % 32) % 32  # the model works on multiples of 32
    prep = lambda im: np.pad(cv2.cvtColor(im, cv2.COLOR_BGR2RGB).astype(np.float32) / 255,
                             ((0, ph), (0, pw), (0, 0)), mode="edge").transpose(2, 0, 1)[None]
    out = sess.run(None, {"img0": prep(a), "img1": prep(b), "timestep": np.array([t], np.float32)})[0]
    out = np.clip(out[0].transpose(1, 2, 0)[:h, :w], 0, 1)
    return cv2.cvtColor((out * 255).astype(np.uint8), cv2.COLOR_RGB2BGR)


def median_plate(imgs, frees, chunk=48, min_share=0.3):
    """Per pixel, the median over the frames where it's free, and the hole: pixels
    free in fewer than min_share of the frames. Those few samples are unreliable (a
    limb the cut-out missed, parallax the alignment can't remove), so the fill
    paints them instead."""
    h, w = imgs[0].shape[:2]
    plate = np.zeros((h, w, 3), np.uint8)
    stack = np.stack(imgs)                    # n, h, w, 3
    free = np.stack(frees)                    # n, h, w
    for y in range(0, h, chunk):
        s = stack[:, y:y + chunk].astype(np.float32)
        s[free[:, y:y + chunk] == 0] = np.nan
        with np.errstate(all="ignore"):
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                m = np.nanmedian(s, axis=0)
        plate[y:y + chunk] = np.nan_to_num(m).astype(np.uint8)
    need = max(2, int(np.ceil(len(imgs) * min_share)))
    return plate, (free.sum(axis=0) < need).astype(np.uint8)


def run_sequence(args):
    t0 = time.time()
    names = sorted(n for n in os.listdir(args.source) if n.lower().endswith((".jpg", ".png")))
    if not names:
        raise SystemExit("no frames in %s" % args.source)
    stage("loading frames", 0.02)
    imgs = []
    for n in names:
        img = cv2.imread(os.path.join(args.source, n), cv2.IMREAD_COLOR)
        h, w = img.shape[:2]
        if max(h, w) > MAX_SIDE:
            f = MAX_SIDE / max(h, w)
            img = cv2.resize(img, (int(w * f), int(h * f)), interpolation=cv2.INTER_AREA)
        imgs.append(img)
    seq = os.path.join(args.outdir, "seq")
    os.makedirs(seq, exist_ok=True)

    # the person in every frame
    alphas = []
    for i, img in enumerate(imgs):
        stage("finding the person in frame %d of %d" % (i + 1, len(imgs)), 0.05 + 0.45 * i / len(imgs))
        alphas.append(refine(img, segment(img, args.models, args.model), args.people, args.soft, args.grow))
    if max(a.max() for a in alphas) < 0.5:
        raise SystemExit("no person found in these frames")

    # line every frame up with the middle one (the source camera may have moved)
    stage("lining the frames up", 0.5)
    mid = len(imgs) // 2
    h, w = imgs[mid].shape[:2]
    orb = cv2.ORB_create(4000)
    ref_gray = cv2.cvtColor(imgs[mid], cv2.COLOR_BGR2GRAY)
    ref_kp, ref_des = orb.detectAndCompute(ref_gray, (hole_mask(alphas[mid], 0) == 0).astype(np.uint8) * 255)
    frees, shifts = [], []
    for i, (img, alpha) in enumerate(zip(imgs, alphas)):
        H = np.eye(3) if i == mid else align(img, alpha, ref_gray, ref_kp, ref_des, orb)
        shifts.append(float(np.hypot(H[0, 2], H[1, 2])))
        if i != mid:
            img = cv2.warpPerspective(img, H, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
            valid = cv2.warpPerspective(np.ones((h, w), np.uint8), H, (w, h), flags=cv2.INTER_NEAREST)
            alpha = cv2.warpPerspective(alpha, H, (w, h), flags=cv2.INTER_LINEAR) * valid
            imgs[i], alphas[i] = img, alpha
        else:
            valid = np.ones((h, w), np.uint8)
        frees.append(((hole_mask(alphas[i], args.grow) == 0) & (valid > 0)).astype(np.uint8))

    # the person's frames: the lined-up ones, plus RIFE's in-betweens if asked for
    interp = max(1, int(args.interp))
    sess = session(os.path.join(args.models, RIFE_FILE)) if interp > 1 else None
    total = (len(imgs) - 1) * interp + 1
    write = lambda n, img, alpha: cv2.imwrite(os.path.join(seq, "person_%03d.webp" % n),
                                              np.dstack([img, (alpha * 255).astype(np.uint8)]), [cv2.IMWRITE_WEBP_QUALITY, 92])
    n = 0
    for i in range(len(imgs)):
        write(n, imgs[i], alphas[i])
        n += 1
        if i + 1 < len(imgs) and sess is not None:
            for k in range(1, interp):
                stage("making in-between frame %d of %d" % (n - i, total - len(imgs)), 0.55 + 0.25 * n / total)
                mid_img = rife(sess, imgs[i], imgs[i + 1], k / interp)
                write(n, mid_img, refine(mid_img, segment(mid_img, args.models, args.model), args.people, args.soft, args.grow))
                n += 1
    a8 = (alphas[mid] * 255).astype(np.uint8)
    cv2.imwrite(os.path.join(args.outdir, "mask.png"), a8)
    cv2.imwrite(os.path.join(args.outdir, "person.png"), np.dstack([imgs[mid], a8]))

    stage("building the background", 0.82)
    plate, hole = median_plate(imgs, frees)
    # LaMa reads the pixels under its mask too: start the hole from the middle frame
    plate[hole > 0] = imgs[mid][hole > 0]
    if hole.any():
        filled = fill_lama(plate, hole, args.models) if args.fill == "lama" else fill_fast(plate, hole)
        plate = blend_fill(plate, filled, hole)
    cv2.imwrite(os.path.join(args.outdir, "background.png"), plate)
    stage("extending the background", 0.86)
    ext, pad = extend(plate, args.models, lambda f: stage("extending the background", 0.86 + 0.12 * f))
    cv2.imwrite(os.path.join(args.outdir, "background_ext.png"), ext)

    meta = {
        "width": plate.shape[1], "height": plate.shape[0],
        "model": args.model, "people": args.people, "soft": args.soft, "grow": args.grow, "fill": args.fill, "pad": pad,
        "frames": total, "source_frames": len(imgs), "interp": interp, "fps": args.fps * interp,
        "sequence": "seq/person_%03d.webp", "middle": mid,
        "filled": round(float(hole.mean()), 4), "camera_shift_px": round(max(shifts), 1),
        "seconds": round(time.time() - t0, 1),
    }
    with open(os.path.join(args.outdir, "meta.json"), "w") as f:
        json.dump(meta, f)
    stage("done", 1.0)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("source", nargs="?")
    ap.add_argument("outdir")
    ap.add_argument("--models", required=True)
    ap.add_argument("--extend-only", action="store_true", help="add background_ext.png to the cut in OUTDIR")
    ap.add_argument("--sequence", action="store_true", help="SOURCE is a folder of frames (bullet time)")
    ap.add_argument("--fps", type=float, default=30, help="the frames' rate, recorded in meta.json")
    ap.add_argument("--interp", type=int, default=1, choices=[1, 2, 4], help="bullet time: RIFE frames per source frame")
    ap.add_argument("--model", choices=sorted(SEG_MODELS), default="human")
    ap.add_argument("--people", choices=["main", "all"], default="all")
    ap.add_argument("--soft", type=float, default=2, help="edge feather, px at ~1500 px")
    ap.add_argument("--grow", type=int, default=0, help="grow (+) or shrink (-) the person, px at ~1500 px")
    ap.add_argument("--fill", choices=["lama", "fast"], default="lama")
    ap.add_argument("--upscale", type=int, choices=[1, 2, 4], default=1,
                    help="AI-upscale the still first (Real-ESRGAN), for sharper zooms")
    args = ap.parse_args()
    if args.extend_only:
        extend_only(args.outdir, args.models)
        return
    os.makedirs(args.outdir, exist_ok=True)
    if args.sequence:
        run_sequence(args)
        return

    t0 = time.time()
    stage("loading", 0.02)
    img = cv2.imread(args.source, cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit("cannot read %s" % args.source)
    cap = MAX_SIDE
    if args.upscale > 1 and max(img.shape[:2]) < MAX_SIDE_UPSCALED:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I leaves the script's folder out
        from upscale import upscale  # imported here: upscale.py imports this module
        stage("upscaling the still", 0.05)
        img = upscale(img, args.upscale, args.models)
        cap = MAX_SIDE_UPSCALED
    h, w = img.shape[:2]
    if max(h, w) > cap:
        f = cap / max(h, w)
        img = cv2.resize(img, (int(w * f), int(h * f)), interpolation=cv2.INTER_AREA)
    os.makedirs(args.outdir, exist_ok=True)

    stage("finding the person", 0.1)
    mask = segment(img, args.models, args.model)
    stage("refining edges", 0.35)
    alpha = refine(img, mask, args.people, args.soft, args.grow)
    if alpha.max() < 0.5:
        raise SystemExit("no person found in this image")
    a8 = (alpha * 255).astype(np.uint8)
    cv2.imwrite(os.path.join(args.outdir, "mask.png"), a8)
    cv2.imwrite(os.path.join(args.outdir, "person.png"), np.dstack([img, a8]))

    stage("filling the background", 0.4)
    hole = hole_mask(alpha, args.grow)
    filled = fill_lama(img, hole, args.models) if args.fill == "lama" else fill_fast(img, hole)
    background = blend_fill(img, filled, hole)
    cv2.imwrite(os.path.join(args.outdir, "background.png"), background)
    stage("extending the background", 0.55)
    ext, pad = extend(background, args.models, lambda f: stage("extending the background", 0.55 + 0.4 * f))
    cv2.imwrite(os.path.join(args.outdir, "background_ext.png"), ext)

    meta = {
        "width": img.shape[1], "height": img.shape[0],
        "model": args.model, "people": args.people, "soft": args.soft, "grow": args.grow, "fill": args.fill, "pad": pad,
        "upscale": args.upscale, "seconds": round(time.time() - t0, 1),
    }
    with open(os.path.join(args.outdir, "meta.json"), "w") as f:
        json.dump(meta, f)
    stage("done", 1.0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        if isinstance(e.code, str):
            print(json.dumps({"error": e.code}), flush=True)
            sys.exit(1)
        raise
