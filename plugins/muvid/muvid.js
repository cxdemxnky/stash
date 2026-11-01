// MuVid (/muvid): send videos from Stash to MuVid, which cuts them into a music
// video on the beat. /muvid lists the projects started from Stash, /muvid/new[?tag=ID]
// starts one (all videos, or the scenes with some tags, and a piece of music: a
// scene or a file on the disk), /muvid/add/<project> sends more videos to one. Tag
// pages get a "Music video" button. The downloader (muvid_service.py) turns the
// choice into files and talks to MuVid; the studio is MuVid's own web app (port
// 10144, or the plugin's muvid_url setting), opened in its own tab, since Stash's
// CSP doesn't let video from other ports play here. Exports come back as scenes
// tagged "MuVid".
(function () {
  const { React, libraries } = window.PluginApi;
  const { Link, useHistory, useLocation } = libraries.ReactRouterDOM;
  const { FontAwesomeIcon } = libraries.ReactFontAwesome;
  const { faMusic } = libraries.FontAwesomeSolid;
  const { Nav, Button } = libraries.Bootstrap;
  const h = React.createElement;

  const SIZES = [["1080p", 1920, 1080], ["720p", 1280, 720], ["4K", 3840, 2160], ["1080p portrait", 1080, 1920],
    ["720p portrait", 720, 1280], ["Square", 1080, 1080], ["4:5", 1080, 1350]];
  const RATES = [23.976, 24, 25, 29.97, 30, 50, 60];
  const BEATS = [1, 2, 4, 8, 16];

  // ---------------------------------------------------------------- backend

  let backendPromise = null;
  function backend() {
    if (!backendPromise) {
      backendPromise = fetch(new URL("graphql", document.baseURI), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ configuration { plugins } }" }),
      })
        .then((r) => r.json())
        .then((body) => {
          const plugins = (body.data && body.data.configuration.plugins) || {};
          // the downloader address and token are the Downloads plugin's settings
          const cfg = plugins.downloads || {};
          const base = (cfg.downloader_url || `${location.protocol}//${location.hostname}:10141`).replace(/\/$/, "");
          const muvid = ((plugins.muvid || {}).muvid_url || `${location.protocol}//${location.hostname}:10144`).replace(/\/$/, "");
          return { base, token: cfg.token || "", muvid };
        });
      backendPromise.catch(() => { backendPromise = null; });
    }
    return backendPromise;
  }

  async function api(path, body) {
    const { base, token } = await backend();
    const opts = body === undefined ? {} : {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Token": token },
      body: JSON.stringify(body),
    };
    const res = await fetch(`${base}/muvid/${path}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function useBackend() {
    const [b, setB] = React.useState(null);
    React.useEffect(() => { backend().then(setB, () => {}); }, []);
    return b;
  }

  const basename = (p) => String(p || "").replace(/^.*\//, "");
  const hours = (s) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`);
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  // ---------------------------------------------------------------- picking the videos

  // {all: true} or {tags, match, sub}, plus exclude, as the downloader takes it
  function VideoPicker({ value, onChange }) {
    const [tags, setTags] = React.useState(null);
    const [filter, setFilter] = React.useState("");
    const [count, setCount] = React.useState(null);
    const [error, setError] = React.useState(null);
    React.useEffect(() => { api("tags").then(setTags, (e) => setError(e.message)); }, []);
    React.useEffect(() => {
      setCount(null);
      if (!value.all && !value.tags.length) return undefined;
      const id = setTimeout(() => api("count", { videos: value }).then(setCount, (e) => setError(e.message)), 250);
      return () => clearTimeout(id);
    }, [JSON.stringify(value)]);
    const set = (patch) => onChange({ ...value, ...patch });
    const toggle = (key, id) => set({ [key]: value[key].includes(id) ? value[key].filter((x) => x !== id) : [...value[key], id] });
    const name = (id) => ((tags || []).find((t) => t.id === id) || {}).name || id;
    const f = filter.toLowerCase();
    const shown = (tags || []).filter((t) => t.name.toLowerCase().includes(f))
      .sort((a, b) => (value.tags.includes(b.id) - value.tags.includes(a.id)));
    return h("div", null,
      error && h("div", { className: "alert alert-danger" }, error),
      h("div", { className: "muv-radios" },
        h("label", null, h("input", { type: "radio", checked: value.all, onChange: () => set({ all: true }) }), " All videos"),
        h("label", null, h("input", { type: "radio", checked: !value.all, onChange: () => set({ all: false }) }), " Videos with tags")),
      !value.all && h("div", { className: "muv-tagbox" },
        h("div", { className: "muv-row" },
          h("input", { className: "form-control form-control-sm muv-filter", placeholder: "Find a tag…", value: filter, onChange: (e) => setFilter(e.target.value) }),
          h("select", { className: "form-control form-control-sm muv-narrow", value: value.match, onChange: (e) => set({ match: e.target.value }) },
            h("option", { value: "any" }, "any of them"), h("option", { value: "all" }, "all of them")),
          h("label", { className: "muv-check", title: "A tag also picks the scenes of its sub-tags" },
            h("input", { type: "checkbox", checked: value.sub, onChange: (e) => set({ sub: e.target.checked }) }), " with sub-tags")),
        !tags ? h("div", { className: "text-muted" }, "Loading tags…") : h("div", { className: "muv-tags" },
          shown.map((t) => h("label", { key: t.id, className: "muv-tag" + (value.tags.includes(t.id) ? " on" : "") },
            h("input", { type: "checkbox", checked: value.tags.includes(t.id), onChange: () => toggle("tags", t.id) }),
            ` ${t.name}`, h("span", { className: "text-muted" }, ` ${t.scenes}`))))),
      h("div", { className: "muv-row muv-exclude" },
        h("span", null, "Leave out scenes tagged"),
        value.exclude.map((id) => h("span", { key: id, className: "muv-chip" }, name(id), h("button", { onClick: () => toggle("exclude", id) }, "×"))),
        tags && h("select", {
          className: "form-control form-control-sm muv-narrow", value: "",
          onChange: (e) => { if (e.target.value) toggle("exclude", e.target.value); },
        }, h("option", { value: "" }, "+ a tag…"), tags.filter((t) => !value.exclude.includes(t.id)).map((t) => h("option", { key: t.id, value: t.id }, t.name)))),
      h("div", { className: "muv-count" },
        !value.all && !value.tags.length ? "Tick some tags."
          : count ? `${count.count} videos, ${hours(count.duration)} in all` : "Counting…"));
  }

  // ---------------------------------------------------------------- picking the music

  function MusicPicker({ value, onChange }) {
    const [tab, setTab] = React.useState("scene");
    const [q, setQ] = React.useState("");
    const [scenes, setScenes] = React.useState(null);
    const [path, setPath] = React.useState(() => { try { return localStorage.getItem("muvid-music-folder") || ""; } catch (e) { return ""; } });
    const [list, setList] = React.useState(null);
    const [error, setError] = React.useState(null);
    React.useEffect(() => {
      if (tab !== "scene") return undefined;
      const id = setTimeout(() => api(`scenes?q=${encodeURIComponent(q)}`).then(setScenes, (e) => setError(e.message)), 250);
      return () => clearTimeout(id);
    }, [q, tab]);
    React.useEffect(() => {
      if (tab !== "file") return;
      setList(null);
      api(`browse${path ? `?path=${encodeURIComponent(path)}` : ""}`).then((l) => {
        setList(l);
        try { if (l.path) localStorage.setItem("muvid-music-folder", l.path); } catch (e) { /* blocked */ }
      }, (e) => { if (path) setPath(""); else setError(e.message); });
    }, [path, tab]);
    if (value) {
      return h("div", { className: "muv-picked" },
        h("span", null, value.kind === "audio" ? "♪ " : "🎞 ", h("b", null, value.title)),
        h("span", { className: "text-muted" }, ` ${value.where}`),
        h("span", { className: "muv-spacer" }),
        value.kind !== "audio" && h("label", { className: "muv-check", title: "Cut its picture in too, in sync with the sound" },
          h("input", { type: "checkbox", checked: !!value.useVideo, onChange: (e) => onChange({ ...value, useVideo: e.target.checked }) }), " use its video too"),
        h(Button, { size: "sm", variant: "secondary", onClick: () => onChange(null) }, "Change"));
    }
    return h("div", null,
      h("div", { className: "muv-tabs" },
        h(Button, { size: "sm", variant: tab === "scene" ? "primary" : "secondary", onClick: () => setTab("scene") }, "A scene in Stash"),
        h(Button, { size: "sm", variant: tab === "file" ? "primary" : "secondary", onClick: () => setTab("file") }, "A file on the disk")),
      error && h("div", { className: "alert alert-danger" }, error),
      tab === "scene" ? h("div", null,
        h("input", { className: "form-control form-control-sm", placeholder: "Find a scene (a music video, say)…", value: q, onChange: (e) => setQ(e.target.value) }),
        h("div", { className: "muv-results" }, (scenes || []).map((s) => h("button", {
          key: s.id, className: "muv-result",
          onClick: () => onChange({ scene_id: s.id, kind: "video", title: s.title, where: `scene ${s.id} · ${clock(s.duration || 0)}`, useVideo: true }),
        }, h("span", null, s.title), h("span", { className: "text-muted" }, clock(s.duration || 0))))))
        : h("div", null,
          list && list.path && h("div", { className: "muv-crumbs text-muted" }, list.path),
          !list ? h("div", { className: "text-muted" }, "Loading…") : h("div", { className: "muv-results" },
            !list.path && list.roots.map((r) => h("button", { key: r, className: "muv-result", onClick: () => setPath(r) }, `💽 ${r}`)),
            list.parent && h("button", { className: "muv-result", onClick: () => setPath(list.parent) }, "⬑ .."),
            (list.dirs || []).map((d) => h("button", { key: d.name, className: "muv-result", onClick: () => setPath(`${list.path}/${d.name}`) }, `📁 ${d.name}`)),
            (list.files || []).map((x) => h("button", {
              key: x.name, className: "muv-result",
              onClick: () => onChange({ path: `${list.path}/${x.name}`, kind: x.kind, title: x.name, where: list.path, useVideo: x.kind === "video" }),
            }, h("span", null, `${x.kind === "audio" ? "♪" : "🎞"} ${x.name}`), h("span", { className: "text-muted" }, x.kind))))));
  }

  // ---------------------------------------------------------------- pages

  const studioUrl = (muvid, id, job) => `${muvid}/ui/#/p/${id}${job ? `?job=${job}` : ""}`;

  function Projects() {
    const b = useBackend();
    const [list, setList] = React.useState(null);
    const [error, setError] = React.useState(null);
    React.useEffect(() => { api("projects").then(setList, (e) => setError(e.message)); }, []);
    return h("div", { className: "muv-page" },
      h("div", { className: "muv-row" },
        h("h2", null, "MuVid"),
        h("span", { className: "muv-spacer" }),
        b && h("a", { className: "btn btn-secondary", href: `${b.muvid}/ui/`, target: "_blank", rel: "noreferrer" }, "MuVid's own app ↗"),
        h(Link, { className: "btn btn-primary", to: "/muvid/new" }, "+ New music video")),
      h("p", { className: "text-muted" }, "Music videos cut on the beat from your videos. The studio opens in MuVid, in its own tab; exports come back here as scenes tagged MuVid."),
      error && h("div", { className: "alert alert-danger" }, `The downloader or MuVid didn't answer: ${error}`),
      !list && !error && h("div", null, "Loading…"),
      list && list.length === 0 && h("p", null, "None yet."),
      h("div", { className: "muv-grid" }, (list || []).map((p) => h("div", { key: p.id, className: "muv-card" },
        b && h("a", { href: studioUrl(b.muvid, p.id), target: "_blank", rel: "noreferrer", className: "muv-thumb" },
          p.thumb ? h("img", { src: `${b.muvid}/file/${p.thumb}?v=${Math.round(p.updated || 0)}`, alt: "" }) : "🎵"),
        h("div", { className: "muv-card-body" },
          h("div", { className: "muv-card-title" }, p.title),
          h("div", { className: "text-muted muv-small" }, (p.meta && p.meta.what) || ""),
          h("div", { className: "text-muted muv-small" }, `${p.clips} cuts from ${p.sources} videos${p.bpm ? ` · ${Math.round(p.bpm)} BPM` : ""}${p.length ? ` · ${clock(p.length)}` : ""}`),
          h("div", { className: "muv-row muv-small" },
            b && h("a", { href: studioUrl(b.muvid, p.id), target: "_blank", rel: "noreferrer" }, "Open the studio ↗"),
            p.scene_id && h(Link, { to: `/scenes/${p.scene_id}` }, "The export"),
            h(Link, { to: `/muvid/add/${p.id}` }, "+ Add videos")))))));
  }

  function NewProject({ tag }) {
    const history = useHistory();
    const [videos, setVideos] = React.useState({ all: !tag, tags: tag ? [tag] : [], match: "any", sub: true, exclude: [] });
    const [music, setMusic] = React.useState(null);
    const [title, setTitle] = React.useState("");
    const [size, setSize] = React.useState("1080p");
    const [fps, setFps] = React.useState(30);
    const [beats, setBeats] = React.useState([4]);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(null);
    const [opened, setOpened] = React.useState(null);
    // previous exports aren't material for new ones
    React.useEffect(() => {
      api("tags").then((ts) => {
        const own = ts.find((t) => t.name === "MuVid");
        if (own) setVideos((v) => (v.exclude.includes(own.id) ? v : { ...v, exclude: [...v.exclude, own.id] }));
      }, () => {});
    }, []);
    async function create() {
      setBusy(true);
      setError(null);
      // opened now, while this is still the click (else it's a blocked pop-up)
      const win = window.open("about:blank", "_blank");
      try {
        const { muvid } = await backend();
        const [, w, hh] = SIZES.find((s) => s[0] === size);
        const res = await api("project", {
          videos,
          music: music.scene_id ? { scene_id: music.scene_id } : { path: music.path },
          use_video: music.kind !== "audio" && !!music.useVideo,
          title: title.trim() || undefined,
          settings: { width: w, height: hh, fps },
          gen: { beats },
        });
        const url = studioUrl(muvid, res.project.id, res.job);
        if (win) {
          win.location.href = url;
          history.push("/muvid");
        } else setOpened(url);
      } catch (e) {
        if (win) win.close();
        setError(e.message);
      }
      setBusy(false);
    }
    const ready = music && (videos.all || videos.tags.length);
    return h("div", { className: "muv-page muv-narrow-page" },
      h("h2", null, "New music video"),
      h("h5", null, "1 · The videos"),
      h(VideoPicker, { value: videos, onChange: setVideos }),
      h("h5", null, "2 · The music"),
      h(MusicPicker, { value: music, onChange: (m) => { setMusic(m); if (m && !title) setTitle(m.title.replace(/\.[^.]+$/, "")); } }),
      h("h5", null, "3 · Settings"),
      h("div", { className: "muv-row" },
        h("label", null, "Title ", h("input", { className: "form-control form-control-sm muv-inline", value: title, onChange: (e) => setTitle(e.target.value) })),
        h("label", null, "Size ", h("select", { className: "form-control form-control-sm muv-inline", value: size, onChange: (e) => setSize(e.target.value) },
          SIZES.map(([n, w, hh]) => h("option", { key: n, value: n }, `${n} (${w}×${hh})`)))),
        h("label", null, "Frame rate ", h("select", { className: "form-control form-control-sm muv-inline", value: fps, onChange: (e) => setFps(Number(e.target.value)) },
          RATES.map((r) => h("option", { key: r, value: r }, r))))),
      h("div", { className: "muv-row" },
        h("span", null, "Cut every"),
        BEATS.map((n) => h(Button, {
          key: n, size: "sm", variant: beats.includes(n) ? "primary" : "secondary",
          onClick: () => setBeats((xs) => (xs.includes(n) ? (xs.length > 1 ? xs.filter((x) => x !== n) : xs) : [...xs, n].sort((a, c) => a - c))),
        }, n)),
        h("span", { className: "text-muted" }, "beats (several: mixed)")),
      error && h("div", { className: "alert alert-danger" }, error),
      opened && h("div", { className: "alert alert-info" }, "Made. ", h("a", { href: opened, target: "_blank", rel: "noreferrer" }, "Open the studio ↗")),
      h("div", { className: "muv-row muv-actions" },
        h(Button, { variant: "primary", disabled: !ready || busy, onClick: create }, busy ? "Starting…" : "Make the music video"),
        !music && h("span", { className: "text-muted" }, "Pick the music.")));
  }

  function AddVideos({ pid }) {
    const history = useHistory();
    const [videos, setVideos] = React.useState({ all: false, tags: [], match: "any", sub: true, exclude: [] });
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(null);
    async function add() {
      setBusy(true);
      setError(null);
      try {
        await api("add", { project: pid, videos });
        history.push("/muvid");
      } catch (e) {
        setError(e.message);
        setBusy(false);
      }
    }
    return h("div", { className: "muv-page muv-narrow-page" },
      h("h2", null, "Add videos to the project"),
      h("p", { className: "text-muted" }, "Videos already in it are skipped. They're added to its bin; a new cut in the studio uses them."),
      h(VideoPicker, { value: videos, onChange: setVideos }),
      error && h("div", { className: "alert alert-danger" }, error),
      h("div", { className: "muv-row muv-actions" },
        h(Button, { variant: "primary", disabled: busy || (!videos.all && !videos.tags.length), onClick: add }, busy ? "Adding…" : "Add them"),
        h(Link, { to: "/muvid" }, "Cancel")));
  }

  function MuVidRoute() {
    const loc = useLocation();
    const q = new URLSearchParams(loc.search);
    const add = /^\/muvid\/add\/([a-f0-9]{12})/.exec(loc.pathname);
    if (add) return h(AddVideos, { pid: add[1], key: add[1] });
    if (/^\/muvid\/new/.test(loc.pathname)) return h(NewProject, { tag: q.get("tag"), key: loc.search });
    return h(Projects);
  }

  window.PluginApi.register.route("/muvid", MuVidRoute);

  // ---------------------------------------------------------------- entry points

  let routerHistory = null;
  function HistoryGrabber() {
    routerHistory = useHistory();
    return null;
  }

  window.PluginApi.patch.before("MainNavBar.MenuItems", function (props) {
    const item = h(Nav.Link, { key: "muvid", eventKey: "/muvid", as: "div", className: "col-4 col-sm-3 col-md-2 col-lg-auto" },
      h(Link, { to: "/muvid" },
        h(Button, { className: "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center" },
          h(FontAwesomeIcon, { icon: faMusic, className: "nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0 mr-xl-1" }),
          h("span", null, "MuVid"))));
    return [{ ...props, children: h(React.Fragment, null, props.children, item, h(HistoryGrabber, { key: "muvid-history" })) }];
  });

  // tag pages: "Music video" from this tag's scenes
  function ensureTagButton() {
    const m = /\/tags\/(\d+)(?:\/|$)/.exec(window.location.pathname);
    const existing = document.getElementById("muvid-tag-button");
    if (existing && (!m || existing.dataset.tag !== m[1])) existing.remove();
    if (!m || document.getElementById("muvid-tag-button")) return;
    const group = document.querySelector(".detail-header .details-edit");
    if (!group) return;
    const b = document.createElement("button");
    b.id = "muvid-tag-button";
    b.type = "button";
    b.dataset.tag = m[1];
    b.className = "btn btn-secondary";
    b.title = "Cut this tag's scenes into a music video (MuVid)";
    b.textContent = "♪ Music video";
    b.addEventListener("click", () => {
      const to = `/muvid/new?tag=${m[1]}`;
      if (routerHistory) routerHistory.push(to);
      else window.location.href = new URL(to.slice(1), document.baseURI).href;
    });
    const del = group.querySelector(".delete");
    group.insertBefore(b, del || null);
  }
  new MutationObserver(ensureTagButton).observe(document.body, { childList: true, subtree: true });
  ensureTagButton();
})();
