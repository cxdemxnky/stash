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
import urllib.parse
import uuid

PARALLAX_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "parallax.py")
UPSCALE_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "upscale.py")
INTERPOLATE_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "interpolate.py")
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
            if job["state"] in ("queued", "running", "cancelling"):
                if job["state"] == "cancelling":
                    job["state"] = "cancelled"
                else:
                    job.update(state="queued", progress=0, frames=0, speed=None, restarted=True)
                    self.fps_queue.append(job["id"])
            self.fps_jobs[job["id"]] = job
        if os.path.isdir(FPS_WORK):
            for name in os.listdir(FPS_WORK):
                shutil.rmtree(os.path.join(FPS_WORK, name), ignore_errors=True) if os.path.isdir(os.path.join(FPS_WORK, name)) \
                    else os.remove(os.path.join(FPS_WORK, name))
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
        with self.fps_cond:
            if job["state"] == "queued":
                self.fps_queue.remove(jid)
                job.update(state="cancelled")
            elif job["state"] == "running":
                job.update(state="cancelling")
                if self.fps_proc:
                    self.fps_proc.kill()
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
                self.upscale_images(job) if job.get("kind") == "upscale" else self.double_fps(job)
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

    def copy_scene_metadata(self, sid, new, title_sfx, tag_name, option, marker=None):
        s = self.stash.gql(
            "query($id: ID!) { findScene(id: $id) { title details date code rating100 studio { id } performers { id } tags { id } } }",
            {"id": sid})["findScene"]
        tags = [t["id"] for t in s["tags"]] + (marker["tag_ids"] if marker else [])
        if tag_name:
            tags.append(self.stash.ensure("tag", tag_name))
        what = {"clip": "", "smooth2": "AI frame-rate doubling (RIFE)", "slowmo2": "AI slow motion 2× (RIFE)",
                "slowmo4": "AI slow motion 4× (RIFE)", "upscale2": "AI upscale 2× (Real-ESRGAN)",
                "upscale4k": "AI upscale to 4K (Real-ESRGAN, one 4× pass)"}[option]
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
