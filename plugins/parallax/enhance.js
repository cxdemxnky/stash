// Enhance Studio (/enhance): restore and enhance a scene, or a part of it, as a
// new scene. /enhance lists scenes to pick from; /enhance?scene=<id>[&t=<seconds>]
// is the studio. The studio itself is the enhance service's (ui/studio.js in
// /media/matt/WD/tmp/enhance, also used by its own web app on port 10142),
// fetched through the downloader (Stash's CSP only allows that port) and given a
// Stash adapter here. The downloader (parallax_service.py, /parallax/enhance...)
// hands jobs to the service and scans each finished video into Stash.
(function () {
  const { React, libraries } = window.PluginApi;
  const { Link, useLocation } = libraries.ReactRouterDOM;
  const { FontAwesomeIcon } = libraries.ReactFontAwesome;
  const { faWandMagicSparkles, faMagic } = libraries.FontAwesomeSolid;
  const { Nav, Button } = libraries.Bootstrap;
  const h = React.createElement;

  // ---------------------------------------------------------------- backend

  let backendPromise = null;
  function backend() {
    if (!backendPromise) {
      backendPromise = gql("{ configuration { plugins } }").then((data) => {
        // the downloader address and token are the Downloads plugin's settings
        const cfg = (data.configuration.plugins && data.configuration.plugins.downloads) || {};
        return { base: (cfg.downloader_url || `${location.protocol}//${location.hostname}:10141`).replace(/\/$/, ""), token: cfg.token || "" };
      });
    }
    return backendPromise;
  }

  async function gql(query, variables) {
    const res = await fetch(new URL("graphql", document.baseURI), {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json();
    if (body.errors) throw new Error(body.errors[0].message);
    return body.data;
  }

  async function api(path, body) {
    const { base, token } = await backend();
    const opts = body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json", "X-Token": token }, body: JSON.stringify(body),
    };
    const res = await fetch(`${base}/parallax/${path}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  const stashUrl = (path) => new URL(path, document.baseURI).href;

  const fpsText = (f) => (Math.abs(f - Math.round(f)) < 0.01 ? String(Math.round(f)) : f.toFixed(2));
  const clock = (s) => {
    s = Math.max(0, s || 0);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
    return (hh ? `${hh}:${String(mm).padStart(2, "0")}` : `${mm}`) + `:${String(ss).padStart(2, "0")}`;
  };

  // ---------------------------------------------------------------- the shared studio

  let studioPromise = null;
  function loadStudio() {
    if (!studioPromise) {
      studioPromise = backend().then(async ({ base }) => {
        const get = async (name) => {
          const res = await fetch(`${base}/parallax/enhance/ui/${name}`);
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
          return res.text();
        };
        const [js, imageJs, css] = await Promise.all([get("studio.js"), get("image-studio.js"), get("studio.css")]);
        let style = document.getElementById("enhance-studio-css");
        if (!style) {
          style = document.createElement("style");
          style.id = "enhance-studio-css";
          document.head.appendChild(style);
        }
        style.textContent = css;
        for (const code of [js, imageJs]) {
          const script = document.createElement("script");
          script.textContent = code;
          document.head.appendChild(script);
        }
        const shared = window.EnhanceStudio.create(React);
        return { ...shared, ImageStudio: window.EnhanceImageStudio.create(React, shared).ImageStudio };
      });
      studioPromise.catch(() => { studioPromise = null; }); // try again next time
    }
    return studioPromise;
  }

  function useStudio() {
    const [mod, setMod] = React.useState(null);
    const [error, setError] = React.useState(null);
    React.useEffect(() => { loadStudio().then(setMod, (e) => setError(e.message)); }, []);
    return [mod, error];
  }

  // where a scene's video, jobs and results come from and go to
  function stashAdapter(sid) {
    const RLink = (href, props, ...children) => h(Link, { to: href, ...props }, ...children);
    return {
      settingsKey: "enhance-studio-settings",
      load: () => api(`enhance?scene=${sid}`),
      queue: (b) => api("enhance", { scene_id: sid, settings: b.settings, label: b.label, summary: b.summary, estimate: b.estimate,
        ...(b.marker_id ? { marker_id: b.marker_id } : { start: b.start, duration: b.duration }) }),
      preview: (b) => api("enhance/preview", { scene_id: sid, time: b.time, settings: b.settings }).then(async (r) => {
        const { base } = await backend();
        return { ...r, before: `${base}/parallax/file/${r.before}`, after: `${base}/parallax/file/${r.after}` };
      }),
      cancel: (job) => api(`fps/${job.id}/cancel`, {}),
      videoSrc: (info, direct) => {
        const playable = direct && /^(h264|hevc|vp8|vp9|av1)$/i.test(info.scene.codec || "");
        return stashUrl(playable ? `scene/${sid}/stream` : `scene/${sid}/stream.mp4`);
      },
      frame: () => stashUrl(`scene/${sid}/screenshot`),
      link: RLink,
      titleHref: `/scenes/${sid}`,
      back: ["/enhance", "Pick another scene"],
      queuesHref: "/queues?tab=enhance",
      jobSource: (job) => [`/enhance?scene=${job.scene_id}`, job.title],
      jobResult: (job) => job.scene ? RLink(`/scenes/${job.scene}`, { className: "enh-button enh-primary" }, "Open the new scene") : null,
      savedAs: (info, label, part) => `${info.scene.file.replace(/\.[^.]+$/, "")}${part} [${label}].mp4`,
      queuedNote: "Queued. It's made as a new scene next to the original, with its metadata, tagged “Enhanced (AI)”. The original isn't changed.",
    };
  }

  function Studio({ sid }) {
    const q = new URLSearchParams(useLocation().search);
    const [mod, error] = useStudio();
    const adapter = React.useMemo(() => stashAdapter(sid), [sid]);
    if (error) return h("div", { className: "enh-page" }, h("h1", null, "Enhance Studio"),
      h("div", { className: "enh-warning" }, `The studio comes from the enhance service, which didn't answer: ${error}`));
    if (!mod) return h("div", { className: "enh-page" }, h("h1", null, "Enhance Studio"), h("p", null, "Loading…"));
    return h(mod.Studio, { adapter, startTime: Number(q.get("t") || 0) });
  }

  // ---------------------------------------------------------------- scene picker

  function Picker() {
    const [mod] = useStudio();
    const adapter = React.useMemo(() => stashAdapter(0), []);
    const [q, setQ] = React.useState("");
    const [scenes, setScenes] = React.useState(null);
    const [error, setError] = React.useState(null);
    const [jobs, setJobs] = React.useState([]);
    React.useEffect(() => {
      const t = setTimeout(() => {
        gql(`query($f: FindFilterType) { findScenes(filter: $f) { scenes { id title files { basename width height frame_rate duration } } } }`,
          { f: { q, per_page: 40, sort: q ? undefined : "created_at", direction: "DESC" } })
          .then((d) => setScenes(d.findScenes.scenes), (e) => setError(e.message));
      }, 250);
      return () => clearTimeout(t);
    }, [q]);
    React.useEffect(() => {
      api("ai-jobs").then((list) => setJobs(list.filter((j) => j.kind === "enhance").slice(0, 8)), () => {});
    }, []);
    return h("div", { className: "enh-page" },
      h("h1", null, "Enhance Studio"),
      h("p", { className: "enh-muted" },
        "Restore and enhance a scene, or a part of it, as a new scene: deinterlace (QTGMC) → crop → denoise → upscale (Real-ESRGAN) → frame rate (RIFE) → encode. ",
        "Pick a scene, or use the Enhance button on a scene page. For any other video on the WD disk, use ",
        h("a", { href: `${location.protocol}//${location.hostname}:10142/`, target: "_blank", rel: "noreferrer" }, "the enhance service's own app"), "."),
      mod && jobs.length > 0 && h("div", { className: "enh-recent" },
        h("h2", null, "Recent jobs ", h(Link, { to: "/queues?tab=enhance", className: "enh-small" }, "all in Queues")),
        jobs.map((j) => h(mod.JobRow, { key: j.id, job: j, adapter, showSource: true }))),
      h("input", { className: "enh-input enh-search", placeholder: "Search scenes…", value: q, autoFocus: true,
        onChange: (e) => setQ(e.target.value) }),
      error && h("div", { className: "enh-warning" }, error),
      !scenes && !error && h("p", null, "Loading…"),
      scenes && !scenes.length && h("p", null, "No scenes found."),
      h("div", { className: "enh-grid" },
        (scenes || []).filter((s) => s.files.length).map((s) => {
          const f = s.files[0];
          return h(Link, { key: s.id, to: `/enhance?scene=${s.id}`, className: "enh-card" },
            h("div", { className: "enh-thumb", style: { backgroundImage: `url("${stashUrl(`scene/${s.id}/screenshot`)}")` } },
              h("span", null, `${f.height}p · ${fpsText(f.frame_rate || 0)} fps · ${clock(f.duration).replace(/\.\d$/, "")}`)),
            h("div", { className: "enh-card-title" }, s.title || f.basename));
        })));
  }

  // ---------------------------------------------------------------- images and galleries

  function stashImageAdapter(kind, id) {
    const RLink = (href, props, ...children) => h(Link, { to: href, ...props }, ...children);
    const img = (i) => ({ ...i, src: stashUrl(`image/${i.key}/image`), thumb: stashUrl(`image/${i.key}/thumbnail`) });
    return {
      settingsKey: "enhance-image-settings",
      load: () => api(`enhance-image?${kind}=${id}`).then((d) => ({ ...d, images: d.images.map(img) })),
      probe: (i) => api("enhance-image/probe", { image_id: i.key }),
      preview: (b) => api("enhance-image/preview", { image_id: b.img.key, settings: b.settings, mask: b.mask }).then(async (r) => {
        const { base } = await backend();
        return { ...r, before: `${base}/parallax/file/${r.before}`, after: `${base}/parallax/file/${r.after}` };
      }),
      segment: (b) => api("enhance-image/segment", { image_id: b.img.key, points: b.points }),
      queue: (b) => api("enhance-image", { [`${kind}_id`]: id, only: b.only, settings: b.settings, masks: b.masks,
        label: b.label, summary: b.summary, estimate: b.estimate }),
      cancel: (job) => api(`fps/${job.id}/cancel`, {}),
      link: RLink,
      back: [kind === "gallery" ? `/galleries/${id}` : `/images/${id}`, kind === "gallery" ? "Back to the gallery" : "Back to the image"],
      queuesHref: "/queues?tab=enhance",
      jobResult: (job) => job.gallery ? RLink(`/galleries/${job.gallery}`, { className: "enh-button enh-primary" }, "Open the new gallery")
        : job.image ? RLink(`/images/${job.image}`, { className: "enh-button enh-primary" }, "Open the new image") : null,
      savedAs: (info, label, ext, dest, only) => `Enhanced/${kind === "gallery" && !only ? `${info.title} [${label}]` : "Images"}/` +
        `${only ? only.name.replace(/\.[^.]+$/, "") : "<name>"} [${label}].${ext}`,
      queuedNote: kind === "gallery"
        ? "Queued. The images are made as a new gallery with this one's metadata, tagged “Enhanced (AI)”. The originals aren't changed."
        : "Queued. It's made as a new image with this one's metadata, tagged “Enhanced (AI)”. The original isn't changed.",
    };
  }

  function ImageRoute() {
    const q = new URLSearchParams(useLocation().search);
    const kind = q.get("gallery") ? "gallery" : "image";
    const id = String(Number(q.get(kind) || 0));
    const [mod, error] = useStudio();
    const adapter = React.useMemo(() => stashImageAdapter(kind, id), [kind, id]);
    if (!Number(id)) return h("div", { className: "enh-page" }, h("h1", null, "Enhance images"),
      h("p", null, "Open an image or a gallery and use its Enhance button."));
    if (error) return h("div", { className: "enh-page" }, h("h1", null, "Enhance images"),
      h("div", { className: "enh-warning" }, `The studio comes from the enhance service, which didn't answer: ${error}`));
    if (!mod) return h("div", { className: "enh-page" }, h("h1", null, "Enhance images"), h("p", null, "Loading…"));
    return h(mod.ImageStudio, { adapter, key: `${kind}-${id}` });
  }

  window.PluginApi.register.route("/enhance-image", ImageRoute);

  function EnhanceRoute() {
    const loc = useLocation();
    const sid = new URLSearchParams(loc.search).get("scene");
    return sid ? h(Studio, { sid: String(Number(sid)), key: sid }) : h(Picker);
  }

  window.PluginApi.register.route("/enhance", EnhanceRoute);

  window.PluginApi.patch.before("MainNavBar.MenuItems", function (props) {
    const item = h(
      Nav.Link,
      { key: "enhance", eventKey: "/enhance", as: "div", className: "col-4 col-sm-3 col-md-2 col-lg-auto" },
      h(Link, { to: "/enhance" },
        h(Button, { className: "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center" },
          h(FontAwesomeIcon, { icon: faWandMagicSparkles || faMagic, className: "nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0 mr-xl-1" }),
          h("span", null, "Enhance"))));
    return [{ ...props, children: h(React.Fragment, null, props.children, item) }];
  });
})();
