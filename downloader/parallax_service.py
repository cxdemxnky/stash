"""Parallax Studio backend for the downloader service (standard library only).

Stills (a Stash image, or a scene frame at a given time) are split by parallax.py
into a person layer and a filled-in background. Everything lives outside the
library, under --parallax-dir, so Stash never sees the layers:

  layers/<source-key>/source.<ext>          the still (image-<id> | scene-<id>-<ms>[-bt<ms>])
  layers/<source-key>/frames/               bullet time: the frames of <ms> of video, f_NNN.jpg + info.json
  layers/<source-key>/<cut-id>/             mask.png person.png background.png
                                            background_ext.png (with an outpainted border) meta.json
  projects/<project-id>.json                saved by the studio (the client owns it)
  projects/<project-id>.jpg                 thumbnail for the project list
  projects/<project-id>.export.json         server-owned: exported file and scene id
  exports/<project-id>.mp4.part             an export being encoded

Exports are encoded by ffmpeg from JPEG frames the studio renders and streams in
(so preview and export use the same renderer), then moved to
<media>/Parallax/, scanned into Stash and tagged "Parallax".

GET  /parallax/status                         {enabled, reason, models}
GET  /parallax/projects[?source=KEY|?scene=ID] project summaries
GET  /parallax/project/<id>                   the project, plus "export"
GET  /parallax/cuts?source=KEY                cuts of a source, newest first
GET  /parallax/job/<id>                       {state, stage, progress, error, cut}
GET  /parallax/file/<path>                    a layer/thumbnail file (CORS, for canvases)
POST /parallax/project                        {source: {kind, id, time?, span?}, title?, settings?} -> project
POST /parallax/project/<id>                   save the project (body = project; "thumb" = data URL)
POST /parallax/project/<id>/delete
POST /parallax/project/<id>/duplicate         a new version: a copy with no export, titled "... vN"
POST /parallax/cut                            {source, settings} -> {job}
POST /parallax/extend                         {source_key, cut} -> {job}: outpaint an older cut's background
POST /parallax/segment                        {source_key, cut, points: [[x, y, 1|0]]} -> {masks: [{mask: data URL,
                                              score, area}], pick}: click-to-select (MobileSAM) on the cut's
                                              person layer; one click gives up to 3 sizes, smallest first
POST /parallax/mask                           {source_key, png: data URL} -> {file}: a layer's mask, kept
                                              with the source's cuts (masks/<id>.png)
POST /parallax/export/<id>/start              {width, height, fps, frames}
POST /parallax/export/<id>/frames             raw concatenated JPEGs
POST /parallax/export/<id>/finish             -> {scene_id, path}
POST /parallax/export/<id>/cancel

AI frames (a separate tool on scene pages, using the same RIFE model): a smoother
video at a higher frame rate, or slow motion.
GET  /parallax/fps?scene=ID                   {jobs, job, estimate, markers} for that scene
POST /parallax/fps                            {scene_id, option, marker_id?} -> {job}: queue it
A marker makes a short video of just its part (to its end time, or MARKER_SECONDS).
POST /parallax/fps/<job>/cancel                 (also cancels upscale jobs: same queue)
GET  /parallax/upscale?image=ID|gallery=ID    {jobs, estimate: {images, seconds: {"2", "4"}}, available}
POST /parallax/upscale                        {image_id | gallery_id, factor 2|4} -> {job}
GET  /parallax/ai-jobs                        every AI job, newest first (kept across restarts)

Enhance Studio (/enhance in Stash): deinterlace (QTGMC/BWDIF) -> crop -> denoise
and clean-ups -> upscale (Real-ESRGAN or Lanczos) -> frame rate (RIFE) -> encode,
done by the enhance service (/media/matt/WD/tmp/enhance, ENHANCE_URL) with its own
queue; this side picks the file, then scans the result in and copies the metadata.
GET  /parallax/enhance?scene=ID               {scene, markers, jobs, available, speeds, calibration, queued,
                                              service_error}
GET  /parallax/enhance/ui/studio.js|studio.css|image-studio.js   the shared studios, relayed from the enhance service
Image studio (/enhance-image in Stash; replaces the old Upscale buttons), made by the service too:
GET  /parallax/enhance-image?image=ID|gallery=ID  {title, images, jobs, available, speeds, calibration, queued, service_error}
POST /parallax/enhance-image                  {image_id | gallery_id, only?, settings, masks: {image id: PNG data URL},
                                              label, summary, estimate} -> {job}: new images in <library>/Enhanced/
POST /parallax/enhance-image/probe|preview|segment   {image_id, ...}: relayed to the service's /image/...
POST /parallax/enhance                        {scene_id, marker_id? | start, duration, settings, label, summary,
                                              estimate} -> {job}
POST /parallax/enhance/preview                {scene_id, time, settings} -> {before, after}: files for
                                              /parallax/file/, one frame through every step but the frame rate
option is one of FPS_OPTIONS. The new video is written outside the library
(FPS_WORK), then moved next to the original, scanned in as a new scene with the
original's metadata, and tagged. The original is never changed.
"""
import base64
import json
import mimetypes
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
import uuid

PARALLAX_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "parallax.py")
UPSCALE_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "upscale.py")
INTERPOLATE_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "interpolate.py")
ENHANCE_URL = os.environ.get("ENHANCE_URL", "http://127.0.0.1:10142").rstrip("/")  # the enhance service
ENHANCE_TOKEN = os.environ.get("ENHANCE_TOKEN", "")  # from ~/.config/enhance/env (see the unit file)
ENHANCE_TAG = "Enhanced (AI)"
SEGMENT_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "segment.py")
SEGMENT_MODELS = ("mobile_sam_image_encoder.onnx", "sam_mask_decoder_multi.onnx")
SEGMENT_IDLE = 300  # seconds without clicks before the segment worker (and its GPU memory) goes
# option: (mode, factor, file suffix, title suffix, tag); {fps} is the new frame rate
FPS_OPTIONS = {
    "clip": ("clip", 1, "", "", None),  # markers: just the part, no AI frames
    "smooth2": ("smooth", 2, "[{fps}fps]", "({fps} fps)", "Higher frame rate (AI)"),
    "slowmo2": ("slowmo", 2, "[slow-mo 2x]", "(slow motion 2×)", "Slow motion (AI)"),
    "slowmo4": ("slowmo", 4, "[slow-mo 4x]", "(slow motion 4×)", "Slow motion (AI)"),
    "upscale2": ("upscale", 2, "[upscaled 2x]", "(upscaled 2×)", "Upscaled (AI)"),
    # one 4x pass, then exactly UHD_WIDTH wide: 720p -> 4K without two 2x passes
    "upscale4k": ("upscale", 4, "[4K]", "(4K)", "Upscaled (AI)"),
}
FPS_WORK = "/media/matt/WD/tmp/.fps-work"  # on the media disk (big files), outside the library
MARKER_SECONDS = 10  # length of a marker's clip when it has no end time
UPSCALE_TAG = "Upscaled (AI)"
UPSCALE_DIR = "Upscaled"  # folder in the library for upscaled images
ENHANCED_DIR = "Enhanced"  # folder in the library for images made in the image studio
ENHANCE_SRC = os.path.join(FPS_WORK, "enhance-src")  # copies of images inside zips (the service can't read zips)
UPSCALE_SPEED = 0.95  # default source megapixels upscaled per second (video frames, 2x; 1080p ~0.47 frame/s)
IMAGE_SPEED = 0.7  # default source megapixels per second for images (plus IMAGE_OVERHEAD each)
IMAGE_OVERHEAD = 0.6
UHD_WIDTH = 3840
FPS_SPEED = 2.5  # default AI megapixel-frames made per second (measured: 1080p at ~1.2 frame/s)
PARALLAX_TAG = "Parallax"
REQUIRED_MODELS = ("u2net_human_seg.onnx", "lama_fp32.onnx")
OPTIONAL_MODELS = {"general": "isnet-general-use.onnx", "rife": "rife49.onnx", "upscale": "realesr-general-x4v3.onnx"}
ID_RE = re.compile(r"^[a-f0-9]{12}$")
KEY_RE = re.compile(r"^(image-\d+|scene-\d+-\d+(-bt\d+)?)$")
BULLET_MAX = 3.0  # seconds of video a bullet-time source may span


def log(msg):
    print(time.strftime("%H:%M:%S"), "parallax:", msg, flush=True)


def write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def source_key(src):
    if src.get("kind") == "image":
        return "image-%d" % int(src["id"])
    if src.get("kind") == "scene":
        key = "scene-%d-%d" % (int(src["id"]), round(float(src.get("time") or 0) * 1000))
        span = float(src.get("span") or 0)
        if span > 0:  # bullet time: this much video from that point
            key += "-bt%d" % round(min(span, BULLET_MAX) * 1000)
        return key
    raise ValueError("source.kind must be image or scene")


class Export:
    def __init__(self, path, proc, frames):
        self.path = path
        self.proc = proc
        self.frames = frames
        self.lock = threading.Lock()


class Parallax:
    def __init__(self, stash, python, models_dir, root, media_dir, http_request):
        self.stash = stash
        self.python = python
        self.models_dir = models_dir
        self.root = root
        self.media_dir = media_dir
        self.http_request = http_request
        for d in ("layers", "projects", "exports"):
            os.makedirs(os.path.join(root, d), exist_ok=True)
        self.jobs = {}
        self.queue = []
        self.cond = threading.Condition()
        self.exports = {}
        self.project_lock = threading.Lock()
        threading.Thread(target=self.run, daemon=True).start()
        # double-frame-rate jobs: hours long, so their own queue, one at a time
        self.fps_jobs = {}
        self.fps_queue = []
        self.fps_cond = threading.Condition()
        self.fps_proc = None
        self.load_ai_jobs()
        threading.Thread(target=self.run_fps, daemon=True).start()
        self.enhance_wake = threading.Event()  # Enhance Studio jobs run in the enhance service
        threading.Thread(target=self.enhance_sync, daemon=True).start()
        # click-to-select: one long-lived worker, so clicks don't each load the model
        self.seg_proc = None
        self.seg_lock = threading.Lock()
        self.seg_used = 0
        threading.Thread(target=self.reap_segmenter, daemon=True).start()

    # ------------------------------------------------------------ status

    def status(self):
        missing = [m for m in REQUIRED_MODELS if not os.path.exists(os.path.join(self.models_dir, m))]
        reason = None
        if not os.path.exists(self.python):
            reason = "ML python not found at %s" % self.python
        elif missing:
            reason = "models missing in %s: %s" % (self.models_dir, ", ".join(missing))
        elif not shutil.which("ffmpeg"):
            reason = "ffmpeg not found"
        models = ["human"] + [k for k, f in OPTIONAL_MODELS.items() if os.path.exists(os.path.join(self.models_dir, f))]
        if all(os.path.exists(os.path.join(self.models_dir, f)) for f in SEGMENT_MODELS):
            models.append("segment")
        return {"enabled": reason is None, "reason": reason, "models": models}

    # ------------------------------------------------------------ projects

    def project_path(self, pid, ext=".json"):
        if not ID_RE.match(pid or ""):
            raise ValueError("bad project id")
        return os.path.join(self.root, "projects", pid + ext)

    def load_project(self, pid):
        p = read_json(self.project_path(pid))
        if p is None:
            raise KeyError("no such project")
        p["export"] = read_json(self.project_path(pid, ".export.json"))
        return p

    def summaries(self, source=None, scene=None):
        out = []
        d = os.path.join(self.root, "projects")
        for name in os.listdir(d):
            if not name.endswith(".json") or name.endswith(".export.json"):
                continue
            pid = name[:-5]
            try:
                p = self.load_project(pid)
            except (KeyError, ValueError):
                continue
            if source and p.get("source_key") != source:
                continue
            exp = p.get("export") or {}
            if scene and str(exp.get("scene_id")) != str(scene):
                continue
            out.append({
                "id": pid, "title": p.get("title"), "source": p.get("source"), "source_key": p.get("source_key"),
                "created": p.get("created"), "updated": p.get("updated"),
                "thumb": "projects/%s.jpg" % pid if os.path.exists(self.project_path(pid, ".jpg")) else None,
                "scene_id": exp.get("scene_id"),
            })
        out.sort(key=lambda p: p.get("updated") or 0, reverse=True)
        return out

    def create_project(self, body):
        src = body.get("source") or {}
        key = source_key(src)
        pid = uuid.uuid4().hex[:12]
        now = time.time()
        title = body.get("title") or self.source_title(src)
        project = {
            "id": pid, "version": 1, "title": title, "source": src, "source_key": key,
            "cut_id": None, "created": now, "updated": now,
        }
        write_json(self.project_path(pid), project)
        log("project %s created for %s" % (pid, key))
        # reuse a cut of this source (one with the asked-for AI frames, for bullet time)
        want = int((body.get("settings") or {}).get("interp") or 1)
        cut = next((c for c in self.cuts(key) if int(c["meta"].get("interp", 1)) == want), None)
        job = None
        if cut:
            project["cut_id"] = cut["id"]
            write_json(self.project_path(pid), project)
        else:
            job = self.start_cut({"source": src, "settings": body.get("settings") or {}})["job"]
        project["export"] = None
        return {"project": project, "job": job}

    def save_project(self, pid, body):
        path = self.project_path(pid)
        if not os.path.exists(path):
            raise KeyError("no such project")
        thumb = body.pop("thumb", None)
        body.pop("export", None)  # server-owned, kept in the sidecar
        body["id"] = pid
        body["updated"] = time.time()
        with self.project_lock:
            write_json(path, body)
        if thumb and thumb.startswith("data:image/jpeg;base64,"):
            with open(self.project_path(pid, ".jpg"), "wb") as f:
                f.write(base64.b64decode(thumb.split(",", 1)[1]))
        return {"saved": True, "updated": body["updated"]}

    def duplicate_project(self, pid):
        """Copy a project as another version of the same still (its export stays with
        the original, so the copy exports to a scene of its own)."""
        p = self.load_project(pid)
        p.pop("export", None)
        versions = self.summaries(source=p.get("source_key"))
        base = re.sub(r"\s+v\d+$", "", p.get("title") or "Parallax")
        taken = {s.get("title") for s in versions}
        n = len(versions) + 1
        while "%s v%d" % (base, n) in taken:
            n += 1
        new = uuid.uuid4().hex[:12]
        now = time.time()
        p.update(id=new, title="%s v%d" % (base, n), created=now, updated=now)
        write_json(self.project_path(new), p)
        if os.path.exists(self.project_path(pid, ".jpg")):
            shutil.copyfile(self.project_path(pid, ".jpg"), self.project_path(new, ".jpg"))
        log("project %s duplicated as %s (%s)" % (pid, new, p["title"]))
        return {"project": p}

    def delete_project(self, pid):
        for ext in (".json", ".jpg", ".export.json"):
            try:
                os.remove(self.project_path(pid, ext))
            except FileNotFoundError:
                pass
        return {"deleted": pid}

    def source_title(self, src):
        try:
            if src["kind"] == "image":
                im = self.stash.gql("query($id: ID!) { findImage(id: $id) { title galleries { title } files { path } } }",
                                    {"id": src["id"]})["findImage"]
                name = im["title"] or (im["galleries"][0]["title"] if im["galleries"] else "") or \
                    os.path.splitext(os.path.basename(im["files"][0]["path"]))[0]
            else:
                sc = self.stash.gql("query($id: ID!) { findScene(id: $id) { title files { path } } }",
                                    {"id": src["id"]})["findScene"]
                name = sc["title"] or os.path.splitext(os.path.basename(sc["files"][0]["path"]))[0]
            return "%s (%s)" % (name, "Bullet time" if src.get("span") else "Parallax")
        except Exception:
            return "Parallax %s" % source_key(src)

    # ------------------------------------------------------------ layers

    def layer_dir(self, key):
        if not KEY_RE.match(key or ""):
            raise ValueError("bad source key")
        return os.path.join(self.root, "layers", key)

    def cuts(self, key):
        d = self.layer_dir(key)
        out = []
        if os.path.isdir(d):
            for cid in os.listdir(d):
                meta = read_json(os.path.join(d, cid, "meta.json"))
                if meta:
                    base = "layers/%s/%s/" % (key, cid)
                    has_ext = os.path.exists(os.path.join(d, cid, "background_ext.png"))
                    out.append({"id": cid, "meta": meta, "created": os.path.getmtime(os.path.join(d, cid, "meta.json")),
                                "person": base + "person.png", "background": base + "background.png",
                                "background_ext": base + "background_ext.png" if has_ext else None,
                                # bullet time: the person's frames, %03d = 0 .. frames - 1
                                "sequence": base + meta["sequence"] if meta.get("sequence") else None,
                                "mask": base + "mask.png"})
        out.sort(key=lambda c: c["created"], reverse=True)
        src = next((n for n in os.listdir(d) if n.startswith("source.") and not n.endswith(".part")), None) \
            if os.path.isdir(d) else None
        for c in out:
            c["source"] = "layers/%s/%s" % (key, src) if src else None
        return out

    def fetch_frames(self, src, key):
        """Bullet time: the frames of src["span"] seconds of the scene from src["time"],
        extracted once into frames/ (with their rate in info.json), plus the middle
        one as the source still. Returns (frames dir, fps)."""
        d = self.layer_dir(key)
        fd = os.path.join(d, "frames")
        info = read_json(os.path.join(fd, "info.json"))
        if info:
            return fd, info["fps"]
        sc = self.stash.gql("query($id: ID!) { findScene(id: $id) { files { path frame_rate } } }", {"id": src["id"]})["findScene"]
        if not sc or not sc["files"]:
            raise RuntimeError("scene %s has no file" % src["id"])
        f = sc["files"][0]
        fps = float(f.get("frame_rate") or 30) or 30
        span = min(float(src.get("span") or 1), BULLET_MAX)
        tmp = fd + ".part"
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "%.3f" % float(src.get("time") or 0), "-i", f["path"],
                        "-frames:v", str(max(2, round(span * fps))), "-q:v", "2", os.path.join(tmp, "f_%03d.jpg")],
                       check=True, capture_output=True, timeout=300)
        names = sorted(os.listdir(tmp))
        if len(names) < 2:
            raise RuntimeError("couldn't read frames from the scene at that point")
        shutil.copyfile(os.path.join(tmp, names[len(names) // 2]), os.path.join(d, "source.jpg"))
        write_json(os.path.join(tmp, "info.json"), {"fps": fps, "frames": len(names), "span": span})
        shutil.rmtree(fd, ignore_errors=True)
        os.replace(tmp, fd)
        return fd, fps

    def fetch_source(self, src, key):
        """The still for a source, extracted once and kept next to its cuts."""
        d = self.layer_dir(key)
        os.makedirs(d, exist_ok=True)
        if src.get("span"):
            self.fetch_frames(src, key)
        for name in os.listdir(d):
            if name.startswith("source."):
                return os.path.join(d, name)
        if src["kind"] == "image":
            base = self.stash.url[: -len("/graphql")]
            headers = {"ApiKey": self.stash.api_key} if self.stash.api_key else {}
            with self.http_request("%s/image/%d/image" % (base, int(src["id"])), headers) as r:
                ext = mimetypes.guess_extension((r.headers.get("Content-Type") or "image/jpeg").split(";")[0]) or ".jpg"
                path = os.path.join(d, "source" + (".jpg" if ext in (".jpe", ".jpeg") else ext))
                with open(path + ".part", "wb") as f:
                    shutil.copyfileobj(r, f)
        else:
            sc = self.stash.gql("query($id: ID!) { findScene(id: $id) { files { path } } }", {"id": src["id"]})["findScene"]
            if not sc or not sc["files"]:
                raise RuntimeError("scene %s has no file" % src["id"])
            path = os.path.join(d, "source.png")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "%.3f" % float(src.get("time") or 0),
                            "-i", sc["files"][0]["path"], "-frames:v", "1", "-f", "image2", "-c:v", "png",
                            path + ".part"], check=True, capture_output=True, timeout=120)
        os.replace(path + ".part", path)
        return path

    def start_cut(self, body):
        src = body.get("source") or {}
        key = source_key(src)
        s = body.get("settings") or {}
        settings = {
            "model": s.get("model") if s.get("model") in ("human", "general") else "human",
            "people": "main" if s.get("people") == "main" else "all",
            "soft": max(0.0, min(20.0, float(s.get("soft", 2)))),
            "grow": max(-40, min(40, int(s.get("grow", 0)))),
            "fill": "fast" if s.get("fill") == "fast" else "lama",
            # bullet time: RIFE in-between frames per source frame
            "interp": int(s.get("interp") or 1) if int(s.get("interp") or 1) in (1, 2, 4) else 1,
            # stills: AI-upscale before the cut-out, for sharper zooms
            "upscale": int(s.get("upscale") or 1) if int(s.get("upscale") or 1) in (1, 2, 4) else 1,
        }
        jid = uuid.uuid4().hex[:12]
        job = {"id": jid, "state": "queued", "stage": "waiting", "progress": 0, "error": None,
               "source": src, "source_key": key, "settings": settings, "cut": None}
        with self.cond:
            self.jobs[jid] = job
            self.queue.append(jid)
            self.cond.notify()
        return {"job": jid}

    def run(self):
        while True:
            with self.cond:
                while not self.queue:
                    self.cond.wait()
                job = self.jobs[self.queue.pop(0)]
            try:
                self.extend(job) if job.get("kind") == "extend" else self.cut(job)
            except Exception as e:
                traceback.print_exc()
                job.update(state="error", error=str(e))

    def cut(self, job):
        job.update(state="running", stage="getting the still", progress=0.01)
        source = self.fetch_source(job["source"], job["source_key"])
        cid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
        out = os.path.join(self.layer_dir(job["source_key"]), cid)
        st = job["settings"]
        if job["source"].get("span"):  # bullet time: cut every frame
            job.update(stage="getting the frames")
            frames, fps = self.fetch_frames(job["source"], job["source_key"])
            args = ["--sequence", "--fps", str(fps), "--interp", str(st.get("interp", 1)), frames, out]
        else:
            args = [source, out]
        args += ["--model", st["model"], "--people", st["people"], "--soft", str(st["soft"]),
                 "--grow", str(st["grow"]), "--fill", st["fill"]]
        if not job["source"].get("span") and st.get("upscale", 1) > 1:
            args += ["--upscale", str(st["upscale"])]
        try:
            self.script(job, args)
        except Exception:
            shutil.rmtree(out, ignore_errors=True)
            raise
        job.update(state="done", stage="done", progress=1, cut=next(c for c in self.cuts(job["source_key"]) if c["id"] == cid))
        log("cut %s/%s done in %.1fs" % (job["source_key"], cid, job["cut"]["meta"].get("seconds", 0)))

    def start_extend(self, body):
        key, cid = body.get("source_key"), body.get("cut") or ""
        if not re.match(r"^[\w-]+$", cid) or not os.path.isdir(os.path.join(self.layer_dir(key), cid)):
            raise KeyError("no such cut")
        # one extend per cut at a time
        for j in self.jobs.values():
            if j.get("kind") == "extend" and j["source_key"] == key and j["cut_id"] == cid and j["state"] in ("queued", "running"):
                return {"job": j["id"]}
        jid = uuid.uuid4().hex[:12]
        with self.cond:
            self.jobs[jid] = {"id": jid, "kind": "extend", "state": "queued", "stage": "waiting", "progress": 0,
                              "error": None, "source_key": key, "cut_id": cid, "cut": None}
            self.queue.append(jid)
            self.cond.notify()
        return {"job": jid}

    def extend(self, job):
        job.update(state="running", stage="extending the background", progress=0.01)
        t0 = time.time()
        self.script(job, ["--extend-only", os.path.join(self.layer_dir(job["source_key"]), job["cut_id"])])
        job.update(state="done", stage="done", progress=1,
                   cut=next(c for c in self.cuts(job["source_key"]) if c["id"] == job["cut_id"]))
        log("extended %s/%s in %.1fs" % (job["source_key"], job["cut_id"], time.time() - t0))

    def script(self, job, args):
        """Run parallax.py, reporting its stages on the job."""
        cmd = ["nice", "-n", "10", self.python, "-I", PARALLAX_SCRIPT] + args + ["--models", self.models_dir]
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        error = None
        for line in p.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if "error" in msg:
                error = msg["error"]
            elif "stage" in msg:
                job.update(stage=msg["stage"], progress=msg["progress"])
        err = p.stderr.read()
        if p.wait() != 0:
            raise RuntimeError(error or err.strip()[-400:] or "parallax.py failed")

    # ------------------------------------------------------------ element layers

    def cut_dir(self, key, cid):
        if not re.match(r"^[\w-]+$", cid or ""):
            raise ValueError("bad cut id")
        d = os.path.join(self.layer_dir(key), cid)
        if not os.path.isfile(os.path.join(d, "person.png")):
            raise KeyError("no such cut")
        return d

    def segment(self, body):
        """A mask of what the clicks pick out on a cut's person layer."""
        d = self.cut_dir(body.get("source_key"), body.get("cut"))
        pts = [[float(x), float(y), 1 if lab else 0] for x, y, lab in body.get("points") or []][:32]
        if not pts:
            raise ValueError("no points")
        req = json.dumps({"person": os.path.join(d, "person.png"), "background": os.path.join(d, "background.png"),
                          "cache": os.path.join(d, "sam_embedding.npy"), "points": pts}) + "\n"
        with self.seg_lock:
            for attempt in (0, 1):
                if self.seg_proc is None or self.seg_proc.poll() is not None:
                    self.seg_proc = subprocess.Popen(
                        [self.python, "-I", SEGMENT_SCRIPT, "--models", self.models_dir],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
                    ready = self.seg_proc.stdout.readline()
                    if not ready:
                        self.seg_proc = None
                        raise RuntimeError("the segment worker didn't start")
                try:
                    self.seg_proc.stdin.write(req)
                    self.seg_proc.stdin.flush()
                    line = self.seg_proc.stdout.readline()
                except (BrokenPipeError, OSError):
                    line = ""
                if line:
                    break
                self.seg_proc = None  # it died: start a fresh one once
            self.seg_used = time.time()
        if not line:
            raise RuntimeError("the segment worker stopped")
        out = json.loads(line)
        if "error" in out:
            raise RuntimeError(out["error"])
        for m in out["masks"]:
            m["mask"] = "data:image/png;base64," + m["mask"]
        return out

    def reap_segmenter(self):
        while True:
            time.sleep(30)
            with self.seg_lock:
                if self.seg_proc and self.seg_proc.poll() is None and time.time() - self.seg_used > SEGMENT_IDLE:
                    self.seg_proc.stdin.close()
                    try:
                        self.seg_proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        self.seg_proc.kill()
                    self.seg_proc = None
                    log("segment worker stopped (idle)")

    def save_mask(self, body):
        png = body.get("png") or ""
        if not png.startswith("data:image/png;base64,"):
            raise ValueError("png must be a PNG data URL")
        key = body.get("source_key")
        d = os.path.join(self.layer_dir(key), "masks")
        os.makedirs(d, exist_ok=True)
        name = uuid.uuid4().hex[:12] + ".png"
        with open(os.path.join(d, name), "wb") as f:
            f.write(base64.b64decode(png.split(",", 1)[1]))
        return {"file": "layers/%s/masks/%s" % (key, name)}

    def file(self, rel):
        rel = urllib.parse.unquote(rel)
        path = os.path.realpath(os.path.join(self.root, rel))
        if not path.startswith(os.path.realpath(self.root) + os.sep) or not os.path.isfile(path):
            raise KeyError("no such file")
        with open(path, "rb") as f:
            data = f.read()
        return data, mimetypes.guess_type(path)[0] or "application/octet-stream"

    # ------------------------------------------------------------ export

    def export_start(self, pid, body):
        self.load_project(pid)
        self.export_cancel(pid)
        w, h = int(body.get("width") or 1920), int(body.get("height") or 1080)
        fps, frames = float(body.get("fps") or 30), int(body.get("frames") or 0)
        if not (16 <= w <= 7680 and 16 <= h <= 4320 and 1 <= fps <= 120 and 1 <= frames <= 120 * 600):
            raise ValueError("bad export size")
        part = os.path.join(self.root, "exports", pid + ".mp4.part")
        cmd = ["nice", "-n", "10", "ffmpeg", "-v", "error", "-y", "-f", "image2pipe", "-c:v", "mjpeg",
               "-framerate", "%g" % fps, "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
               "-pix_fmt", "yuv420p", "-vf", "scale=%d:%d" % (w - w % 2, h - h % 2),
               "-movflags", "+faststart", "-f", "mp4", part]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        self.exports[pid] = Export(part, proc, frames)
        log("export %s started: %dx%d %g fps, %d frames" % (pid, w, h, fps, frames))
        return {"started": True}

    def export_frames(self, pid, data):
        ex = self.exports.get(pid)
        if not ex:
            raise KeyError("no export in progress")
        with ex.lock:
            ex.proc.stdin.write(data)
        return {"ok": True}

    def export_cancel(self, pid):
        ex = self.exports.pop(pid, None)
        if ex:
            ex.proc.kill()
            ex.proc.wait()
            try:
                os.remove(ex.path)
            except FileNotFoundError:
                pass
        return {"cancelled": bool(ex)}

    def export_finish(self, pid):
        ex = self.exports.pop(pid, None)
        if not ex:
            raise KeyError("no export in progress")
        ex.proc.stdin.close()
        err = ex.proc.stderr.read().decode(errors="replace")
        if ex.proc.wait() != 0:
            raise RuntimeError("ffmpeg failed: " + err.strip()[-400:])

        project = self.load_project(pid)
        previous = project.get("export") or {}
        # re-exports overwrite the same file, so Stash updates the same scene
        target = previous.get("path")
        if not target:
            safe = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", project.get("title") or "Parallax").strip()[:120]
            target = os.path.join(self.media_dir, "Parallax", "%s [%s].mp4" % (safe or "Parallax", pid))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.move(ex.path, target)
        self.stash.scan([target])
        sid = self.stash.find_by_path("scene", target)
        if not sid:
            raise RuntimeError("Stash did not import %s" % target)
        self.apply_metadata(sid, project)
        info = {"path": target, "scene_id": sid, "exported": time.time()}
        write_json(self.project_path(pid, ".export.json"), info)
        log("export %s -> scene %s (%s)" % (pid, sid, target))
        return info

    def apply_metadata(self, sid, project):
        src = project["source"]
        if src["kind"] == "image":
            s = self.stash.gql("query($id: ID!) { findImage(id: $id) { title studio { id } performers { id } "
                               "galleries { title studio { id } performers { id } } } }",
                               {"id": src["id"]})["findImage"] or {}
            # images here usually get performers and studio only through their gallery
            for g in s.get("galleries") or []:
                s["performers"] = s.get("performers") or g["performers"]
                s["studio"] = s.get("studio") or g["studio"]
                s["title"] = s.get("title") or g["title"]
            origin = "image %s" % src["id"]
        else:
            s = self.stash.gql("query($id: ID!) { findScene(id: $id) { title studio { id } performers { id } } }",
                               {"id": src["id"]})["findScene"] or {}
            t = float(src.get("time") or 0)
            origin = "scene %s at %d:%02d%s" % (src["id"], t // 60, t % 60, " (bullet time)" if src.get("span") else "")
        cur = self.stash.gql("query($id: ID!) { findScene(id: $id) { tags { id } } }", {"id": sid})["findScene"]
        tag = self.stash.ensure("tag", PARALLAX_TAG)
        inp = {
            "id": sid,
            "title": project.get("title") or "Parallax",
            "details": "Parallax Studio clip made from %s%s (project %s)." % (
                origin, (' "%s"' % s["title"]) if s.get("title") else "", project["id"]),
            "tag_ids": list(dict.fromkeys([t["id"] for t in cur["tags"]] + [tag])),
            "performer_ids": [p["id"] for p in s.get("performers") or []],
        }
        if s.get("studio"):
            inp["studio_id"] = s["studio"]["id"]
        self.stash.gql("mutation($i: SceneUpdateInput!) { sceneUpdate(input: $i) { id } }", {"i": inp})

    # ------------------------------------------------------------ AI jobs (frames, upscaling)

    # Jobs are kept in ai_jobs.json, so a restart of this service doesn't lose them:
    # a job that was queued or running is queued again (from the start: a partly
    # made video can't be continued) and leftover work files are removed.
    def ai_jobs_path(self):
        return os.path.join(self.root, "ai_jobs.json")

    def save_ai_jobs(self):
        with self.fps_cond:
            jobs = sorted(self.fps_jobs.values(), key=lambda j: j["created"])[-100:]
            write_json(self.ai_jobs_path(), jobs)

    def load_ai_jobs(self):
        for job in read_json(self.ai_jobs_path(), []) or []:
            if job.get("kind") in ("enhance", "enhance-image"):
                pass  # run by the enhance service; enhance_sync picks them up again
            elif job["state"] in ("queued", "running", "cancelling"):
                if job["state"] == "cancelling":
                    job["state"] = "cancelled"
                else:
                    job.update(state="queued", progress=0, frames=0, speed=None, restarted=True)
                    self.fps_queue.append(job["id"])
            self.fps_jobs[job["id"]] = job
        if os.path.isdir(FPS_WORK):
            for name in os.listdir(FPS_WORK):
                path = os.path.join(FPS_WORK, name)
                if path == ENHANCE_SRC:  # zip images queued for the enhance service: kept for a week
                    for f in os.listdir(path):
                        if time.time() - os.path.getmtime(os.path.join(path, f)) > 7 * 86400:
                            os.remove(os.path.join(path, f))
                    continue
                shutil.rmtree(path, ignore_errors=True) if os.path.isdir(path) else os.remove(path)
        if self.fps_queue:
            log("AI jobs: %d queued again after a restart" % len(self.fps_queue))

    def ai_jobs(self):
        with self.fps_cond:
            return sorted(self.fps_jobs.values(), key=lambda j: j["created"], reverse=True)[:50]

    # ------------------------------------------------------------ double frame rate

    def fps_speed(self):
        """Measured speed of the last run, in AI megapixel-frames made per second."""
        return self.speed("mpx_per_s", FPS_SPEED)

    # measured speeds of the last runs, so estimates match this machine
    def speed(self, key, default):
        return (read_json(os.path.join(self.root, "fps_speed.json")) or {}).get(key, default)

    def save_speed(self, key, value):
        path = os.path.join(self.root, "fps_speed.json")
        data = read_json(path) or {}
        data[key] = value
        write_json(path, data)

    def fps_info(self, sid):
        """The scene, its file, its markers and how long each option would take for
        the whole scene and for each marker's part."""
        sc = self.stash.gql(
            "query($id: ID!) { findScene(id: $id) { id title files { path duration frame_rate width height } "
            "scene_markers { id title seconds end_seconds primary_tag { id name } tags { id name } } } }",
            {"id": sid})["findScene"]
        if not sc or not sc["files"]:
            raise KeyError("no such scene")
        f = sc["files"][0]
        fps = f["frame_rate"] or 30
        mpx = (f["width"] or 1920) * (f["height"] or 1080) / 1e6
        speed = self.fps_speed()
        up_speed = self.speed("upscale_mpx_per_s", UPSCALE_SPEED)
        # RIFE options make factor - 1 AI frames per source frame; upscaling works on every frame
        cost = lambda secs: {k: round(secs * fps * mpx / up_speed) if o[0] == "upscale" else
                             round(secs * fps * (o[1] - 1) * mpx / speed) for k, o in FPS_OPTIONS.items()}
        markers = []
        for m in sorted(sc.get("scene_markers") or [], key=lambda m: m["seconds"]):
            end = m["end_seconds"] if m.get("end_seconds") and m["end_seconds"] > m["seconds"] else m["seconds"] + MARKER_SECONDS
            end = min(end, f["duration"] or end)
            markers.append({"id": m["id"], "title": m["title"] or m["primary_tag"]["name"], "start": m["seconds"],
                            "duration": round(max(0.1, end - m["seconds"]), 3), "has_end": bool(m.get("end_seconds")),
                            "tag_ids": [m["primary_tag"]["id"]] + [x["id"] for x in m["tags"]],
                            "seconds": cost(max(0.1, end - m["seconds"]))})
        return sc, f, {"frames": int((f["duration"] or 0) * fps), "fps": fps, "duration": f["duration"],
                       "width": f["width"], "height": f["height"], "seconds": cost(f["duration"] or 0), "markers": markers}

    def fps_status(self, sid):
        jobs = sorted((j for j in self.fps_jobs.values() if j["scene_id"] == str(sid)), key=lambda j: j["created"], reverse=True)
        try:
            estimate = self.fps_info(sid)[2]
        except KeyError:
            estimate = None
        return {"jobs": jobs[:10], "job": jobs[0] if jobs else None, "estimate": estimate,
                "available": os.path.exists(os.path.join(self.models_dir, OPTIONAL_MODELS["rife"])),
                "queued": len(self.fps_queue)}

    def start_fps(self, body):
        sid = str(int(body.get("scene_id")))
        option = body.get("option") or "smooth2"
        if option not in FPS_OPTIONS:
            raise ValueError("unknown option")
        if option == "upscale4k":
            f = self.fps_info(str(int(body.get("scene_id"))))[1]
            if (f["width"] or 0) >= UHD_WIDTH:
                raise ValueError("this scene is already 4K wide")
        marker_id = str(body["marker_id"]) if body.get("marker_id") else None
        if option == "clip" and not marker_id:
            raise ValueError("clip needs a marker")
        for j in self.fps_jobs.values():
            if j["scene_id"] == sid and j["option"] == option and j.get("marker_id") == marker_id \
                    and j["state"] in ("queued", "running"):
                return {"job": j["id"]}
        sc, f, est = self.fps_info(sid)
        if f["path"].lower().find(".zip" + os.sep) >= 0:
            raise ValueError("this scene's file is inside a zip")
        marker = next((m for m in est["markers"] if m["id"] == marker_id), None) if marker_id else None
        if marker_id and not marker:
            raise KeyError("no such marker")
        jid = uuid.uuid4().hex[:12]
        seconds = (marker or est)["seconds"][option]
        job = {"id": jid, "scene_id": sid, "option": option, "marker_id": marker_id, "marker": marker,
               "title": (sc["title"] or os.path.basename(f["path"])) + (" – " + marker["title"] if marker else ""),
               "state": "queued", "progress": 0, "frames": 0,
               "total": int((marker["duration"] if marker else (f["duration"] or 0)) * est["fps"]),
               "speed": None, "eta": seconds, "error": None, "scene": None, "created": time.time()}
        with self.fps_cond:
            self.fps_jobs[jid] = job
            self.fps_queue.append(jid)
            self.fps_cond.notify()
        self.save_ai_jobs()
        log("AI frames (%s) queued for scene %s%s (estimate %ds)" % (
            option, sid, " marker %s" % marker_id if marker else "", seconds))
        return {"job": jid}

    def cancel_fps(self, jid):
        job = self.fps_jobs.get(jid)
        if not job:
            raise KeyError("no such job")
        if job.get("kind") in ("enhance", "enhance-image"):
            return self.cancel_enhance(job)
        with self.fps_cond:
            if job["state"] == "queued":
                self.fps_queue.remove(jid)
                job.update(state="cancelled")
            elif job["state"] == "running":
                job.update(state="cancelling")
                if self.fps_proc:
                    try:
                        self.fps_proc.kill()
                    except OSError:
                        pass
        self.save_ai_jobs()
        return {"cancelled": jid}

    def run_fps(self):
        while True:
            with self.fps_cond:
                while not self.fps_queue:
                    self.fps_cond.wait()
                job = self.fps_jobs[self.fps_queue.pop(0)]
            job["state"] = "running"
            self.save_ai_jobs()
            try:
                (self.upscale_images if job.get("kind") == "upscale" else self.double_fps)(job)
            except Exception as e:
                if job["state"] == "cancelling":
                    job.update(state="cancelled")
                else:
                    traceback.print_exc()
                    job.update(state="error", error=str(e))
            finally:
                self.fps_proc = None
                self.save_ai_jobs()

    def double_fps(self, job):
        sc, f, est = self.fps_info(job["scene_id"])
        mode, factor, file_sfx, title_sfx, tag = FPS_OPTIONS[job["option"]]
        new_fps = round((f["frame_rate"] or 30) * factor) if mode == "smooth" else None
        marker = job.get("marker")
        job.update(state="running", started=time.time())
        os.makedirs(FPS_WORK, exist_ok=True)
        work = os.path.join(FPS_WORK, job["id"] + ".mp4")
        stem, _ = os.path.splitext(f["path"])
        sfx = file_sfx.format(fps=new_fps)
        if marker:  # "<file> [<marker> 1m23s][ [slow-mo 2x]].mp4"
            safe = re.sub(r'[\\/:*?"<>|\x00-\x1f\[\]]+', " ", marker["title"]).strip()[:60] or "marker"
            m, s = divmod(int(marker["start"]), 60)
            stem = "%s [%s %dm%02ds]" % (stem, safe, m, s)
        target = "%s%s.mp4" % (stem, " " + sfx if sfx else "")
        if os.path.exists(target):
            raise RuntimeError("%s already exists" % os.path.basename(target))
        cmd = ["nice", "-n", "15", self.python, "-I", INTERPOLATE_SCRIPT, f["path"], work, "--models", self.models_dir,
               "--mode", mode, "--factor", "2" if mode == "upscale" else str(max(2, factor))]
        if job["option"] == "upscale4k":
            cmd += ["--target-width", str(UHD_WIDTH)]
        if marker:
            cmd += ["--start", "%.3f" % marker["start"], "--duration", "%.3f" % marker["duration"]]
        self.fps_proc = p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        error = None
        mpx = (f["width"] or 1920) * (f["height"] or 1080) / 1e6
        for line in p.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if "error" in msg:
                error = msg["error"]
            elif "frames" in msg:
                total = max(msg["total"], 1)
                speed = msg.get("fps") or 0
                job.update(frames=msg["frames"], total=total, progress=min(0.99, msg["frames"] / total), speed=speed,
                           eta=round((total - msg["frames"]) / speed) if speed else None)
        err = p.stderr.read()
        if p.wait() != 0:
            try:
                os.remove(work)
            except FileNotFoundError:
                pass
            if job["state"] == "cancelling":
                job.update(state="cancelled")
                log("AI frames cancelled for scene %s" % job["scene_id"])
                return
            raise RuntimeError(error or err.strip()[-400:] or "interpolate.py failed")
        if job.get("speed") and mode == "upscale":  # source frames per second -> megapixels per second
            self.save_speed("upscale_mpx_per_s", job["speed"] * mpx)
        elif job.get("speed") and factor > 1:  # source frames per second -> AI megapixel-frames per second
            self.save_speed("mpx_per_s", job["speed"] * (factor - 1) * mpx)
        shutil.move(work, target)
        self.stash.scan([target])
        new = self.stash.find_by_path("scene", target)
        if not new:
            raise RuntimeError("Stash did not import %s" % target)
        self.copy_scene_metadata(sc["id"], new, title_sfx.format(fps=new_fps), tag, job["option"], marker)
        job.update(state="done", progress=1, scene=new, finished=time.time())
        log("AI frames (%s): scene %s -> %s (%s)" % (job["option"], job["scene_id"], new, target))

    def copy_scene_metadata(self, sid, new, title_sfx, tag_name, option, marker=None, what=None):
        s = self.stash.gql(
            "query($id: ID!) { findScene(id: $id) { title details date code rating100 studio { id } performers { id } tags { id } } }",
            {"id": sid})["findScene"]
        tags = [t["id"] for t in s["tags"]] + (marker["tag_ids"] if marker else [])
        if tag_name:
            tags.append(self.stash.ensure("tag", tag_name))
        what = {"clip": "", "smooth2": "AI frame-rate doubling (RIFE)", "slowmo2": "AI slow motion 2× (RIFE)",
                "slowmo4": "AI slow motion 4× (RIFE)", "upscale2": "AI upscale 2× (Real-ESRGAN)",
                "upscale4k": "AI upscale to 4K (Real-ESRGAN, one 4× pass)"}.get(option, "") if what is None else what
        title = s["title"] or "Scene %s" % sid
        if marker:
            title += " – " + marker["title"]
            m1, s1 = divmod(int(marker["start"]), 60)
            m2, s2 = divmod(int(marker["start"] + marker["duration"]), 60)
            note = "Marker \"%s\" (%d:%02d–%d:%02d) of scene %s%s." % (marker["title"], m1, s1, m2, s2, sid, ", " + what if what else "")
        else:
            note = "%s of scene %s." % (what, sid)
        inp = {
            "id": new,
            "title": "%s %s" % (title, title_sfx) if title_sfx else title,
            "details": "\n\n".join(x for x in ((s["details"] or "").strip(), note) if x),
            "tag_ids": list(dict.fromkeys(tags)),
            "performer_ids": [p["id"] for p in s["performers"]],
        }
        for k in ("date", "code", "rating100"):
            if s.get(k):
                inp[k] = s[k]
        if s.get("studio"):
            inp["studio_id"] = s["studio"]["id"]
        self.stash.gql("mutation($i: SceneUpdateInput!) { sceneUpdate(input: $i) { id } }", {"i": inp})

    # ------------------------------------------------------------ Enhance Studio
    # The work is done by the enhance service (/media/matt/WD/tmp/enhance, its own
    # API at ENHANCE_URL). This side finds the scene's file, names the new one, and
    # when the service has made it, scans it in with the scene's metadata. Each
    # service job is mirrored in fps_jobs (kind "enhance", the service's id) so the
    # Queues page lists it with the other AI jobs; enhance_sync keeps it current.

    def enhance_api(self, method, path, body=None, raw=False, timeout=30):
        req = urllib.request.Request(ENHANCE_URL + path, method=method,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"X-Token": ENHANCE_TOKEN, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read()
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read())["error"]
            except (ValueError, KeyError, OSError):
                msg = "enhance service: HTTP %d" % e.code
            raise KeyError(msg) if e.code == 404 else ValueError(msg)
        except OSError as e:
            raise ValueError("the enhance service isn't running at %s (systemctl --user start enhance): %s"
                             % (ENHANCE_URL, getattr(e, "reason", e)))
        return data if raw else json.loads(data)

    def enhance_scene_info(self, sid):
        sc = self.stash.gql(
            "query($id: ID!) { findScene(id: $id) { id title "
            "files { path duration frame_rate width height video_codec bit_rate size } "
            "scene_markers { id title seconds end_seconds primary_tag { id name } tags { id name } } } }",
            {"id": str(int(sid))})["findScene"]
        if not sc or not sc["files"]:
            raise KeyError("no such scene")
        f = sc["files"][0]
        if f["path"].lower().find(".zip" + os.sep) >= 0:
            raise ValueError("this scene's file is inside a zip")
        markers = []
        for m in sorted(sc.get("scene_markers") or [], key=lambda m: m["seconds"]):
            end = m["end_seconds"] if m.get("end_seconds") and m["end_seconds"] > m["seconds"] else m["seconds"] + MARKER_SECONDS
            end = min(end, f["duration"] or end)
            markers.append({"id": m["id"], "title": m["title"] or m["primary_tag"]["name"], "start": m["seconds"],
                            "duration": round(max(0.1, end - m["seconds"]), 3), "has_end": bool(m.get("end_seconds")),
                            "tag_ids": [m["primary_tag"]["id"]] + [x["id"] for x in m["tags"]]})
        return sc, f, {"id": sc["id"], "title": sc["title"] or os.path.basename(f["path"]), "path": f["path"],
                       "file": os.path.basename(f["path"]), "width": f["width"], "height": f["height"],
                       "fps": f["frame_rate"] or 30, "duration": f["duration"] or 0, "codec": f["video_codec"],
                       "bit_rate": f["bit_rate"], "size": f["size"], "sar": "1:1", "interlace": None,
                       "duplicates": None}, markers

    def enhance_status(self, sid):
        sc, f, scene, markers = self.enhance_scene_info(sid)
        jobs = sorted((j for j in self.fps_jobs.values() if j.get("kind") == "enhance" and j["scene_id"] == scene["id"]),
                      key=lambda j: j["created"], reverse=True)
        res = {"scene": scene, "markers": markers, "jobs": jobs[:20], "queued": 0, "service_error": None,
               "available": {"vs": False, "rife": False, "upscale": False}, "speeds": {}, "calibration": 1.0}
        try:
            st = self.enhance_api("GET", "/status")
            self.enhance_last = st  # its speeds keep the estimates sensible while it's down
            res.update(available=st["available"], speeds=st["speeds"], calibration=st["calibration"],
                       queued=st["queued"] + (1 if st["running"] else 0))
            info = self.enhance_api("POST", "/probe", {"path": f["path"]}, timeout=180)
            scene.update(sar=info["sar"], interlace=info["interlace"], duplicates=info.get("duplicates"))
        except ValueError as e:
            res["service_error"] = str(e)
            last = getattr(self, "enhance_last", None)
            if last:
                res.update(speeds=last["speeds"], calibration=last["calibration"])
        return res

    def enhance_range(self, body, f, markers):
        """(start, duration, marker or None) of the part to process."""
        if body.get("marker_id"):
            m = next((m for m in markers if m["id"] == str(body["marker_id"])), None)
            if not m:
                raise KeyError("no such marker")
            return m["start"], m["duration"], m
        start = max(0.0, float(body.get("start") or 0))
        dur = max(0.0, float(body.get("duration") or 0))
        total = f["duration"] or 0
        if total and start >= total:
            raise ValueError("the start is past the end of the video")
        if dur and total:
            dur = min(dur, total - start)
        return start, dur, None

    def start_enhance(self, body):
        sid = str(int(body.get("scene_id")))
        settings = body.get("settings") or {}
        if not isinstance(settings, dict):
            raise ValueError("settings must be an object")
        sc, f, scene, markers = self.enhance_scene_info(sid)
        start, dur, marker = self.enhance_range(body, f, markers)
        label = re.sub(r"[^\w .,×+-]+", "", str(body.get("label") or "enhanced"))[:48].strip() or "enhanced"
        stem, _ = os.path.splitext(f["path"])
        if marker:  # "<file> [<marker> 1m23s] [enhanced …].mp4", next to the original
            safe = re.sub(r'[\\/:*?"<>|\x00-\x1f\[\]]+', " ", marker["title"]).strip()[:60] or "marker"
            stem = "%s [%s %dm%02ds]" % (stem, safe, *divmod(int(marker["start"]), 60))
        elif start or dur:
            stem = "%s [%dm%02ds]" % (stem, *divmod(int(start), 60))
        estimate = int(body.get("estimate") or 0) or None
        length = dur or max(0.0, (f["duration"] or 0) - start)
        part = "" if not (start or dur) else " – " + (marker["title"] if marker else "%d:%02d–%d:%02d" % (
            start // 60, start % 60, (start + length) // 60, (start + length) % 60))
        summary = str(body.get("summary") or "")[:2000]
        remote = self.enhance_api("POST", "/jobs", {
            "input": f["path"], "output": "%s [%s].mp4" % (stem, label), "settings": settings, "start": start,
            "duration": dur, "estimate": estimate, "meta": {"client": "stash", "scene_id": sid, "label": label,
                                                            "title": scene["title"] + part, "summary": summary}}, timeout=180)
        if remote["id"] in self.fps_jobs:  # the same job again (a double click)
            return {"job": remote["id"]}
        job = {"id": remote["id"], "kind": "enhance", "scene_id": sid, "option": "enhance",
               "marker_id": marker and marker["id"], "marker": marker, "start": start, "duration": dur,
               "settings": settings, "label": label, "summary": summary,
               "title": scene["title"] + part, "state": "queued", "progress": 0, "frames": 0, "total": remote["total"],
               "speed": None, "eta": estimate, "estimate": estimate, "error": None, "scene": None, "created": time.time()}
        with self.fps_cond:
            self.fps_jobs[job["id"]] = job
        self.save_ai_jobs()
        self.enhance_wake.set()
        log("enhance (%s) queued for scene %s%s: service job %s" % (label, sid, part, job["id"]))
        return {"job": job["id"]}

    def enhance_sync(self):
        """Copies the service's progress into the mirrored jobs, and imports
        each finished video into Stash (also ones finished while this was down)."""
        while True:
            active = [j for j in list(self.fps_jobs.values())
                      if j.get("kind") in ("enhance", "enhance-image") and j["state"] in ("queued", "running", "cancelling")]
            if not active:
                self.enhance_wake.wait(60)
                self.enhance_wake.clear()
                continue
            try:
                remote = {r["id"]: r for r in self.enhance_api("GET", "/jobs?ids=" + ",".join(j["id"] for j in active))}
            except ValueError as e:  # the service is down: try again later
                for j in active:
                    j["service_error"] = str(e)
                time.sleep(10)
                continue
            changed = False
            for j in active:
                r = remote.get(j["id"])
                j.pop("service_error", None)
                if not r:
                    j.update(state="error", error="the enhance service has no record of this job")
                    changed = True
                    continue
                before = j["state"]
                for k in ("progress", "frames", "total", "speed", "eta", "started"):
                    j[k] = r.get(k)
                if r.get("result"):
                    j["output"] = r["result"]
                if r["state"] == "done":
                    (self.enhance_image_import if j["kind"] == "enhance-image" else self.enhance_import)(j, r)
                elif r["state"] in ("error", "cancelled"):
                    j.update(state=r["state"], error=r.get("error"), finished=r.get("finished"))
                elif j["state"] != "cancelling" or r["state"] == "cancelling":
                    j["state"] = r["state"]
                changed |= j["state"] != before
            if changed:
                self.save_ai_jobs()
            time.sleep(2)

    def enhance_import(self, job, remote):
        target = remote["output_path"]
        job.update(state="running", progress=0.99, importing=True)
        try:
            self.stash.scan([target])
            new = self.stash.find_by_path("scene", target)
            if not new:
                raise RuntimeError("Stash did not import %s" % target)
            what = "Enhance Studio (%s): %s" % (job["label"], (job.get("summary") or "").rstrip(". ") or job["label"])
            if not job.get("marker") and (job.get("start") or job.get("duration")):
                what += " (from %d:%02d)" % divmod(int(job.get("start") or 0), 60)
            self.copy_scene_metadata(job["scene_id"], new, "(%s)" % job["label"], ENHANCE_TAG, "enhance",
                                     job.get("marker"), what=what)
            job.update(state="done", progress=1, scene=new, path=target, finished=remote.get("finished") or time.time())
            log("enhance (%s): scene %s -> %s (%s)" % (job["label"], job["scene_id"], new, target))
        except Exception as e:
            traceback.print_exc()
            job.update(state="error", error="made %s, but importing it failed: %s" % (os.path.basename(target), e))
        job.pop("importing", None)

    def cancel_enhance(self, job):
        r = self.enhance_api("POST", "/jobs/%s/cancel" % job["id"])
        job["state"] = "cancelled" if r["state"] == "cancelled" else "cancelling"
        self.save_ai_jobs()
        self.enhance_wake.set()
        return {"cancelled": job["id"]}

    # ------------------------------------------------------------ the image studio
    # (/enhance-image?image=ID|gallery=ID). Made by the enhance service too; the
    # results go to <library>/Enhanced/<gallery or "Images">/ and are scanned in
    # with the originals' metadata, a gallery's into a new gallery.

    def image_source(self, im):
        """A path the service can read: the file itself, or a copy of an image
        that lives inside a zip (fetched through Stash)."""
        if im["path"].lower().find(".zip" + os.sep) < 0:
            return im["path"]
        os.makedirs(ENHANCE_SRC, exist_ok=True)
        ext = os.path.splitext(im["path"])[1].lower() or ".jpg"
        dst = os.path.join(ENHANCE_SRC, "%s%s" % (im["id"], ext))
        if not os.path.exists(dst):
            base = self.stash.url[: -len("/graphql")]
            headers = {"ApiKey": self.stash.api_key} if self.stash.api_key else {}
            with self.http_request("%s/image/%s/image" % (base, im["id"]), headers) as r, open(dst + ".part", "wb") as f:
                shutil.copyfileobj(r, f)
            os.replace(dst + ".part", dst)
        return dst

    def image_by_id(self, image_id):
        imgs, _ = self.upscale_targets(image_id=str(int(image_id)))
        if not imgs:
            raise KeyError("no such image")
        return imgs[0]

    def enhance_image_status(self, q):
        imgs, g = self.upscale_targets(image_id=q.get("image"), gallery_id=q.get("gallery"))
        key = ("gallery_id", q.get("gallery")) if q.get("gallery") else ("image_id", q.get("image"))
        jobs = sorted((j for j in self.fps_jobs.values() if j.get("kind") == "enhance-image" and j.get(key[0]) == key[1]),
                      key=lambda j: j["created"], reverse=True)
        res = {"title": (g["title"] if g else imgs[0]["title"] if imgs else "") or "",
               "images": [{"key": i["id"], "name": os.path.basename(i["path"]), "width": i["width"], "height": i["height"]} for i in imgs],
               "jobs": jobs[:10], "queued": 0, "service_error": None, "available": {}, "speeds": {}, "calibration": 1.0}
        try:
            st = self.enhance_api("GET", "/status")
            self.enhance_last = st
            res.update(available=st["images"]["available"], speeds=st["images"]["speeds"], calibration=st["images"]["calibration"],
                       queued=st["queued"] + (1 if st["running"] else 0))
        except ValueError as e:
            res["service_error"] = str(e)
            last = getattr(self, "enhance_last", None)
            if last and "images" in last:
                res.update(speeds=last["images"]["speeds"], calibration=last["images"]["calibration"])
        return res

    def enhance_image_probe(self, body):
        return self.enhance_api("POST", "/image/probe", {"path": self.image_source(self.image_by_id(body.get("image_id")))}, timeout=180)

    def enhance_image_segment(self, body):
        return self.enhance_api("POST", "/image/segment", {"input": self.image_source(self.image_by_id(body.get("image_id"))),
                                                           "points": body.get("points") or []}, timeout=300)

    def enhance_image_preview(self, body):
        im = self.image_by_id(body.get("image_id"))
        r = self.enhance_api("POST", "/image/preview", {"input": self.image_source(im), "settings": body.get("settings") or {},
                                                        "mask": body.get("mask")}, timeout=900)
        out = os.path.join(self.root, "enhance-preview", "img-%s" % im["id"])
        shutil.rmtree(out, ignore_errors=True)
        os.makedirs(out)
        names = {}
        for k in ("before", "after"):
            name = os.path.basename(r[k].split("?")[0])
            with open(os.path.join(out, name), "wb") as fh:
                fh.write(self.enhance_api("GET", r[k], raw=True))
            names[k] = "enhance-preview/img-%s/%s?v=%d" % (im["id"], name, int(time.time()))
        return dict(r, **names)

    @staticmethod
    def image_out_ext(path, settings):
        fmt = (settings.get("output") or {}).get("format", "keep")
        src = os.path.splitext(path)[1].lower().lstrip(".")
        ext = {"jpeg": "jpg", "jpg": "jpg", "png": "png", "webp": "webp"}.get(src, "png") if fmt == "keep" else fmt
        bg = settings.get("background") or {}
        if bg.get("on") and bg.get("mode") == "remove" and ext == "jpg":
            ext = "png"  # JPEG can't be transparent
        return ext if ext in ("jpg", "png", "webp") else "png"

    def start_enhance_image(self, body):
        image_id = str(int(body["image_id"])) if body.get("image_id") else None
        gallery_id = str(int(body["gallery_id"])) if body.get("gallery_id") else None
        if not image_id and not gallery_id:
            raise ValueError("image_id or gallery_id needed")
        settings = body.get("settings") or {}
        masks = body.get("masks") or {}
        imgs, g = self.upscale_targets(image_id, gallery_id)
        only = str(body["only"]) if body.get("only") else None
        if only:
            imgs = [i for i in imgs if i["id"] == only]
        if not imgs:
            raise ValueError("no images")
        label = re.sub(r"[^\w .,×+-]+", "", str(body.get("label") or "enhanced"))[:48].strip() or "enhanced"
        title = (g["title"] if g else imgs[0]["title"]) or os.path.basename(imgs[0]["path"])
        if g and only:
            title += " – " + (imgs[0]["title"] or os.path.basename(imgs[0]["path"]))
        name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", title).strip()[:80] or "Images"
        folder = os.path.join(self.media_dir, ENHANCED_DIR, "%s [%s]" % (name, label) if g and not only else "Images")
        os.makedirs(folder, exist_ok=True)
        items = []
        for im in imgs:
            stem = os.path.splitext(os.path.basename(im["path"]))[0]
            items.append({"input": self.image_source(im), "mask": masks.get(im["id"]),
                          "output": os.path.join(folder, "%s [%s].%s" % (stem, label, self.image_out_ext(im["path"], settings)))})
        summary = str(body.get("summary") or "")[:2000]
        estimate = int(body.get("estimate") or 0) or None
        remote = self.enhance_api("POST", "/jobs", {
            "kind": "image", "items": items, "settings": settings, "estimate": estimate,
            "meta": {"client": "stash", "image_id": image_id, "gallery_id": gallery_id, "label": label, "title": title,
                     "summary": summary}}, timeout=600)
        if remote["id"] in self.fps_jobs:
            return {"job": remote["id"]}
        job = {"id": remote["id"], "kind": "enhance-image", "image_id": image_id, "gallery_id": gallery_id, "only": only,
               "scene_id": None, "option": "enhance-image", "marker_id": None, "marker": None,
               "image_ids": [i["id"] for i in imgs], "folder": folder, "label": label, "summary": summary, "title": title,
               "state": "queued", "progress": 0, "frames": 0, "total": len(imgs), "speed": None, "eta": estimate,
               "estimate": estimate, "error": None, "image": None, "gallery": None, "created": time.time()}
        with self.fps_cond:
            self.fps_jobs[job["id"]] = job
        self.save_ai_jobs()
        self.enhance_wake.set()
        log("enhance images (%s) queued: %s %s, %d images: service job %s" % (
            label, "gallery" if gallery_id else "image", gallery_id or image_id, len(imgs), job["id"]))
        return {"job": job["id"]}

    def enhance_image_import(self, job, remote):
        """Scan the new images in with the originals' metadata (images often only
        get performers and studio through their gallery), tagged ENHANCE_TAG; a
        whole gallery's go into a new gallery "<title> (<label>)"."""
        job.update(state="running", progress=0.99, importing=True)
        try:
            outs = remote.get("output_paths") or []
            self.stash.scan([job["folder"]])
            tag = self.stash.ensure("tag", ENHANCE_TAG)
            note = "Enhance Studio (%s): %s" % (job["label"], (job.get("summary") or "").rstrip(". ") or job["label"])
            new_gallery = None
            if job.get("gallery_id") and not job.get("only"):
                gm = self.stash.gql("query($id: ID!) { findGallery(id: $id) { title date details photographer studio { id } "
                                    "performers { id } tags { id } } }", {"id": job["gallery_id"]})["findGallery"]
                inp = {"title": "%s (%s)" % (gm["title"] or job["title"], job["label"]),
                       "details": "\n\n".join(x for x in ((gm["details"] or "").strip(), "%s, of gallery %s." % (note, job["gallery_id"])) if x),
                       "tag_ids": list(dict.fromkeys([t["id"] for t in gm["tags"]] + [tag])),
                       "performer_ids": [p["id"] for p in gm["performers"]]}
                for k in ("date", "photographer"):
                    if gm.get(k):
                        inp[k] = gm[k]
                if gm.get("studio"):
                    inp["studio_id"] = gm["studio"]["id"]
                new_gallery = self.stash.gql("mutation($i: GalleryCreateInput!) { galleryCreate(input: $i) { id } }", {"i": inp})["galleryCreate"]["id"]
            last, made = None, 0
            for src_id, target in zip(job["image_ids"], outs):
                if not target:
                    continue
                found = self.stash.gql("query($f: ImageFilterType) { findImages(image_filter: $f) { images { id } } }",
                                       {"f": {"path": {"value": target, "modifier": "EQUALS"}}})["findImages"]["images"]
                if not found:
                    continue
                new = found[0]["id"]
                src = self.stash.gql("query($id: ID!) { findImage(id: $id) { title date details photographer studio { id } "
                                     "performers { id } tags { id } galleries { performers { id } studio { id } } } }",
                                     {"id": src_id})["findImage"]
                perfs = [p["id"] for p in src["performers"]] or [p["id"] for gg in src["galleries"] for p in gg["performers"]]
                studio = src["studio"] or next((gg["studio"] for gg in src["galleries"] if gg["studio"]), None)
                inp = {"id": new, "tag_ids": list(dict.fromkeys([t["id"] for t in src["tags"]] + [tag])),
                       "performer_ids": list(dict.fromkeys(perfs)),
                       "details": "\n\n".join(x for x in ((src["details"] or "").strip(), "%s, of image %s." % (note, src_id)) if x)}
                for k in ("title", "date", "photographer"):
                    if src.get(k):
                        inp[k] = src[k]
                if studio:
                    inp["studio_id"] = studio["id"]
                if new_gallery:
                    inp["gallery_ids"] = [new_gallery]
                self.stash.gql("mutation($i: ImageUpdateInput!) { imageUpdate(input: $i) { id } }", {"i": inp})
                last, made = new, made + 1
            if not made:
                raise RuntimeError("Stash did not import the new images (in %s)" % job["folder"])
            failed = remote.get("failed") or []
            job.update(state="done", progress=1, image=last if not new_gallery else None, gallery=new_gallery,
                       failed=failed, finished=remote.get("finished") or time.time())
            log("enhance images (%s): %d made%s -> %s" % (job["label"], made, ", %d failed" % len(failed) if failed else "",
                                                          ("gallery %s" % new_gallery) if new_gallery else ("image %s" % last)))
        except Exception as e:
            traceback.print_exc()
            job.update(state="error", error="made the images, but importing them failed: %s" % e)
        job.pop("importing", None)

    def enhance_preview(self, body):
        """One frame through deinterlace, clean-up and upscale, next to the original
        (made by the service, copied here for /parallax/file/)."""
        sid = str(int(body.get("scene_id")))
        sc, f, scene, markers = self.enhance_scene_info(sid)
        r = self.enhance_api("POST", "/preview", {"input": f["path"], "time": float(body.get("time") or 0),
                                                  "settings": body.get("settings") or {}}, timeout=900)
        out = os.path.join(self.root, "enhance-preview", sid)
        os.makedirs(out, exist_ok=True)
        for name in ("before", "after"):
            with open(os.path.join(out, name + ".jpg"), "wb") as fh:
                fh.write(self.enhance_api("GET", r[name], raw=True))
        v = int(time.time())
        return {"before": "enhance-preview/%s/before.jpg?v=%d" % (sid, v), "after": "enhance-preview/%s/after.jpg?v=%d" % (sid, v),
                "width": r.get("width"), "height": r.get("height"), "time": r.get("time")}

    # ------------------------------------------------------------ upscale images

    def upscale_targets(self, image_id=None, gallery_id=None):
        """(images [{id, title, path, width, height}], gallery or None) to upscale."""
        fields = "id title files { path width height }"
        if gallery_id:
            g = self.stash.gql("query($id: ID!) { findGallery(id: $id) { id title files { path } folder { path } } }",
                               {"id": gallery_id})["findGallery"]
            if not g:
                raise KeyError("no such gallery")
            imgs = self.stash.gql(
                "query($f: ImageFilterType) { findImages(filter: {per_page: -1, sort: \"path\"}, image_filter: $f) "
                "{ images { %s } } }" % fields, {"f": {"galleries": {"value": [gallery_id], "modifier": "INCLUDES"}}})["findImages"]["images"]
        else:
            im = self.stash.gql("query($id: ID!) { findImage(id: $id) { %s } }" % fields, {"id": image_id})["findImage"]
            if not im:
                raise KeyError("no such image")
            imgs, g = [im], None
        out = [{"id": i["id"], "title": i["title"], "path": i["files"][0]["path"], "width": i["files"][0]["width"] or 0,
                "height": i["files"][0]["height"] or 0} for i in imgs if i["files"]]
        return out, g

    def upscale_estimate(self, imgs):
        speed = self.speed("image_mpx_per_s", IMAGE_SPEED)
        mpx = sum(i["width"] * i["height"] for i in imgs) / 1e6
        # 4x costs about the same model time as 2x (2x is 4x scaled down), plus bigger files
        return {"2": round(mpx / speed + IMAGE_OVERHEAD * len(imgs)), "4": round(mpx / speed * 1.15 + IMAGE_OVERHEAD * len(imgs))}

    def upscale_status(self, q):
        key = ("gallery_id", q.get("gallery")) if q.get("gallery") else ("image_id", q.get("image"))
        jobs = sorted((j for j in self.fps_jobs.values() if j.get("kind") == "upscale" and j.get(key[0]) == key[1]),
                      key=lambda j: j["created"], reverse=True)
        try:
            imgs, _ = self.upscale_targets(image_id=q.get("image"), gallery_id=q.get("gallery"))
            estimate = {"images": len(imgs), "seconds": self.upscale_estimate(imgs)}
        except KeyError:
            estimate = None
        return {"jobs": jobs[:10], "estimate": estimate,
                "available": os.path.exists(os.path.join(self.models_dir, OPTIONAL_MODELS["upscale"]))}

    def start_upscale(self, body):
        factor = int(body.get("factor") or 2)
        if factor not in (2, 4):
            raise ValueError("factor must be 2 or 4")
        image_id = str(body["image_id"]) if body.get("image_id") else None
        gallery_id = str(body["gallery_id"]) if body.get("gallery_id") else None
        if not image_id and not gallery_id:
            raise ValueError("image_id or gallery_id needed")
        for j in self.fps_jobs.values():
            if j.get("kind") == "upscale" and j.get("image_id") == image_id and j.get("gallery_id") == gallery_id \
                    and j["factor"] == factor and j["state"] in ("queued", "running"):
                return {"job": j["id"]}
        imgs, g = self.upscale_targets(image_id, gallery_id)
        if not imgs:
            raise ValueError("no images to upscale")
        jid = uuid.uuid4().hex[:12]
        job = {"id": jid, "kind": "upscale", "image_id": image_id, "gallery_id": gallery_id, "factor": factor,
               "scene_id": None, "option": "upscale%d" % factor, "marker_id": None, "marker": None,
               "title": (g["title"] if g else imgs[0]["title"]) or os.path.basename(imgs[0]["path"]),
               "state": "queued", "progress": 0, "frames": 0, "total": len(imgs), "speed": None,
               "eta": self.upscale_estimate(imgs)[str(factor)], "error": None, "image": None, "gallery": None,
               "created": time.time()}
        with self.fps_cond:
            self.fps_jobs[jid] = job
            self.fps_queue.append(jid)
            self.fps_cond.notify()
        self.save_ai_jobs()
        log("upscale %dx queued: %s %s (%d images)" % (factor, "gallery" if gallery_id else "image", gallery_id or image_id, len(imgs)))
        return {"job": jid}

    def upscale_images(self, job):
        """Upscale an image or a gallery's images into <library>/Upscaled/<name>/, scan
        them in as new images with the originals' metadata (a gallery's go into a new
        gallery "<title> (upscaled N×)"), tagged UPSCALE_TAG."""
        imgs, g = self.upscale_targets(job.get("image_id"), job.get("gallery_id"))
        factor = job["factor"]
        job.update(state="running", started=time.time(), total=len(imgs))
        work = os.path.join(FPS_WORK, job["id"])
        os.makedirs(work, exist_ok=True)
        name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", job["title"] or "Images").strip()[:80] or "Images"
        folder = os.path.join(self.media_dir, UPSCALE_DIR, "%s [%dx]" % (name, factor) if g else "Images")
        os.makedirs(folder, exist_ok=True)
        base = self.stash.url[: -len("/graphql")]
        headers = {"ApiKey": self.stash.api_key} if self.stash.api_key else {}
        pairs, targets = [], []
        try:
            for n, im in enumerate(imgs):
                # through Stash, so images inside zip galleries work too
                src = os.path.join(work, "src_%04d" % n)
                with self.http_request("%s/image/%s/image" % (base, im["id"]), headers) as r, open(src, "wb") as f:
                    shutil.copyfileobj(r, f)
                stem, ext = os.path.splitext(os.path.basename(im["path"]))
                ext = ext.lower() if ext.lower() in (".jpg", ".jpeg", ".png") else ".png"
                target = os.path.join(folder, "%s [%dx]%s" % (stem, factor, ext))
                k = 2
                while os.path.exists(target) or target in targets:
                    target = os.path.join(folder, "%s [%dx] (%d)%s" % (stem, factor, k, ext))
                    k += 1
                pairs.append([src, os.path.join(work, "out_%04d%s" % (n, ext))])
                targets.append(target)
            with open(os.path.join(work, "batch.json"), "w") as f:
                json.dump(pairs, f)
            cmd = ["nice", "-n", "15", self.python, "-I", UPSCALE_SCRIPT, "--batch", os.path.join(work, "batch.json"),
                   "--models", self.models_dir, "--factor", str(factor)]
            t0 = time.time()
            self.fps_proc = p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            error = None
            for line in p.stdout:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if "error" in msg:
                    error = msg["error"]
                elif "file" in msg:
                    done = msg["file"]
                    rate = done / max(1e-6, time.time() - t0)
                    job.update(frames=done, progress=min(0.95, done / len(imgs)), speed=round(rate, 3),
                               eta=round((len(imgs) - done) / rate))
            err = p.stderr.read()
            if p.wait() != 0:
                if job["state"] == "cancelling":
                    job.update(state="cancelled")
                    return
                raise RuntimeError(error or err.strip()[-400:] or "upscale.py failed")
            mpx = sum(i["width"] * i["height"] for i in imgs) / 1e6
            self.save_speed("image_mpx_per_s", mpx / max(1e-6, time.time() - t0 - IMAGE_OVERHEAD * len(imgs)) if
                            time.time() - t0 > IMAGE_OVERHEAD * len(imgs) else IMAGE_SPEED)
            for (_, out), target in zip(pairs, targets):
                shutil.move(out, target)
        finally:
            shutil.rmtree(work, ignore_errors=True)

        job.update(progress=0.97, stage="importing")
        self.stash.scan([folder])
        tag = self.stash.ensure("tag", UPSCALE_TAG)
        new_gallery = None
        if g:
            gm = self.stash.gql("query($id: ID!) { findGallery(id: $id) { title date details photographer studio { id } "
                                "performers { id } tags { id } } }", {"id": g["id"]})["findGallery"]
            inp = {"title": "%s (upscaled %d×)" % (gm["title"] or name, factor),
                   "details": "\n\n".join(x for x in ((gm["details"] or "").strip(), "AI upscale %d× (Real-ESRGAN) of gallery %s." % (factor, g["id"])) if x),
                   "tag_ids": list(dict.fromkeys([t["id"] for t in gm["tags"]] + [tag])),
                   "performer_ids": [p["id"] for p in gm["performers"]]}
            for k in ("date", "photographer"):
                if gm.get(k):
                    inp[k] = gm[k]
            if gm.get("studio"):
                inp["studio_id"] = gm["studio"]["id"]
            new_gallery = self.stash.gql("mutation($i: GalleryCreateInput!) { galleryCreate(input: $i) { id } }", {"i": inp})["galleryCreate"]["id"]
        last = None
        for im, target in zip(imgs, targets):
            found = self.stash.gql("query($f: ImageFilterType) { findImages(image_filter: $f) { images { id } } }",
                                   {"f": {"path": {"value": target, "modifier": "EQUALS"}}})["findImages"]["images"]
            if not found:
                continue
            new = found[0]["id"]
            src = self.stash.gql("query($id: ID!) { findImage(id: $id) { title date details photographer studio { id } "
                                 "performers { id } tags { id } galleries { performers { id } studio { id } } } }",
                                 {"id": im["id"]})["findImage"]
            # images here often only get performers and studio through their gallery
            perfs = [p["id"] for p in src["performers"]] or [p["id"] for gg in src["galleries"] for p in gg["performers"]]
            studio = src["studio"] or next((gg["studio"] for gg in src["galleries"] if gg["studio"]), None)
            inp = {"id": new, "tag_ids": list(dict.fromkeys([t["id"] for t in src["tags"]] + [tag])),
                   "performer_ids": list(dict.fromkeys(perfs)),
                   "details": "\n\n".join(x for x in ((src["details"] or "").strip(), "AI upscale %d× (Real-ESRGAN) of image %s." % (factor, im["id"])) if x)}
            for k in ("title", "date", "photographer"):
                if src.get(k):
                    inp[k] = src[k]
            if studio:
                inp["studio_id"] = studio["id"]
            if new_gallery:
                inp["gallery_ids"] = [new_gallery]
            self.stash.gql("mutation($i: ImageUpdateInput!) { imageUpdate(input: $i) { id } }", {"i": inp})
            last = new
        job.update(state="done", progress=1, image=last if not g else None, gallery=new_gallery, finished=time.time())
        log("upscale %dx done: %s -> %s" % (factor, ("gallery %s" % g["id"]) if g else ("image %s" % imgs[0]["id"]),
                                              ("gallery %s" % new_gallery) if g else ("image %s" % last)))

    # ------------------------------------------------------------ http

    def get(self, path):
        """(code, body, content type) for GET /parallax/..."""
        u = urllib.parse.urlparse(path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        p = u.path[len("/parallax/"):]
        try:
            if p == "status":
                return 200, self.status(), None
            if p == "projects":
                return 200, self.summaries(q.get("source"), q.get("scene")), None
            if p.startswith("project/"):
                return 200, self.load_project(p[len("project/"):]), None
            if p == "cuts":
                return 200, self.cuts(q.get("source")), None
            if p.startswith("job/"):
                job = self.jobs.get(p[len("job/"):])
                return (200, job, None) if job else (404, {"error": "no such job"}, None)
            if p == "fps":
                return 200, self.fps_status(q.get("scene")), None
            if p == "upscale":
                return 200, self.upscale_status(q), None
            if p == "ai-jobs":
                return 200, self.ai_jobs(), None
            if p == "enhance":
                return 200, self.enhance_status(q.get("scene")), None
            if p == "enhance-image":
                return 200, self.enhance_image_status(q), None
            if p in ("enhance/ui/studio.js", "enhance/ui/studio.css", "enhance/ui/image-studio.js"):
                # the studio is the enhance service's; Stash's CSP only lets the page reach this port
                return 200, self.enhance_api("GET", "/" + p[len("enhance/"):], raw=True), \
                    "text/javascript" if p.endswith(".js") else "text/css"
            if p.startswith("file/"):
                data, ctype = self.file(p[len("file/"):])
                return 200, data, ctype
        except KeyError as e:
            return 404, {"error": str(e).strip("'")}, None
        except ValueError as e:
            return 400, {"error": str(e)}, None
        return 404, {"error": "not found"}, None

    def post(self, path, raw):
        """(code, body) for POST /parallax/... (raw is the request body)."""
        p = urllib.parse.urlparse(path).path[len("/parallax/"):]
        try:
            m = re.match(r"^fps/([a-f0-9]{12})/cancel$", p)
            if m:
                return 200, self.cancel_fps(m.group(1))
            if p == "fps":
                return 200, self.start_fps(json.loads(raw or b"{}"))
            if p == "upscale":
                return 200, self.start_upscale(json.loads(raw or b"{}"))
            if p == "enhance":
                return 200, self.start_enhance(json.loads(raw or b"{}"))
            if p == "enhance-image":
                return 200, self.start_enhance_image(json.loads(raw or b"{}"))
            if p in ("enhance-image/probe", "enhance-image/preview", "enhance-image/segment"):
                fn = {"probe": self.enhance_image_probe, "preview": self.enhance_image_preview, "segment": self.enhance_image_segment}
                return 200, fn[p.split("/")[1]](json.loads(raw or b"{}"))
            if p == "enhance/preview":
                return 200, self.enhance_preview(json.loads(raw or b"{}"))
            m = re.match(r"^export/([a-f0-9]{12})/(start|frames|finish|cancel)$", p)
            if m and m.group(2) == "frames":
                return 200, self.export_frames(m.group(1), raw)
            body = json.loads(raw or b"{}")
            if m:
                pid, action = m.groups()
                if action == "start":
                    return 200, self.export_start(pid, body)
                if action == "finish":
                    return 200, self.export_finish(pid)
                return 200, self.export_cancel(pid)
            if p == "project":
                if not self.status()["enabled"]:
                    return 503, {"error": self.status()["reason"]}
                return 200, self.create_project(body)
            m = re.match(r"^project/([a-f0-9]{12})(/delete|/duplicate)?$", p)
            if m:
                if m.group(2) == "/delete":
                    return 200, self.delete_project(m.group(1))
                if m.group(2) == "/duplicate":
                    return 200, self.duplicate_project(m.group(1))
                return 200, self.save_project(m.group(1), body)
            if p == "segment":
                return 200, self.segment(body)
            if p == "mask":
                return 200, self.save_mask(body)
            if p in ("cut", "extend"):
                if not self.status()["enabled"]:
                    return 503, {"error": self.status()["reason"]}
                return 200, self.start_cut(body) if p == "cut" else self.start_extend(body)
        except KeyError as e:
            return 404, {"error": str(e).strip("'")}
        except ValueError as e:
            return 400, {"error": str(e)}
        except Exception as e:
            traceback.print_exc()
            return 500, {"error": str(e)}
        return 404, {"error": "not found"}
