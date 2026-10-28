#!/usr/bin/env python3
"""Read performer names from on-screen text in a video with OCR.

Run with the OCR venv's python (pip install rapidocr-onnxruntime); the downloader
calls it as a subprocess so server.py itself stays standard library only.

  credits.py VIDEO               # end-credit card: the last 60 s at 1 frame/s
  credits.py VIDEO --at 754.2    # text around a paused position

A single frame is easily misread (stylised fonts, fades), so text only counts when
it reads the same in several frames. Prints JSON:
{
  "rows": [{"text": "...", "frames": 6, "name_like": true}],    # every line of text seen
  "segments": [{"title": "Golden After Dark", "performers": ["A", "B"]}],
  "names": ["A", "B"],         # from "Name & Name" lines seen in >= --min-frames frames
  "candidates": ["A", "B"]     # names plus name-like lines, for the paused-frame picker
}
"""
import argparse
import collections
import json
import os
import re
import subprocess
import sys
import tempfile

MIN_CONF = 0.6
NAME_PARTICLES = {"de", "da", "del", "della", "di", "du", "la", "le", "van", "von", "der", "den"}
NAME_SEPARATORS = re.compile(r"\s*(?:&|,|\band\b)\s*")
# watermarks and boilerplate that are never names
IGNORE = re.compile(r"^(\.?tv|©.*|.*\bLLC\b.*|.*\bU\.?S\.? Code\b.*|.*RECORDS?\b.*|.*\bINC\b.*)$", re.I)


def extract_frames(video, outdir, at=None):
    if at is None:
        seek, dur, fps = ["-sseof", "-60"], [], "1"
    else:
        start = max(0.0, at - 1.0)
        seek, dur, fps = ["-ss", "%.2f" % start], ["-t", "2.5"], "2"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-nostdin"] + seek + ["-i", video] + dur
        + ["-vf", "fps=" + fps, os.path.join(outdir, "f_%03d.png")],
        check=True,
    )
    return sorted(os.path.join(outdir, f) for f in os.listdir(outdir) if f.endswith(".png"))


def frame_rows(ocr, path):
    """OCR one frame and join the boxes on the same line (left to right) into rows, top
    to bottom. Returns [(text, height)]; the height tells segment titles from name lines."""
    result, _ = ocr(path)
    boxes = []
    for box, text, conf in result or []:
        text = text.strip()
        if conf < MIN_CONF or sum(c.isalpha() for c in text) < 2:
            continue
        ys = [p[1] for p in box]
        boxes.append({"y": (min(ys) + max(ys)) / 2, "h": max(ys) - min(ys), "x": min(p[0] for p in box), "text": text})
    boxes.sort(key=lambda b: b["y"])
    rows = []
    for b in boxes:
        row = rows[-1] if rows else None
        if row and abs(b["y"] - row["y"]) < 0.5 * max(b["h"], row["h"]):
            row["boxes"].append(b)
        else:
            rows.append({"y": b["y"], "h": b["h"], "boxes": [b]})
    out = []
    for row in rows:
        text = " ".join(b["text"] for b in sorted(row["boxes"], key=lambda b: b["x"]))
        text = re.sub(r"\s+", " ", text).strip()
        if not IGNORE.match(text):
            out.append((text, max(b["h"] for b in row["boxes"])))
    return out


def is_name(s, max_words=4):
    words = s.split()
    if not 1 <= len(words) <= max_words or not words[0][0].isupper():
        return False
    return all(
        w.lower() in NAME_PARTICLES or (w[0].isupper() and all(c.isalpha() or c in "'’.-" for c in w))
        for w in words
    )


def unglue(name):
    """OCR sometimes drops the space in a name: "KleioValentien" -> "Kleio Valentien".
    Only split where both halves are 3+ letters, so "McKenzie" or "DeAngelo" stay whole."""
    if " " in name:
        return name
    parts = re.split(r"(?<=[a-z])(?=[A-Z])", name)
    return " ".join(parts) if len(parts) == 2 and all(len(p) >= 3 for p in parts) else name


def tidy_title(title):
    """Card titles are sometimes set in capitals ("SUNNY DAY" -> "Sunny Day"), and some
    cards put "STARRING" after the title, above the names."""
    if not title:
        return title
    title = re.sub(r"\s*\bstarring\s*:?$", "", title, flags=re.I)
    return title.title() if title.isupper() else title


def split_names(row):
    """Names in a "Name & Name" credit line, or None if the row isn't one."""
    if not NAME_SEPARATORS.search(row):
        return None
    parts = [unglue(p.strip(" .")) for p in NAME_SEPARATORS.split(row)]
    parts = [p for p in parts if p]
    return parts if len(parts) >= 2 and all(is_name(p) for p in parts) else None


def name_key(name):
    """Names that differ only in spacing, punctuation or case ("LoganPierce", "Mr. Pete")."""
    return re.sub(r"[^\w]|_", "", name.lower())


def merge_variants(name_count):
    """Map every spelling of a name to its best one: the most frequent variant that
    has a space (OCR sometimes drops the space between first and last name)."""
    groups = collections.defaultdict(list)
    for name in name_count:
        groups[name_key(name)].append(name)
    canon = {}
    for variants in groups.values():
        best = max(variants, key=lambda n: (" " in n, name_count[n]))
        for n in variants:
            canon[n] = best
    return canon


def credit_lines(rows):
    """Names per row (None for rows that aren't credit lines). Segment titles are set
    larger than the name lines under them, so a "Gilded & Untamed" or "Silk, Sin,
    Sunlight" row that is clearly taller than the smallest credit line is a title."""
    names = [split_names(text) for text, _ in rows]
    heights = [h for (_, h), n in zip(rows, names) if n]
    if heights:
        smallest = min(heights)
        names = [None if n and h > 1.25 * smallest else n for (_, h), n in zip(rows, names)]
    return names


def analyse(frames, min_frames):
    row_count = collections.Counter()
    name_count = collections.Counter()
    pair_count = collections.Counter()  # (segment title, names) as seen together in one frame
    order = {}
    for rows in frames:
        rows = list({t: (t, h) for t, h in reversed(rows)}.values())[::-1]  # first of each text
        lines = credit_lines(rows)
        rows = [t for t, _ in rows]
        for n, row in enumerate(rows):
            row_count[row] += 1
            order.setdefault(row, len(order))
            names = lines[n]
            if not names:
                continue
            for name in names:
                name_count[name] += 1
                order.setdefault(name, len(order))
            title = tidy_title(rows[n - 1]) if n and not lines[n - 1] else None
            pair_count[(title, tuple(names))] += 1

    canon = merge_variants(name_count)
    merged = collections.Counter()
    for name, c in name_count.items():
        merged[canon[name]] += c
    names = sorted((n for n, c in merged.items() if c >= min_frames), key=order.get)
    pairs = collections.Counter()
    for (title, group), c in pair_count.items():
        pairs[(title, tuple(dict.fromkeys(canon[n] for n in group)))] += c
    segments = []
    seen = set()
    for (title, group), c in sorted(pairs.items(), key=lambda kv: -kv[1]):
        if c < min_frames or group in seen:
            continue  # a misread title gives a second, rarer pairing for the same names
        seen.add(group)
        segments.append({"title": title, "performers": list(group)})
    segments.sort(key=lambda s: order.get(s["performers"][0], 0))

    rows = [{"text": t, "frames": c, "name_like": is_name(t) and len(t.split()) >= 2}
            for t, c in sorted(row_count.items(), key=lambda kv: order[kv[0]])]
    # segment titles look like names ("Golden After Dark") but the card layout says what they are
    titles = {s["title"] for s in segments if s["title"]} | {r for r, _ in pair_count if r}
    candidates = list(dict.fromkeys(
        names + [r["text"] for r in rows
                 if r["name_like"] and r["frames"] >= min_frames and tidy_title(r["text"]) not in titles]))
    return {"rows": rows, "segments": segments, "names": names, "candidates": candidates}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("video")
    ap.add_argument("--at", type=float, help="read the text around this position (seconds)")
    ap.add_argument("--min-frames", type=int, help="frames a line must appear in (default 3, or 2 with --at)")
    args = ap.parse_args()
    min_frames = args.min_frames or (2 if args.at is not None else 3)

    from rapidocr_onnxruntime import RapidOCR

    ocr = RapidOCR()
    with tempfile.TemporaryDirectory(prefix="credits-") as tmp:
        frames = [frame_rows(ocr, f) for f in extract_frames(args.video, tmp, args.at)]
    if not frames:
        sys.exit("no frames extracted")
    json.dump(analyse(frames, min_frames), sys.stdout)


if __name__ == "__main__":
    main()
