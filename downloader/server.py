#!/usr/bin/env python3
"""Local download/import service for the Stash site userscripts.

Tampermonkey userscripts POST jobs describing videos/galleries found on a page.
This service downloads them into the media folder, scans them into Stash and
applies the metadata (studio, show group, season/episode, performers, tags, cover).

Standard library only; HLS streams are downloaded with ffmpeg. Performer names are
read from end credits by credits.py, run with a separate OCR venv (--ocr-python).
Parallax Studio, Enhance Studio and the AI jobs (/parallax/...) are in parallax_service.py:
the studios relay to their own services (parallax and enhance), which call back here.

Job format (POST /jobs):
{
  "site": "PlayboyTV",                       # becomes the Stash studio
  "headers": {"Referer": "...", ...},        # default request headers for downloads
  "show": {"title", "url", "image", "description"},   # optional; becomes a Stash group
  "items": [{
    "kind": "scene" | "gallery",
    "url": "page url (used for de-duplication)",
    "title", "date" (YYYY-MM-DD), "details", "image" (cover url),
    "season": 1, "episode": 2,
    "performers": ["name", ...], "tags": ["name", ...],
    "media": {"url": "...m3u8 or mp4", "headers": {...}},   # scenes
    "images": [{"url": "...", "headers": {...}}],         # galleries downloaded by this service, or
    "zip_id": "190655",                                   # galleries the browser downloads as <zip_id>.zip
    "scene_url": "..."                                    # galleries: page url of the related scene
  }]
}
"""
import argparse
import base64
import difflib
import json
import os
import re
import shutil
import subprocess
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from parallax_service import Parallax

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)
CHUNK = 1 << 20
MAX_WORKERS = 8
TUNE_INTERVAL = 30          # seconds per throughput measurement
TUNE_SAMPLES = 2            # measurements per worker count before deciding
TUNE_MIN_GAIN = 1.05        # an extra worker must add 5% throughput to stay
TUNE_REPROBE = 600          # seconds before trying more workers again after backing off
PROGRESS_SAVE_INTERVAL = 5  # seconds between state saves for progress-only updates
AWAIT_TIMEOUT = 2 * 3600  # seconds a browser-downloaded gallery zip may take to arrive
CREDITS_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "credits.py")
CREDITS_TAG_READ = "Credits: names read"     # performers added from OCR; check them
CREDITS_TAG_NONE = "Credits: none found"     # scanned, no credit card recognised
# a site title that says nothing beyond the episode number ("Show - Episode 4")
GENERIC_TITLE = re.compile(r"\bEpisode \d+\s*$", re.I)
TITLE_SEP = " \u00b7 "  # "<Show> S01E02 · <episode title>"


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def safe_name(s, maxlen=150):
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", str(s or "")).strip().strip(".")
    s = re.sub(r"\s+", " ", s)
    return s[:maxlen].strip() or "Untitled"


# ---------------------------------------------------------------- downloads


def http_request(url, headers=None, data=None, method=None, timeout=60):
    h = {"User-Agent": USER_AGENT}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    return urllib.request.urlopen(req, timeout=timeout)


def fetch_bytes(url, headers=None):
    with http_request(url, headers) as r:
        return r.read(), r.headers.get_content_type()


def download_file(url, dest, headers=None, progress=None):
    """Download url to dest, resuming a previous .part file if present."""
    part = dest + ".part"
    have = os.path.getsize(part) if os.path.exists(part) else 0
    h = dict(headers or {})
    if have:
        h["Range"] = "bytes=%d-" % have
    try:
        r = http_request(url, h, timeout=120)
    except urllib.error.HTTPError as e:
        if e.code == 416 and have:  # already complete
            os.replace(part, dest)
            return
        raise
    with r:
        if have and r.status != 206:
            have = 0  # server ignored Range; start over
        total = r.headers.get("Content-Length")
        total = int(total) + have if total else None
        with open(part, "ab" if have else "wb") as f:
            done = have
            while True:
                buf = r.read(CHUNK)
                if not buf:
                    break
                f.write(buf)
                done += len(buf)
                if progress and total:
                    progress(done / total)
    if total and os.path.getsize(part) < total:
        raise IOError("incomplete download (%d of %d bytes)" % (os.path.getsize(part), total))
    os.replace(part, dest)


def best_hls_variant(url, headers):
    """Return the highest-bandwidth variant URL of an HLS master playlist (or url itself)."""
    body, _ = fetch_bytes(url, headers)
    text = body.decode("utf-8", "replace")
    if "#EXT-X-STREAM-INF" not in text:
        return url
    best, best_bw = url, -1
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.startswith("#EXT-X-STREAM-INF"):
            m = re.search(r"BANDWIDTH=(\d+)", line)
            bw = int(m.group(1)) if m else 0
            nxt = next((l for l in lines[i + 1:] if l and not l.startswith("#")), None)
            if nxt and bw > best_bw:
                best, best_bw = urllib.parse.urljoin(url, nxt.strip()), bw
    return best


def download_hls(url, dest, headers=None, duration_cb=None):
    headers = dict(headers or {})
    variant = best_hls_variant(url, headers)
    hdr = "".join("%s: %s\r\n" % kv for kv in headers.items())
    part = dest + ".part.mp4"
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-user_agent", headers.get("User-Agent", USER_AGENT),
    ]
    if hdr:
        cmd += ["-headers", hdr]
    cmd += [
        "-i", variant, "-map", "0:v:0?", "-map", "0:a:0?",
        "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", part,
    ]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        if os.path.exists(part):
            os.remove(part)
        raise IOError("ffmpeg failed: " + p.stderr.strip()[-500:])
    os.replace(part, dest)


class Cancelled(Exception):
    """The item was deleted from the downloads page while it was downloading."""


class LinkExpired(Exception):
    """The signed media URL stopped working; a userscript must resolve a fresh one."""


EXPIRED_CODES = (401, 403, 404, 410)
MAX_REFRESHES = 3


def is_hls(url):
    return ".m3u8" in urllib.parse.urlparse(url).path.lower()


# ---------------------------------------------------------------- stash api


class Stash:
    def __init__(self, url, api_key=""):
        self.url = url.rstrip("/") + "/graphql"
        self.api_key = api_key
        self._cache = {}
        self._ensure_lock = threading.Lock()

    def gql(self, query, variables=None):
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["ApiKey"] = self.api_key
        data = json.dumps({"query": query, "variables": variables or {}}).encode()
        with http_request(self.url, h, data=data, timeout=120) as r:
            res = json.loads(r.read())
        if res.get("errors"):
            raise RuntimeError(res["errors"][0]["message"])
        return res["data"]

    def scan(self, paths):
        job = self.gql(
            "mutation($i: ScanMetadataInput!) { metadataScan(input: $i) }",
            {"i": {"paths": paths, "scanGenerateCovers": True, "scanGenerateThumbnails": True}},
        )["metadataScan"]
        for _ in range(1800):
            j = self.gql("query($i: FindJobInput!) { findJob(input: $i) { status error } }",
                         {"i": {"id": job}})["findJob"]
            if not j or j["status"] in ("FINISHED", "CANCELLED", "FAILED"):
                if j and j["error"]:
                    raise RuntimeError("scan failed: " + j["error"])
                return
            time.sleep(1)
        raise RuntimeError("scan timed out")

    def find_by_path(self, kind, path):
        q = {
            "scene": "query($p: String!) { findScenes(scene_filter: {path: {value: $p, modifier: EQUALS}}) { scenes { id } } }",
            "gallery": "query($p: String!) { findGalleries(gallery_filter: {path: {value: $p, modifier: EQUALS}}) { galleries { id } } }",
        }[kind]
        res = self.gql(q, {"p": path})
        rows = res["findScenes"]["scenes"] if kind == "scene" else res["findGalleries"]["galleries"]
        return rows[0]["id"] if rows else None

    def find_by_url(self, kind, url):
        q = {
            "scene": "query($u: String!) { findScenes(scene_filter: {url: {value: $u, modifier: EQUALS}}) { scenes { id } } }",
            "gallery": "query($u: String!) { findGalleries(gallery_filter: {url: {value: $u, modifier: EQUALS}}) { galleries { id } } }",
        }[kind]
        res = self.gql(q, {"u": url})
        rows = res["findScenes"]["scenes"] if kind == "scene" else res["findGalleries"]["galleries"]
        return rows[0]["id"] if rows else None

    def in_stash(self, kind, url):
        """Whether Stash has a scene/gallery for this page, matching any URL with the same host and id."""
        p = urllib.parse.urlparse(url)
        m = re.search(r"/(\d+)/?$", p.path)
        if not m:
            return self.has_url(kind, url)
        rx = r"^https?://%s/.*/%s/?$" % (re.escape(p.netloc), m.group(1))
        q = {
            "scene": "query($u: String!) { findScenes(scene_filter: {url: {value: $u, modifier: MATCHES_REGEX}}) { count } }",
            "gallery": "query($u: String!) { findGalleries(gallery_filter: {url: {value: $u, modifier: MATCHES_REGEX}}) { count } }",
        }[kind]
        res = self.gql(q, {"u": rx})
        return (res["findScenes"] if kind == "scene" else res["findGalleries"])["count"] > 0

    def has_url(self, kind, url):
        q = {
            "scene": "query($u: String!) { findScenes(scene_filter: {url: {value: $u, modifier: EQUALS}}) { count } }",
            "gallery": "query($u: String!) { findGalleries(gallery_filter: {url: {value: $u, modifier: EQUALS}}) { count } }",
        }[kind]
        res = self.gql(q, {"u": url})
        return (res["findScenes"] if kind == "scene" else res["findGalleries"])["count"] > 0

    def ensure(self, kind, name, extra=None):
        """Find an entity by exact name (case-insensitive) or create it. kind: tag|performer|studio|group.
        Performers match loosely instead (see find_performer)."""
        with self._ensure_lock:
            if kind == "performer":
                return self._ensure_performer(name, extra)
            return self._ensure(kind, name, extra)

    def find_performer(self, name):
        """(id, name) of the performer whose name or an alias equals name, ignoring spaces,
        punctuation and case, so OCR's "STACYCRUZ" finds "Stacy Cruz"; None if there is none."""
        key = name_key(name)
        for p in self.gql("{ allPerformers { id name alias_list } }")["allPerformers"]:
            if any(name_key(n) == key for n in [p["name"]] + (p["alias_list"] or [])):
                return p["id"], p["name"]
        return None

    def _ensure_performer(self, name, extra):
        name = nicer_name(name)
        key = ("performer", name_key(name))
        if key in self._cache:
            return self._cache[key]
        found = self.find_performer(name)
        if found:
            eid, current = found
            if better_name(name, current):
                # e.g. "SHAYEVANS" read off a credit card, now seen properly as "Shay Evans"
                self.gql("mutation($i: PerformerUpdateInput!) { performerUpdate(input: $i) { id } }",
                         {"i": {"id": eid, "name": name}})
                log("renamed performer %r -> %r" % (current, name))
        else:
            inp = {"name": name}
            inp.update(extra or {})
            eid = self.gql("mutation($i: PerformerCreateInput!) { performerCreate(input: $i) { id } }",
                           {"i": inp})["performerCreate"]["id"]
            log("created performer %r" % name)
        self._cache[key] = eid
        return eid

    def _ensure(self, kind, name, extra):
        name = name.strip()
        key = (kind, name.lower())
        if key in self._cache:
            return self._cache[key]
        plural = {"tag": "Tags", "performer": "Performers", "studio": "Studios", "group": "Groups"}[kind]
        field = {"tag": "tags", "performer": "performers", "studio": "studios", "group": "groups"}[kind]
        filt = {"tag": "tag_filter", "performer": "performer_filter", "studio": "studio_filter", "group": "group_filter"}[kind]
        ftype = {"tag": "TagFilterType", "performer": "PerformerFilterType", "studio": "StudioFilterType", "group": "GroupFilterType"}[kind]
        res = self.gql(
            "query($f: %s) { find%s(%s: $f) { %s { id name } } }" % (ftype, plural, filt, field),
            {"f": {"name": {"value": name, "modifier": "EQUALS"}}},
        )["find" + plural][field]
        match = next((r for r in res if r["name"].lower() == name.lower()), None)
        if match:
            eid = match["id"]
        else:
            itype = {"tag": "TagCreateInput", "performer": "PerformerCreateInput", "studio": "StudioCreateInput", "group": "GroupCreateInput"}[kind]
            inp = {"name": name}
            inp.update(extra or {})
            eid = self.gql(
                "mutation($i: %s!) { %sCreate(input: $i) { id } }" % (itype, kind), {"i": inp}
            )[kind + "Create"]["id"]
            log("created %s %r" % (kind, name))
        self._cache[key] = eid
        return eid


def name_key(name):
    """A name without spaces, punctuation or case: "Mr. Pete", "MR PETE" and "MrPete" agree."""
    return re.sub(r"[^\w]|_", "", name.lower())


def nicer_name(name):
    """"LEAH LEE" -> "Leah Lee". Capitals without spaces ("SHAYEVANS") can't be split
    safely, so they stay as read until a properly spelt name replaces them."""
    name = re.sub(r"\s+", " ", name.strip())
    return name.title() if name.isupper() and " " in name else name


def better_name(new, old):
    """Whether new is a better spelling of the same name than old."""
    if new == old:
        return False
    return (" " in new and " " not in old) or (old.isupper() and not new.isupper())


def image_data_url(urls, headers):
    """Fetch the first working image of urls (a URL or a list tried in order) as a data URL."""
    for url in [urls] if isinstance(urls, str) else (urls or []):
        try:
            body, ctype = fetch_bytes(url, headers)
            if not ctype.startswith("image/"):
                ctype = "image/jpeg"
            return "data:%s;base64,%s" % (ctype, base64.b64encode(body).decode())
        except Exception as e:  # cover images are best-effort
            log("image fetch failed %s: %s" % (url, e))
    return None


# ---------------------------------------------------------------- credits


def similar(a, b):
    """Whether OCR'd text a is (a misreading of) b, e.g. the card's stylised show name."""
    if not a or not b:
        return False
    a = a.lower()
    return any(difflib.SequenceMatcher(None, a, x).ratio() >= 0.75
               for x in {b.lower(), re.sub(r"^playboy\s+", "", b.lower())})


class Credits:
    """Reads performer names from end credits with OCR (credits.py) and adds them to scenes.

    Finished downloads from the configured sites and a backfill of existing scenes are
    scanned one at a time in the background, at low CPU priority. Scanned scenes get a
    CREDITS_TAG_* tag, so a backfill never scans the same scene twice."""

    def __init__(self, stash, python, sites):
        self.stash = stash
        self.python = python
        self.sites = sites
        self.enabled = os.path.exists(python)
        self.queue = []
        self.current = None
        self.cond = threading.Condition()

    def read(self, path, at=None):
        cmd = [self.python, CREDITS_SCRIPT, path] + (["--at", str(at)] if at is not None else [])
        if at is None:
            cmd = ["nice", "-n", "15"] + cmd  # background scans must not slow downloads
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        if p.returncode != 0:
            raise RuntimeError("credits.py failed: " + p.stderr.strip()[-500:])
        return json.loads(p.stdout)

    def scene(self, sid):
        sc = self.stash.gql(
            "query($id: ID!) { findScene(id: $id) { id title code details files { path } groups { group { name } } "
            "performers { id } tags { id } } }", {"id": sid})["findScene"]
        if not sc or not sc["files"]:
            raise RuntimeError("scene %s has no file" % sid)
        return sc

    def add(self, sid):
        with self.cond:
            if sid != self.current and sid not in self.queue:
                self.queue.append(sid)
                self.cond.notify()

    def backfill(self):
        """Queue scenes from the credit sites that have no performers and haven't been scanned."""
        studios = [self.stash.ensure("studio", s) for s in self.sites]
        tags = [self.stash.ensure("tag", t) for t in (CREDITS_TAG_READ, CREDITS_TAG_NONE)]
        scenes = self.stash.gql(
            "query($f: SceneFilterType) { findScenes(filter: {per_page: -1, sort: \"id\"}, scene_filter: $f) "
            "{ scenes { id } } }",
            {"f": {"studios": {"value": studios, "modifier": "INCLUDES"},
                   "tags": {"value": tags, "modifier": "EXCLUDES"},
                   "performer_count": {"value": 0, "modifier": "EQUALS"}}})["findScenes"]["scenes"]
        for s in scenes:
            self.add(s["id"])
        log("credits backfill: %d scene(s) queued" % len(scenes))
        return {"queued": len(scenes)}

    def run(self):
        while True:
            with self.cond:
                while not self.queue:
                    self.cond.wait()
                self.current = self.queue.pop(0)
            try:
                self.process(self.current)
            except Exception as e:
                log("credits failed for scene %s: %s" % (self.current, e))
            finally:
                with self.cond:
                    self.current = None

    def process(self, sid):
        sc = self.scene(sid)
        res = self.read(sc["files"][0]["path"])
        tag_ids = [t["id"] for t in sc["tags"]]
        inp = {"id": sid}
        if res["names"]:
            new = [self.stash.ensure("performer", n) for n in res["names"]]
            inp["performer_ids"] = list(dict.fromkeys([p["id"] for p in sc["performers"]] + new))
            inp["tag_ids"] = list(dict.fromkeys(tag_ids + [self.stash.ensure("tag", CREDITS_TAG_READ)]))
            # segment titles replace a generic "<Show> - Episode N" title, never a real one
            show = sc["groups"][0]["group"]["name"] if sc["groups"] else None
            titles = [s["title"] for s in res["segments"] if s["title"] and not similar(s["title"], show)]
            base = episode_title(show, sc["code"])
            if titles and (not sc["title"] or sc["title"] == base or GENERIC_TITLE.search(sc["title"])):
                inp["title"] = episode_title(show, sc["code"], " / ".join(titles))
            lines = ["%s: %s" % (s["title"], " & ".join(s["performers"])) if s["title"] in titles
                     else " & ".join(s["performers"]) for s in res["segments"]]
            details = (sc["details"] or "").strip()
            if lines and "\n".join(lines) not in details:
                inp["details"] = "\n\n".join(x for x in (details, "\n".join(lines)) if x)
            log("credits for scene %s: %s%s" % (sid, ", ".join(res["names"]),
                                                " (title: %s)" % inp["title"] if "title" in inp else ""))
        else:
            inp["tag_ids"] = list(dict.fromkeys(tag_ids + [self.stash.ensure("tag", CREDITS_TAG_NONE)]))
            log("credits for scene %s: none found" % sid)
        self.stash.gql("mutation($i: SceneUpdateInput!) { sceneUpdate(input: $i) { id } }", {"i": inp})

    def frame(self, sid, at):
        """Names on screen around a paused position, for the "Read names" picker."""
        sc = self.scene(sid)
        res = self.read(sc["files"][0]["path"], at=at)
        linked = {p["id"] for p in sc["performers"]}
        show = sc["groups"][0]["group"]["name"] if sc["groups"] else None
        out = []
        for name in res["candidates"]:
            if similar(name, show):
                continue  # the card's stylised show name, not a performer
            found = self.stash.find_performer(name)
            # show an existing performer under their own spelling ("STACYCRUZ" -> "Stacy Cruz")
            out.append({"name": found[1] if found else nicer_name(name), "from_credit_line": name in res["names"],
                        "exists": bool(found), "on_scene": bool(found) and found[0] in linked})
        return {"candidates": out, "rows": [r["text"] for r in res["rows"]]}

    def apply(self, sid, names):
        """Link the chosen names to a scene, creating performers that don't exist."""
        names = [n.strip() for n in names if n and n.strip()]
        sc = self.scene(sid)
        ids = [self.stash.ensure("performer", n) for n in names]
        self.stash.gql("mutation($i: SceneUpdateInput!) { sceneUpdate(input: $i) { id } }",
                       {"i": {"id": sid, "performer_ids": list(dict.fromkeys([p["id"] for p in sc["performers"]] + ids))}})
        log("names added to scene %s: %s" % (sid, ", ".join(names)))
        return {"added": names}

    def status(self):
        with self.cond:
            return {"enabled": self.enabled, "queued": len(self.queue), "scanning": self.current}


# ---------------------------------------------------------------- worker


class Service:
    def __init__(self, media_dir, state_path, stash):
        self.media_dir = media_dir
        self.state_path = state_path
        self.stash = stash
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.items = []
        self._last_save = 0
        self.fixed_workers = 0       # >0 disables auto-tuning
        self.target_workers = 2
        self.rate = 0.0              # bytes/s over the last measurement
        if os.path.exists(state_path):
            with open(state_path) as f:
                self.items = json.load(f).get("items", [])
            for it in self.items:
                if it["status"] == "downloading":
                    it["status"] = "queued"

    def save(self):
        tmp = self.state_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"items": self.items}, f, indent=1)
        os.replace(tmp, self.state_path)

    def active_item(self, site, kind, url):
        """A non-failed item for the same site/kind/id (any URL form), if any. Needs the lock."""
        key = item_key(site, kind, url)
        return next((i for i in self.items
                     if i["status"] != "failed" and item_key(i["site"], i["kind"], i["url"]) == key), None)

    def check(self, site, entries):
        """Classify [{kind, url}] as "new", "queued" (incl. in progress/done here) or "in_stash"."""
        out = []
        for e in entries:
            kind, url = e.get("kind", "scene"), e.get("url")
            with self.lock:
                it = self.active_item(site, kind, url)
            if it:
                out.append("done" if it["status"] == "done" else "queued")
            elif self.stash.in_stash(kind, url):
                out.append("in_stash")
            else:
                out.append("new")
        return out

    def enqueue(self, job):
        site = job.get("site") or "Unknown"
        show = job.get("show")
        headers = job.get("headers") or {}
        res = {"queued": 0, "already_queued": 0, "in_stash": 0, "invalid": 0}
        for raw in job.get("items", []):
            kind = raw.get("kind", "scene")
            url = raw.get("url") or (raw.get("media") or {}).get("url")
            if (not url or (kind == "scene" and not (raw.get("media") or {}).get("url"))
                    or (kind == "gallery" and not (raw.get("images") or raw.get("zip_id")))):
                res["invalid"] += 1
                continue
            with self.lock:
                dup = self.active_item(site, kind, url)
            if dup:
                res["already_queued"] += 1
                continue
            if self.stash.in_stash(kind, url):
                res["in_stash"] += 1
                continue
            with self.lock:
                if self.active_item(site, kind, url):  # queued meanwhile by another request
                    res["already_queued"] += 1
                    continue
                # drop any old failed attempt so the retry replaces it
                key = item_key(site, kind, url)
                self.items = [i for i in self.items if item_key(i["site"], i["kind"], i["url"]) != key]
                # browser-downloaded zips wait for the folder watcher to find them
                status = "awaiting_file" if kind == "gallery" and raw.get("zip_id") else "queued"
                self.items.append(dict(raw, kind=kind, url=url, site=site, show=show, headers=headers,
                                       status=status, progress=0, error=None, added=time.time()))
                res["queued"] += 1
                self.save()
        self.wake.set()
        res["skipped"] = res["already_queued"] + res["in_stash"] + res["invalid"]
        return res

    def retry_failed(self):
        with self.lock:
            n = 0
            for it in self.items:
                if it["status"] == "failed":
                    it["status"], it["error"] = "queued", None
                    n += 1
            self.save()
        self.wake.set()
        return {"requeued": n}

    def move(self, kind, url, before=None):
        """Move a queued item to just before another queued item, or to the end of the queue
        when before is None (claim_next takes items in list order)."""
        def find(k, u):
            return next((i for i in self.items
                         if i["status"] == "queued" and i["kind"] == k and i["url"] == u), None)
        with self.lock:
            item = find(kind, url)
            if not item:
                return {"moved": 0}
            target = before and find(before.get("kind") or "scene", before.get("url"))
            if target is item:
                return {"moved": 0}
            self.items.remove(item)
            if target:
                self.items.insert(self.items.index(target), item)
            else:
                last = max((n for n, i in enumerate(self.items) if i["status"] == "queued"), default=len(self.items) - 1)
                self.items.insert(last + 1, item)
            self.save()
        return {"moved": 1}

    def delete(self, kind, url):
        """Remove an item from the list. A running download is cancelled by its worker
        (see check_cancel); partial files are removed. Finished files stay in Stash."""
        with self.lock:
            item = next((i for i in self.items if i["kind"] == kind and i["url"] == url), None)
            if not item:
                return {"deleted": 0}
            if item["status"] == "downloading":
                item["cancel"] = True
                return {"deleted": 0, "cancelling": 1}
            self.items.remove(item)
            self.save()
        if item["status"] != "done":
            remove_partial(item)
        log("deleted from list: %s" % url)
        return {"deleted": 1}

    def check_cancel(self, item):
        if item.get("cancel"):
            raise Cancelled()

    def expired(self, site):
        with self.lock:
            return [
                {"url": i["url"], "resolve": i["media"]["resolve"]}
                for i in self.items
                if i["status"] == "expired" and i["site"] == site
            ]

    def refresh(self, url, media_url):
        with self.lock:
            item = next((i for i in self.items if i["url"] == url and i["status"] == "expired"), None)
            if not item or not media_url:
                return {"refreshed": 0}
            item["media"]["url"] = media_url
            item["status"], item["error"] = "queued", None
            self.save()
        self.wake.set()
        return {"refreshed": 1}

    def part_sizes(self):
        """Sizes of the partial files of active downloads (HTTP .part or ffmpeg .part.mp4)."""
        sizes = {}
        with self.lock:
            paths = [i.get("path") for i in self.items if i["status"] == "downloading" and i.get("path")]
        for p in paths:
            for part in (p + ".part", p + ".part.mp4"):
                try:
                    sizes[part] = os.path.getsize(part)
                except OSError:
                    pass
        return sizes

    def tune(self):
        """Hill-climb the number of parallel downloads on measured total throughput."""
        rates = {}      # workers -> best recent throughput
        samples = {}    # workers -> measurements taken at that level
        backed_off_at = 0
        last = self.part_sizes()
        while True:
            time.sleep(TUNE_INTERVAL)
            now = self.part_sizes()
            # growth of files seen in both snapshots (finished/new files would distort it),
            # scaled up to all active files
            common = [k for k in now if k in last]
            grown = sum(max(0, now[k] - last[k]) for k in common)
            if common and len(now) > len(common):
                grown = grown * len(now) / len(common)
            last = now
            if not common:
                continue
            self.rate = grown / TUNE_INTERVAL
            if self.fixed_workers:
                continue
            with self.lock:
                active = sum(1 for i in self.items if i["status"] == "downloading")
                queued = sum(1 for i in self.items if i["status"] == "queued")
            n = self.target_workers
            if active < n or (queued == 0 and active <= 1):
                continue  # not saturated: the measurement says nothing about n workers
            samples[n] = samples.get(n, 0) + 1
            rates[n] = max(rates.get(n, 0), self.rate) if samples[n] > 1 else self.rate
            if samples[n] < TUNE_SAMPLES:
                continue
            lower = rates.get(n - 1)
            if lower is not None and rates[n] < lower * TUNE_MIN_GAIN:
                self.target_workers = n - 1
                backed_off_at = time.time()
                log("tuning: %d downloads no faster than %d (%.1f vs %.1f MB/s), using %d"
                    % (n, n - 1, rates[n] / 1e6, lower / 1e6, n - 1))
            elif n < MAX_WORKERS and queued > 0 and time.time() - backed_off_at > TUNE_REPROBE:
                self.target_workers = n + 1
                log("tuning: %.1f MB/s with %d downloads, trying %d" % (rates[n] / 1e6, n, n + 1))
            else:
                continue
            # measure the new level afresh; conditions change over time
            samples.pop(self.target_workers, None)
            rates.pop(self.target_workers, None)
            self.wake.set()

    def watch(self, watch_dir):
        """Hand browser-downloaded gallery zips in watch_dir to their awaiting items."""
        sizes = {}
        while True:
            try:
                self.watch_once(watch_dir, sizes)
            except Exception:
                traceback.print_exc()
            time.sleep(5)

    def watch_once(self, watch_dir, sizes):
        now = time.time()
        with self.lock:
            awaiting = [i for i in self.items if i["status"] == "awaiting_file"]
            for it in awaiting:
                if now - it["added"] > AWAIT_TIMEOUT:
                    it.update(status="failed", error="gallery zip never arrived in %s" % watch_dir, updated=now)
            if awaiting:
                self.save()
        awaiting = [i for i in awaiting if i["status"] == "awaiting_file"]
        if not awaiting or not os.path.isdir(watch_dir):
            return
        for name in sorted(os.listdir(watch_dir)):
            m = re.match(r"^(\d+)(?: \(\d+\))?\.zip$", name)
            if not m:
                continue  # also skips in-progress .crdownload/.part files
            path = os.path.join(watch_dir, name)
            size = os.path.getsize(path)
            if sizes.get(path) != size:
                sizes[path] = size  # wait until the size is stable between scans
                continue
            item = next((i for i in awaiting if str(i.get("zip_id")) == m.group(1)), None)
            if not item:
                continue
            if not zipfile.is_zipfile(path):
                continue
            log("found gallery zip %s for %s" % (name, item["url"]))
            sizes.pop(path, None)
            awaiting.remove(item)
            self.set(item, status="queued", local_file=path)
            self.wake.set()

    def known(self, site):
        """Status of every item for a site, keyed by page url (for userscript badges)."""
        with self.lock:
            return {i["url"]: i["status"] for i in self.items if i["site"] == site}

    def status(self, limit=50):
        with self.lock:
            counts = {}
            position = {}
            for it in self.items:
                counts[it["status"]] = counts.get(it["status"], 0) + 1
                if it["status"] == "queued":
                    position[id(it)] = len(position) + 1
            recent = sorted(self.items, key=lambda i: i.get("updated", i["added"]), reverse=True)
            if limit:
                recent = recent[:limit]
            fields = ("kind", "site", "title", "url", "status", "progress", "error", "path",
                      "season", "episode", "added", "updated", "stash_id", "cancel")
            return {
                "counts": counts,
                "workers": {"target": self.fixed_workers or self.target_workers,
                            "mode": "fixed" if self.fixed_workers else "auto",
                            "rate": round(self.rate)},
                "credits": self.credits.status(),
                "items": [
                    dict({k: it.get(k) for k in fields}, show=(it.get("show") or {}).get("title"),
                         position=position.get(id(it)))
                    for it in recent
                ],
            }

    def claim_next(self):
        """Atomically take the next queued item, so parallel workers never share one,
        keeping at most target_workers downloads running."""
        with self.lock:
            active = sum(1 for i in self.items if i["status"] == "downloading")
            if active >= (self.fixed_workers or self.target_workers):
                return None
            item = next((i for i in self.items if i["status"] == "queued"), None)
            if item:
                item.update(status="downloading", progress=0, updated=time.time())
                self.save()
            return item

    def set(self, item, **kw):
        with self.lock:
            now = time.time()
            item.update(kw, updated=now)
            # progress ticks arrive every MB; persist those at most every few seconds
            if set(kw) != {"progress"} or now - self._last_save > PROGRESS_SAVE_INTERVAL:
                self._last_save = now
                self.save()

    def run(self):
        while True:
            item = self.claim_next()
            if not item:
                self.wake.wait(5)
                self.wake.clear()
                continue
            try:
                self.process(item)
                self.set(item, status="done", progress=1)
                log("done: %s" % item.get("path"))
                if (self.credits.enabled and item["kind"] == "scene" and item.get("stash_id")
                        and item["site"] in self.credits.sites):
                    self.credits.add(item["stash_id"])
            except Cancelled:
                with self.lock:
                    if item in self.items:
                        self.items.remove(item)
                    self.save()
                remove_partial(item, finished=True)
                log("cancelled and deleted: %s" % item["url"])
            except LinkExpired as e:
                n = item.get("refreshes", 0) + 1
                if n > MAX_REFRESHES:
                    self.set(item, status="failed", error="download link keeps failing: %s" % e)
                else:
                    log("link expired, waiting for userscript refresh: %s" % item["url"])
                    self.set(item, status="expired", refreshes=n, error=str(e))
            except Exception as e:
                traceback.print_exc()
                self.set(item, status="failed", error=str(e))

    # -- paths

    def target_path(self, item):
        site = safe_name(item["site"])
        title = safe_name(item.get("title") or "Untitled")
        show = item.get("show")
        if item["kind"] == "gallery":
            folder = os.path.join(self.media_dir, "galleries", site)
            return os.path.join(folder, "%s%s.zip" % ((item.get("date") + " ") if item.get("date") else "", title))
        if show and show.get("title"):
            show_name = safe_name(show["title"])
            folder = os.path.join(self.media_dir, site, show_name)
            if item.get("season") is not None:
                folder = os.path.join(folder, "Season %02d" % int(item["season"]))
            code = episode_code(item)
            name = "%s - %s - %s" % (show_name, code, title) if code else "%s - %s" % (show_name, title)
        else:
            folder = os.path.join(self.media_dir, site, "Videos")
            name = "%s%s" % ((item.get("date") + " ") if item.get("date") else "", title)
        return os.path.join(folder, safe_name(name, 200) + ".mp4")

    # -- processing

    def process(self, item):
        if self.stash.in_stash(item["kind"], item["url"]):
            log("already in stash: %s" % item["url"])
            return
        path = self.target_path(item)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        item["path"] = path
        headers = dict(item.get("headers") or {})

        if item.get("local_file") and os.path.exists(item["local_file"]):
            log("moving %s -> %s" % (item["local_file"], path))
            shutil.move(item["local_file"], path)
            item["local_file"] = None
        if not os.path.exists(path):
            log("downloading %s -> %s" % (item["url"], path))
            if item["kind"] == "scene":
                media = item["media"]
                h = dict(headers, **(media.get("headers") or {}))
                try:
                    if is_hls(media["url"]) or media.get("type") == "hls":
                        download_hls(media["url"], path, h)
                    else:
                        download_file(media["url"], path, h,
                                      progress=lambda p: self.check_cancel(item) or self.set(item, progress=round(p, 3)))
                except urllib.error.HTTPError as e:
                    if e.code in EXPIRED_CODES and media.get("resolve"):
                        raise LinkExpired("HTTP %d" % e.code)
                    raise
            else:
                self.download_gallery(item, path, headers)

        self.check_cancel(item)  # deleted while an HLS download (no progress ticks) ran
        self.stash.scan([path])
        self.apply_metadata(item, path, headers)

    def download_gallery(self, item, path, headers):
        tmpdir = path + ".parts"
        os.makedirs(tmpdir, exist_ok=True)
        images = item["images"]
        for n, img in enumerate(images, 1):
            u = img["url"] if isinstance(img, dict) else img
            h = dict(headers, **((img.get("headers") if isinstance(img, dict) else None) or {}))
            ext = os.path.splitext(urllib.parse.urlparse(u).path)[1].lower()
            if ext not in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
                ext = ".jpg"
            dest = os.path.join(tmpdir, "%04d%s" % (n, ext))
            if not os.path.exists(dest):
                download_file(u, dest, h)
            self.set(item, progress=round(n / len(images), 3))
        part = path + ".part"
        with zipfile.ZipFile(part, "w", zipfile.ZIP_STORED) as z:
            for name in sorted(os.listdir(tmpdir)):
                z.write(os.path.join(tmpdir, name), name)
        os.replace(part, path)
        shutil.rmtree(tmpdir, ignore_errors=True)

    def apply_metadata(self, item, path, headers):
        st = self.stash
        eid = st.find_by_path(item["kind"], path)
        if not eid:
            raise RuntimeError("Stash did not pick up %s (is it inside a library folder?)" % path)
        item["stash_id"] = eid

        studio_id = st.ensure("studio", item.get("studio") or item["site"])
        tag_ids = [st.ensure("tag", t) for t in item.get("tags") or [] if t and t.strip()]
        performer_ids = [st.ensure("performer", p) for p in item.get("performers") or [] if p and p.strip()]

        inp = {
            "id": eid,
            "title": item.get("title"),
            "details": item.get("details"),
            "urls": [item["url"]],
            "studio_id": studio_id,
            "tag_ids": tag_ids,
            "performer_ids": performer_ids,
        }
        if item.get("date"):
            inp["date"] = item["date"]

        if item["kind"] == "gallery":
            scene_id = st.find_by_url("scene", item["scene_url"]) if item.get("scene_url") else None
            if scene_id:
                inp["scene_ids"] = [scene_id]
            st.gql("mutation($i: GalleryUpdateInput!) { galleryUpdate(input: $i) { id } }",
                   {"i": {k: v for k, v in inp.items() if v is not None}})
            return

        code = episode_code(item)
        if code:
            inp["code"] = code
        show = item.get("show")
        if show and show.get("title") and code:
            inp["title"] = episode_title(show["title"].strip(), code, item.get("title"))
        if show and show.get("title"):
            group_id = self.ensure_show(show, studio_id, headers)
            inp["groups"] = [{"group_id": group_id, "scene_index": scene_index(item)}]
        cover = image_data_url(item.get("image"), headers)
        if cover:
            inp["cover_image"] = cover
        # galleries for this scene that were imported before it
        with self.lock:
            gallery_ids = [i["stash_id"] for i in self.items
                           if i["kind"] == "gallery" and i.get("scene_url") == item["url"] and i.get("stash_id")]
        if gallery_ids:
            inp["gallery_ids"] = gallery_ids
        st.gql("mutation($i: SceneUpdateInput!) { sceneUpdate(input: $i) { id } }",
               {"i": {k: v for k, v in inp.items() if v is not None}})

    def ensure_show(self, show, studio_id, headers):
        extra = {
            "studio_id": studio_id,
            "synopsis": show.get("description"),
            "urls": [show["url"]] if show.get("url") else None,
            "tag_ids": [self.stash.ensure("tag", t) for t in ["Show"] + list(show.get("tags") or [])],
        }
        key = ("group", show["title"].strip().lower())
        if key not in self.stash._cache:  # only fetch the image when the group may be created
            img = image_data_url(show.get("image"), headers)
            if img:
                extra["front_image"] = img
        return self.stash.ensure("group", show["title"], {k: v for k, v in extra.items() if v})


def remove_partial(item, finished=False):
    """Delete a cancelled or deleted item's partial download (and, when finished=True,
    a completed file that was never imported)."""
    path = item.get("path")
    if not path:
        return
    for p in [path + ".part", path + ".part.mp4", path + ".parts"] + ([path] if finished else []):
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
        elif os.path.exists(p):
            os.remove(p)


def item_key(site, kind, url):
    """Identity of a download: site, kind and the numeric id ending the page URL, so
    different URL forms of the same video/gallery match."""
    m = re.search(r"/(\d+)/?$", urllib.parse.urlparse(url or "").path)
    return (site, kind, m.group(1) if m else url)


def episode_title(show, code, title=None):
    """Titles of show episodes start with "<Show> S01E02" so sorting scenes by title
    keeps every show together and in episode order; a real episode title follows."""
    base = "%s %s" % (show, code) if show and code else ""
    if title and GENERIC_TITLE.search(title):
        title = None
    return TITLE_SEP.join(x for x in (base, title) if x) or title


def episode_code(item):
    s, e = item.get("season"), item.get("episode")
    if s is not None and e is not None:
        return "S%02dE%02d" % (int(s), int(e))
    if e is not None:
        return "E%02d" % int(e)
    return None


def scene_index(item):
    # season * 1000 + episode keeps episodes ordered within a show group
    return int(item.get("season") or 0) * 1000 + int(item.get("episode") or 0)


# ---------------------------------------------------------------- http


STATUS_PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>Stash downloader</title>
<style>body{font:14px sans-serif;margin:20px;background:#1b1f22;color:#ddd}table{border-collapse:collapse;width:100%}
td,th{padding:4px 8px;border-bottom:1px solid #333;text-align:left}.failed{color:#f77}.done{color:#7c7}
button{margin-bottom:12px}</style></head><body><h2>Stash downloader</h2><div id=c></div>
<button onclick="fetch('retry',{method:'POST',headers:{'X-Token':prompt('Token')||''}}).then(load)">Retry failed</button><table id=t></table>
<script>function esc(s){return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function load(){fetch('status').then(r=>r.json()).then(s=>{c.textContent=JSON.stringify(s.counts);
t.innerHTML='<tr><th>Status</th><th>Kind</th><th>Site</th><th>Title</th><th>Progress</th><th>Error / path</th></tr>'+
s.items.map(i=>`<tr class=${i.status}><td>${i.status}</td><td>${i.kind}</td><td>${esc(i.site)}</td><td><a href="${esc(i.url)}" style="color:inherit">${esc(i.title)}</a></td>
<td>${Math.round((i.progress||0)*100)}%</td><td>${esc(i.error||i.path)}</td></tr>`).join('')})}
load();setInterval(load,3000)</script></body></html>"""


def make_handler(svc):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def send(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else (
                body.encode() if isinstance(body, str) else json.dumps(body).encode())
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Token")
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self.send(204, b"")

        def do_GET(self):
            if self.path.startswith("/parallax/"):
                code, body, ctype = svc.parallax.get(self.path)
                self.send(code, body, ctype or "application/json")
            elif self.path == "/":
                self.send(200, STATUS_PAGE, "text/html; charset=utf-8")
            elif self.path == "/status":
                self.send(200, svc.status())
            elif self.path == "/status?all=1":
                self.send(200, svc.status(limit=0))
            elif self.path.startswith("/expired?") or self.path.startswith("/known?"):
                q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                site = (q.get("site") or [""])[0]
                self.send(200, svc.expired(site) if self.path.startswith("/expired") else svc.known(site))
            else:
                self.send(404, {"error": "not found"})

        def do_POST(self):
            if svc.token and self.headers.get("X-Token") != svc.token:
                self.send(403, {"error": "bad or missing X-Token"})
                return
            if self.path.startswith("/parallax/"):
                # handled raw: export frames are binary
                raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                self.send(*svc.parallax.post(self.path, raw))
                return
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                self.send(400, {"error": "invalid json"})
                return
            if self.path == "/jobs":
                res = svc.enqueue(body)
                log("job from %s: %s" % (body.get("site"), res))
                self.send(200, res)
            elif self.path == "/delete":
                self.send(200, svc.delete(body.get("kind") or "scene", body.get("url")))
            elif self.path == "/move":
                self.send(200, svc.move(body.get("kind") or "scene", body.get("url"), body.get("before")))
            elif self.path == "/retry":
                self.send(200, svc.retry_failed())
            elif self.path == "/check":
                self.send(200, svc.check(body.get("site") or "Unknown", body.get("items") or []))
            elif self.path == "/refresh":
                self.send(200, svc.refresh(body.get("url"), body.get("media_url")))
            elif self.path.startswith("/credits/"):
                cr = svc.credits
                if not cr.enabled:
                    self.send(503, {"error": "OCR is not installed (see --ocr-python)"})
                    return
                try:
                    if self.path == "/credits/backfill":
                        self.send(200, cr.backfill())
                    elif self.path == "/credits/frame":
                        self.send(200, cr.frame(str(body["scene_id"]), float(body["time"])))
                    elif self.path == "/credits/apply":
                        self.send(200, cr.apply(str(body["scene_id"]), body.get("names") or []))
                    else:
                        self.send(404, {"error": "not found"})
                except Exception as e:
                    traceback.print_exc()
                    self.send(500, {"error": str(e)})
            else:
                self.send(404, {"error": "not found"})

    return Handler


def start_backfill(credits):
    """Backfill once Stash is reachable (it may start after this service)."""
    for _ in range(60):
        try:
            credits.backfill()
            return
        except Exception as e:
            log("credits backfill waiting for Stash: %s" % e)
            time.sleep(10)


def parallax_python(args):
    if args.parallax_python:
        return args.parallax_python
    gpu = os.path.expanduser("~/.local/share/stash-downloader/ml-gpu-venv/bin/python")
    if os.path.exists(gpu):
        try:
            p = subprocess.run([gpu, "-I", "-c", "import onnxruntime, cv2, numpy; print(onnxruntime.get_available_providers())"],
                               capture_output=True, text=True, timeout=60)
            if p.returncode == 0 and "CUDAExecutionProvider" in p.stdout:
                log("AI jobs: using the GPU venv")
                return gpu
        except (OSError, subprocess.SubprocessError):
            pass
    return args.ocr_python


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=10141)
    ap.add_argument("--media-dir", default="/media/matt/WD/tmp/media")
    ap.add_argument("--stash-url", default="http://localhost:10140")
    ap.add_argument("--api-key", default=os.environ.get("STASH_API_KEY", ""))
    ap.add_argument("--token", default=os.environ.get("DOWNLOADER_TOKEN", ""),
                    help="shared secret userscripts must send as X-Token")
    ap.add_argument("--workers", type=int, default=int(os.environ.get("DOWNLOADER_WORKERS") or 0),
                    help="fixed number of parallel downloads (default: tune automatically)")
    ap.add_argument("--watch-dir", default="/media/matt/WD/tmp/unsorted-media",
                    help="browser download folder watched for gallery zips")
    ap.add_argument("--ocr-python", default=os.path.expanduser("~/.local/share/stash-downloader/ocr-venv/bin/python"),
                    help="python with rapidocr-onnxruntime installed, used to read end credits")
    ap.add_argument("--credits-sites", default="PlayboyTV",
                    help="comma-separated sites whose videos get their end credits read")
    ap.add_argument("--state", default=os.path.expanduser("~/.local/share/stash-downloader/state.json"))
    ap.add_argument("--parallax-python", default=os.environ.get("PARALLAX_PYTHON", ""),
                    help="python for the AI frames and upscale jobs' models (default: the GPU venv "
                         "~/.local/share/stash-downloader/ml-gpu-venv if it works, else --ocr-python)")
    ap.add_argument("--models-dir", default=os.path.expanduser("~/.local/share/stash-downloader/models"),
                    help="ONNX models for the AI frames and upscale jobs (RIFE, Real-ESRGAN)")
    ap.add_argument("--parallax-dir", default=os.path.expanduser("~/.local/share/stash-downloader/parallax"),
                    help="AI job records, Enhance Studio previews and Parallax Studio's exported scenes (outside the library)")
    args = ap.parse_args()

    os.makedirs(os.path.dirname(args.state), exist_ok=True)
    svc = Service(os.path.abspath(args.media_dir), args.state, Stash(args.stash_url, args.api_key))
    svc.token = args.token
    svc.fixed_workers = max(0, args.workers)
    svc.credits = Credits(svc.stash, args.ocr_python, [s.strip() for s in args.credits_sites.split(",") if s.strip()])
    if svc.credits.enabled:
        threading.Thread(target=svc.credits.run, daemon=True).start()
        threading.Thread(target=start_backfill, args=(svc.credits,), daemon=True).start()
    else:
        log("OCR python not found at %s; reading end credits is disabled" % args.ocr_python)
    # the AI frames and upscale jobs run their models with onnxruntime + opencv: on the
    # GPU when the GPU venv is installed and works, else with the OCR venv's python on the CPU
    svc.parallax = Parallax(svc.stash, parallax_python(args), args.models_dir, args.parallax_dir, svc.media_dir, http_request)
    for _ in range(svc.fixed_workers or MAX_WORKERS):
        threading.Thread(target=svc.run, daemon=True).start()
    threading.Thread(target=svc.tune, daemon=True).start()
    threading.Thread(target=svc.watch, args=(args.watch_dir,), daemon=True).start()
    log("listening on http://%s:%d, saving to %s, %s parallel downloads"
        % (args.host, args.port, svc.media_dir, svc.fixed_workers or "auto-tuned"))
    ThreadingHTTPServer((args.host, args.port), make_handler(svc)).serve_forever()


if __name__ == "__main__":
    main()
