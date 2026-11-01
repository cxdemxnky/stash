"""MuVid, for the downloader service (standard library only). Everything here is
under /muvid/ on this port, as Stash's CSP only lets its pages reach this one.

MuVid (/media/matt/WD/tmp/muvid, its own API and web app at MUVID_URL) cuts a
music video from a pile of videos on the beat of a piece of music. The Stash
plugin (plugins/muvid) picks the videos the Stash way: all of the library, or the
scenes with some tags (any or all of them, optionally with their sub-tags, minus
scenes with other tags). This side turns that into the files' paths and starts
a project in MuVid (or adds them to one). The studio is MuVid's own web app,
opened in a tab of its own: Stash's CSP doesn't allow video from other ports, so
it can't be embedded. Exports go to the library's MuVid folder; when one is done
MuVid calls back (/muvid/callback), and the video is scanned into Stash, tagged
"MuVid" and given the performers of the scenes it's cut from.

GET  /muvid/status                       MuVid's status (relayed)
GET  /muvid/tags                         [{id, name, scenes, children}] every tag with scenes, by name
GET  /muvid/scenes?q=TEXT                scenes to use as the music: [{id, title, path, duration}]
GET  /muvid/browse[?path=DIR]            MuVid's file browser (music from the disk)
GET  /muvid/projects                     the projects started from Stash, with the scene each was exported as
POST /muvid/count                        {videos} -> {count, duration}
POST /muvid/project                      {videos, music: {scene_id} | {path}, use_video?, title?, settings?, gen?}
                                         -> {project, job}
POST /muvid/add                          {project, videos} -> {added, job}
POST /muvid/callback                     {event: "exported", project, export}: MuVid reporting an export
                                         (X-Token needed) -> {link, scene_id}

videos: {all: true} or {tags: [id], match: "any"|"all", sub: bool}, plus exclude: [tag id] for either.
"""
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

MUVID_URL = os.environ.get("MUVID_URL", "http://127.0.0.1:10144").rstrip("/")  # the MuVid service
MUVID_TOKEN = os.environ.get("MUVID_TOKEN", "")  # from ~/.config/muvid/env
MUVID_CALLBACK = os.environ.get("MUVID_CALLBACK_URL", "http://127.0.0.1:10141/muvid/callback")
STASH_LINK = "http://{host}:10140"  # for MuVid's web app ("{host}": the host it's viewed from)
MUVID_DIR = "MuVid"  # folder in the library for exported music videos
MUVID_TAG = "MuVid"
MAX_PERFORMERS = 30


def log(msg):
    print(time.strftime("%H:%M:%S"), "muvid:", msg, flush=True)


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


class MuVid:
    def __init__(self, stash, root, media_dir):
        self.stash = stash
        self.root = root
        self.media_dir = media_dir
        self.lock = threading.Lock()
        os.makedirs(root, exist_ok=True)

    def api(self, method, path, body=None, timeout=60):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(MUVID_URL + path, method=method, data=data,
                                     headers={"X-Token": MUVID_TOKEN, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read())["error"]
            except (ValueError, KeyError, OSError):
                msg = "MuVid: HTTP %d" % e.code
            raise KeyError(msg) if e.code == 404 else ValueError(msg)
        except OSError as e:
            raise ValueError("MuVid isn't running at %s: %s" % (MUVID_URL, getattr(e, "reason", e)))

    def exports_path(self):
        return os.path.join(self.root, "muvid_exports.json")

    # ------------------------------------------------------------ picking scenes

    def tags(self):
        rows = self.stash.gql("{ allTags { id name scene_count children { id } } }")["allTags"]
        out = [{"id": t["id"], "name": t["name"], "scenes": t["scene_count"], "children": [c["id"] for c in t["children"]]}
               for t in rows if t["scene_count"] or t["children"]]
        out.sort(key=lambda t: t["name"].lower())
        return out

    def scenes(self, videos):
        """[(scene id, path, duration)] of the scenes a selection names, leaving out
        MuVid's own exports."""
        if not isinstance(videos, dict):
            raise ValueError("videos must be {all: true} or {tags: [...]}")
        f = {}
        if not videos.get("all"):
            ids = [str(int(t)) for t in videos.get("tags") or []]
            if not ids:
                raise ValueError("pick some tags, or all videos")
            f["tags"] = {"value": ids, "modifier": "INCLUDES_ALL" if videos.get("match") == "all" else "INCLUDES",
                         "depth": -1 if videos.get("sub") else 0}
        exclude = [str(int(t)) for t in videos.get("exclude") or []]
        if exclude:
            f["NOT"] = {"tags": {"value": exclude, "modifier": "INCLUDES", "depth": -1 if videos.get("sub") else 0}}
        rows = self.stash.gql("query($f: SceneFilterType) { findScenes(scene_filter: $f, filter: {per_page: -1}) "
                              "{ scenes { id files { path duration } } } }", {"f": f})["findScenes"]["scenes"]
        own = os.path.join(self.media_dir, MUVID_DIR) + os.sep
        out = []
        for s in rows:
            if s["files"] and not s["files"][0]["path"].startswith(own):
                out.append((s["id"], s["files"][0]["path"], float(s["files"][0]["duration"] or 0)))
        return out

    def count(self, body):
        rows = self.scenes(body.get("videos"))
        return {"count": len(rows), "duration": round(sum(d for _, _, d in rows), 1)}

    def music_scenes(self, q):
        rows = self.stash.gql("query($q: String) { findScenes(filter: {q: $q, per_page: 25, sort: \"title\"}) "
                              "{ scenes { id title files { path duration } } } }", {"q": q or ""})["findScenes"]["scenes"]
        return [{"id": s["id"], "title": s["title"] or os.path.basename(s["files"][0]["path"]),
                 "path": s["files"][0]["path"], "duration": s["files"][0]["duration"]} for s in rows if s["files"]]

    def describe(self, videos):
        if videos.get("all"):
            what = "all videos"
        else:
            names = {t["id"]: t["name"] for t in self.tags()}
            tags = [names.get(str(t), str(t)) for t in videos.get("tags") or []]
            what = "videos tagged " + (" and " if videos.get("match") == "all" else " or ").join(tags)
        if videos.get("exclude"):
            names = {t["id"]: t["name"] for t in self.tags()}
            what += ", not " + " or ".join(names.get(str(t), str(t)) for t in videos["exclude"])
        return what

    # ------------------------------------------------------------ projects

    def create_project(self, body):
        videos = body.get("videos") or {}
        rows = self.scenes(videos)
        if not rows:
            raise ValueError("no videos match")
        m = body.get("music") or {}
        if m.get("scene_id"):
            sc = self.stash.gql("query($id: ID!) { findScene(id: $id) { title files { path } } }",
                                {"id": str(int(m["scene_id"]))})["findScene"]
            if not sc or not sc["files"]:
                raise KeyError("scene %s has no file" % m["scene_id"])
            path = sc["files"][0]["path"]
            title = sc["title"] or os.path.splitext(os.path.basename(path))[0]
        elif m.get("path"):
            path = m["path"]
            title = os.path.splitext(os.path.basename(path))[0]
        else:
            raise ValueError("pick the music: a scene or a file")
        out = os.path.join(self.media_dir, MUVID_DIR)
        os.makedirs(out, exist_ok=True)
        what = self.describe(videos)
        res = self.api("POST", "/project", {
            "music": {"path": path, "video": bool(body.get("use_video"))},
            "sources": [p for _, p, _ in rows if p != path],
            "title": body.get("title") or title,
            "settings": body.get("settings") or {}, "gen": body.get("gen") or {},
            "output": out,
            "meta": {"client": "stash", "videos": videos, "what": what,
                     "link": {"href": STASH_LINK + "/muvid", "text": "Stash"}},
            "callback": {"url": MUVID_CALLBACK, "headers": {"X-Token": os.environ.get("DOWNLOADER_TOKEN", "")}},
        }, timeout=120)
        log("project %s: %s (%d videos), music %s" % (res["project"]["id"], what, len(rows), path))
        return res

    def add(self, body):
        pid = str(body.get("project") or "")
        rows = self.scenes(body.get("videos") or {})
        if not rows:
            raise ValueError("no videos match")
        res = self.api("POST", "/project/%s/sources" % urllib.parse.quote(pid), {"add": [p for _, p, _ in rows]}, timeout=120)
        return {"added": res.get("added", 0), "job": res.get("job"), "matched": len(rows)}

    def projects(self):
        exports = read_json(self.exports_path(), {}) or {}
        out = self.api("GET", "/projects?meta.client=stash")
        for p in out:
            p["scene_id"] = (exports.get(p["id"]) or {}).get("scene_id")
        return out

    # ------------------------------------------------------------ exports

    def callback(self, body):
        """POST /muvid/callback, from MuVid: an export is done. The video is scanned in
        (a re-export overwrites the same file, so the same scene is updated), tagged,
        and given the performers of the scenes it's cut from."""
        if body.get("event") != "exported":
            return {"ok": True}
        project, exp = body.get("project") or {}, body.get("export") or {}
        if (project.get("meta") or {}).get("client") != "stash" or not exp.get("path"):
            raise KeyError("not a Stash project")  # 404: MuVid stops retrying
        target = exp["path"]
        with self.lock:
            self.stash.scan([target])
            sid = self.stash.find_by_path("scene", target)
            if not sid:
                raise RuntimeError("Stash did not import %s" % target)  # 500: MuVid tries again later
            performers = []
            for path in project.get("used") or []:
                src = self.stash.find_by_path("scene", path)
                if src:
                    s = self.stash.gql("query($id: ID!) { findScene(id: $id) { performers { id } } }", {"id": src})["findScene"]
                    performers += [p["id"] for p in (s or {}).get("performers") or []]
            performers = list(dict.fromkeys(performers))[:MAX_PERFORMERS]
            cur = self.stash.gql("query($id: ID!) { findScene(id: $id) { tags { id } } }", {"id": sid})["findScene"]
            tag = self.stash.ensure("tag", MUVID_TAG)
            music = os.path.basename((project.get("music") or {}).get("path") or "")
            self.stash.gql("mutation($i: SceneUpdateInput!) { sceneUpdate(input: $i) { id } }", {"i": {
                "id": sid,
                "title": project.get("title") or "MuVid",
                "details": "Music video cut to %s from %s (%d of them used; MuVid project %s)." % (
                    music, (project.get("meta") or {}).get("what") or "Stash videos", len(project.get("used") or []), project.get("id")),
                "tag_ids": list(dict.fromkeys([t["id"] for t in cur["tags"]] + [tag])),
                "performer_ids": performers,
            }})
            exports = read_json(self.exports_path(), {}) or {}
            exports[project["id"]] = {"scene_id": sid, "path": target, "exported": exp.get("exported")}
            write_json(self.exports_path(), exports)
        log("export %s -> scene %s (%s)" % (project.get("id"), sid, target))
        return {"link": {"href": "%s/scenes/%s" % (STASH_LINK, sid), "text": "Open in Stash"}, "scene_id": sid}

    # ------------------------------------------------------------ routes

    def get(self, path):
        """(code, body) for GET /muvid/..."""
        u = urllib.parse.urlparse(path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        p = u.path[len("/muvid/"):]
        try:
            if p == "status":
                return 200, self.api("GET", "/status")
            if p == "tags":
                return 200, self.tags()
            if p == "scenes":
                return 200, self.music_scenes(q.get("q"))
            if p == "browse":
                return 200, self.api("GET", "/browse" + ("?" + urllib.parse.urlencode({"path": q["path"]}) if q.get("path") else ""))
            if p == "projects":
                return 200, self.projects()
        except KeyError as e:
            return 404, {"error": str(e).strip("'")}
        except ValueError as e:
            return 400, {"error": str(e)}
        except Exception as e:  # Stash unreachable and the like
            return 500, {"error": str(e)}
        return 404, {"error": "not found"}

    def post(self, path, body):
        """(code, body) for POST /muvid/..."""
        p = urllib.parse.urlparse(path).path[len("/muvid/"):]
        try:
            if p == "count":
                return 200, self.count(body)
            if p == "project":
                return 200, self.create_project(body)
            if p == "add":
                return 200, self.add(body)
            if p == "callback":
                return 200, self.callback(body)
        except KeyError as e:
            return 404, {"error": str(e).strip("'")}
        except ValueError as e:
            return 400, {"error": str(e)}
        except Exception as e:
            return 500, {"error": str(e)}
        return 404, {"error": "not found"}
