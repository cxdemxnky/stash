// Parallax Studio UI: /parallax lists projects, /parallax/new?image=<id> or
// ?scene=<id>&t=<seconds> starts one, /parallax/<id> is the NLE-style studio
// (media bin, preview, inspector, timeline with camera keyframes and caption clips).
// Layers, projects and exports are handled by the downloader (/parallax/... on
// port 10141, see downloader/parallax_service.py); rendering is in render.js.
(function () {
  const { React, libraries } = window.PluginApi;
  const { Link, useHistory, useLocation } = libraries.ReactRouterDOM;
  const h = React.createElement;
  const R = () => window.ParallaxRender;

  const SIZES = { "1080p": [1920, 1080], "720p": [1280, 720], "1080p portrait": [1080, 1920], "4K": [3840, 2160], Square: [1080, 1080] };
  const SAVE_DELAY = 800;
  const EASE_OPTIONS = [["inout", "Ease in-out"], ["in", "Ease in"], ["out", "Ease out"], ["linear", "Linear"], ["hold", "Hold"],
    ["custom", "Custom curve"]];

  // A keyframe's easing change: picking "custom" starts from the current preset's shape.
  function withEase(k, ease) {
    if (ease === "custom") return { ...k, ease, bez: k.ease === "custom" && k.bez ? k.bez : R().PRESET_BEZ[k.ease] || R().PRESET_BEZ.inout };
    return { ...k, ease };
  }
  const FRAME_BATCH = 12;

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
          // the downloader address and token are the Downloads plugin's settings
          const cfg = (body.data && body.data.configuration.plugins && body.data.configuration.plugins.downloads) || {};
          const base = (cfg.downloader_url || `${location.protocol}//${location.hostname}:10141`).replace(/\/$/, "");
          return { base, token: cfg.token || "" };
        });
    }
    return backendPromise;
  }

  async function api(path, body, raw) {
    const { base, token } = await backend();
    const opts = body === undefined ? {} : {
      method: "POST",
      headers: raw ? { "X-Token": token } : { "Content-Type": "application/json", "X-Token": token },
      body: raw ? body : JSON.stringify(body),
    };
    const res = await fetch(`${base}/parallax/${path}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  async function fileUrl(rel) {
    const { base } = await backend();
    return `${base}/parallax/file/${rel}`;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous"; // served with CORS, so canvases stay exportable
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("couldn't load " + url));
      img.src = url;
    });
  }

  // must match the downloader's source_key()
  function sourceKey(src) {
    if (src.kind === "image") return `image-${src.id}`;
    const key = `scene-${src.id}-${Math.round(src.time * 1000)}`;
    return src.span ? `${key}-bt${Math.round(Math.min(src.span, 3) * 1000)}` : key;
  }

  function sourceLabel(src) {
    if (src.kind === "image") return `Image ${src.id}`;
    return `Scene ${src.id} @ ${fmtTime(src.time)}${src.span ? ` · bullet time ${src.span} s` : ""}`;
  }

  function sourceLink(src) {
    return src.kind === "image" ? `/images/${src.id}` : `/scenes/${src.id}?t=${Math.floor(src.time)}`;
  }

  function fmtTime(s) {
    const m = Math.floor(s / 60);
    return `${m}:${(s % 60).toFixed(2).padStart(5, "0")}`;
  }

  function useStatus() {
    const [status, setStatus] = React.useState(null);
    React.useEffect(() => {
      api("status").then(setStatus, (e) => setStatus({ enabled: false, reason: `Downloader unreachable: ${e.message}` }));
    }, []);
    return status;
  }

  function newId() {
    return Math.random().toString(36).slice(2, 10);
  }

  // Fill in everything a freshly created (or older) project may be missing.
  // The keyframes a new project starts with: a gentle orbit with a slight dolly-in,
  // everything else at its default (the orbit point goes on the person: _centre).
  // bullet: the source is a bullet-time sequence, whose action then runs from the
  // first frame to the last over the clip (a linear ramp: steady slow motion).
  // Only the values that move are keyed; the rest stay at their defaults.
  // p as it would be with the values in pend keyed at time t
  function withPending(p, t, pend) {
    if (!pend) return p;
    const at = p.keyframes.find((k) => Math.abs(k.t - t) < 0.5 / (p.fps || 30));
    return {
      ...p,
      keyframes: at ? p.keyframes.map((k) => (k === at ? { ...k, ...pend } : k))
        : [...p.keyframes, { id: "pending", t, ...pend, ease: "inout" }],
    };
  }

  function defaultKeyframes(length, bullet) {
    return [
      { id: newId(), t: 0, turn: -6, zoom: 1, ...(bullet ? { action: 0 } : {}), ease: "inout" },
      { id: newId(), t: length, turn: 6, zoom: 1.1, ...(bullet ? { action: 1 } : {}), ease: "inout" },
    ];
  }

  // Keys that change nothing, taken out: a value with the same number in every key is
  // left with one key (none when that number is its default), since one key holds all
  // through. Keyframes left holding nothing go. Doesn't change how anything plays.
  function pruneStatic(kfs, params) {
    let out = (kfs || []).slice().sort((a, b) => a.t - b.t);
    for (const key of Object.keys(params)) {
      const keyed = out.filter((k) => k[key] != null);
      if (!keyed.length || keyed.some((k) => Math.abs(k[key] - keyed[0][key]) > 1e-9)) continue;
      const keep = Math.abs(keyed[0][key] - params[key].def) > 1e-9 ? keyed[0] : null;
      out = out.map((k) => {
        if (k === keep || k[key] == null) return k;
        const { [key]: gone, ...rest } = k;
        return rest;
      });
    }
    return out.filter((k) => Object.keys(params).some((x) => k[x] != null));
  }

  // Fill in what a new or older project is missing. Everything is keyframed now:
  // older projects' project-wide depth gap, orbit point, sizes and framing are
  // copied into each keyframe. With no orbit point yet, _centre asks for it to be
  // put on the person once their layer has loaded.
  function withDefaults(p) {
    const length = p.length || 6;
    const P = R().PARAMS;
    const base = {};
    R().PARAM_KEYS.forEach((k) => (base[k] = P[k].def));
    const legacy = {};
    const put = (k, v) => v != null && (legacy[k] = v);
    put("gap", p.gap);
    put("orbitX", p.orbit && p.orbit.u);
    put("orbitY", p.orbit && p.orbit.v);
    put("orbitZ", p.orbit ? p.orbit.z : p.pivot);
    put("bgSize", p.bgScale);
    put("fgSize", p.fgScale);
    put("framing", p.anchorY);
    const { anchorY, gap, orbit, bgScale, fgScale, pivot, _centre, ...rest } = p;
    const migrate = (kfs, params) => (p.sparse === 2 ? kfs : pruneStatic(kfs, params));
    return {
      ...rest,
      length,
      fps: p.fps || 30,
      size: p.size || "1080p",
      _centre: !p.orbit && !(p.keyframes || []).some((k) => k.orbitX != null),
      // keys are per value ("sparse"); projects from before that had every value in
      // every keyframe, which is filled in for them, and (sparse 2) the keys of values
      // that never change are then taken out once
      sparse: 2,
      keyframes: migrate((p.keyframes && p.keyframes.length ? p.keyframes : defaultKeyframes(length, !!(p.source && p.source.span)))
        .map(({ rotate, skew, ...k }) => (p.sparse ? k : { ...base, ...legacy, roll: rotate ?? base.roll, ...k })), P),
      // captions that followed the camera now sit on the person's plane; flat ones on the screen
      captions: (p.captions || []).map(({ follow, ...c }) => ({
        attach: follow === false ? "screen" : "person",
        effects: [{ id: newId(), type: "fade", in: false, inDur: 0.5, out: true, outDur: 0.25 }],
        ...c,
        keyframes: migrate(c.keyframes || [], R().CAPTION_PARAMS),
      })),
    };
  }

  function newCaption(t, length) {
    return {
      id: newId(), text: "Caption", text2: "", start: Math.max(0, Math.min(t, length - 1)), end: Math.min(length, t + 3),
      font: "anton", size: 9, color: "#ffffff", blend: "normal", style: "shadow", position: "bottom-left",
      uppercase: true, anim: "rise", attach: "person", keyframes: [], effects: [],
    };
  }

  // ---------------------------------------------------------------- render progress

  // Exports render here, in the browser, so their progress is shared with the
  // Queues page's Renders tab through a BroadcastChannel (live, any tab of this
  // browser) and localStorage (RENDERS_KEY: the last renders, for history). The tab
  // can ask to cancel one; the export loop checks renderCancels.
  const RENDERS_KEY = "parallax-renders";
  const renderChannel = "BroadcastChannel" in window ? new BroadcastChannel("parallax-renders") : null;
  const renderCancels = new Set();
  if (renderChannel) {
    renderChannel.onmessage = (e) => e.data && e.data.cancel && renderCancels.add(e.data.cancel);
  }
  function publishRender(r) {
    const rec = { ...r, updated: Date.now() };
    try {
      const list = JSON.parse(localStorage.getItem(RENDERS_KEY) || "[]").filter((x) => x.id !== rec.id);
      localStorage.setItem(RENDERS_KEY, JSON.stringify([rec, ...list].slice(0, 20)));
    } catch (e) {
      // storage blocked: the live channel still works
    }
    if (renderChannel) renderChannel.postMessage({ render: rec });
  }

  // ---------------------------------------------------------------- project list

  function ProjectList() {
    const status = useStatus();
    const [projects, setProjects] = React.useState(null);
    const [error, setError] = React.useState(null);
    const [thumbs, setThumbs] = React.useState({});
    const [confirm, setConfirm] = React.useState(null);

    const load = React.useCallback(() => {
      api("projects").then(async (list) => {
        setProjects(list);
        const t = {};
        for (const p of list) if (p.thumb) t[p.id] = (await fileUrl(p.thumb)) + "?v=" + Math.round(p.updated);
        setThumbs(t);
      }, (e) => setError(e.message));
    }, []);
    React.useEffect(load, [load]);

    function remove(id) {
      if (confirm !== id) return setConfirm(id);
      api(`project/${id}/delete`, {}).then(load, (e) => setError(e.message));
      setConfirm(null);
    }

    return h(
      "div",
      { className: "pxs-list" },
      h("h1", null, "Parallax Studio"),
      status && !status.enabled && h("div", { className: "pxs-warning" }, status.reason),
      error && h("div", { className: "pxs-warning" }, error),
      h("p", { className: "pxs-muted" },
        "Start a project from an image page or a paused scene with the Parallax button."),
      projects && !projects.length && h("p", null, "No projects yet."),
      h(
        "div",
        { className: "pxs-grid" },
        (projects || []).map((p) =>
          h(
            "div",
            { key: p.id, className: "pxs-card" },
            h(Link, { to: `/parallax/${p.id}` },
              h("div", { className: "pxs-thumb", style: thumbs[p.id] ? { backgroundImage: `url("${thumbs[p.id]}")` } : null }),
              h("div", { className: "pxs-card-title" }, p.title)),
            h(
              "div",
              { className: "pxs-card-meta" },
              h(Link, { to: sourceLink(p.source) }, sourceLabel(p.source)),
              p.scene_id && h(Link, { to: `/scenes/${p.scene_id}` }, " · exported"),
              h("span", null, " · " + new Date(p.updated * 1000).toLocaleString()),
              h("button", { className: "pxs-link pxs-danger", onClick: () => remove(p.id) }, confirm === p.id ? "Click again to delete" : "Delete")
            )
          )
        )
      )
    );
  }

  // ---------------------------------------------------------------- new project

  function NewProject() {
    const history = useHistory();
    const q = new URLSearchParams(useLocation().search);
    const src = q.get("image")
      ? { kind: "image", id: Number(q.get("image")) }
      : { kind: "scene", id: Number(q.get("scene")), time: Number(q.get("t") || 0), ...(q.get("span") ? { span: Number(q.get("span")) } : {}) };
    const [existing, setExisting] = React.useState(null);
    const [error, setError] = React.useState(null);

    const create = React.useCallback(() => {
      const ai = Number(q.get("ai") || 1);
      api("project", { source: src, settings: ai > 1 ? { interp: ai } : {} }).then(
        (res) => history.replace(`/parallax/${res.project.id}${res.job ? `?job=${res.job}` : ""}`),
        (e) => setError(e.message)
      );
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    React.useEffect(() => {
      api(`projects?source=${sourceKey(src)}`).then((list) => (list.length ? setExisting(list) : create()), (e) => setError(e.message));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (error) return h("div", { className: "pxs-list" }, h("div", { className: "pxs-warning" }, error));
    if (!existing) return h("div", { className: "pxs-list" }, "Starting…");
    return h(
      "div",
      { className: "pxs-list" },
      h("h1", null, "Parallax Studio"),
      h("p", null, "This still already has ", existing.length === 1 ? "a project" : `${existing.length} projects`, "."),
      h("div", { className: "pxs-choices" },
        existing.map((p) => h(Link, { key: p.id, className: "pxs-button", to: `/parallax/${p.id}` }, `Open "${p.title}"`)),
        h("button", { className: "pxs-button pxs-primary", onClick: create }, "Start a new project"))
    );
  }

  // ---------------------------------------------------------------- studio parts

  // One value: label, slider, value, and DaVinci-style keying: the diamond is filled
  // when this value has a key at the playhead (click: remove that key), outlined when
  // it's animated elsewhere and faint when not animated (click: key it here); the
  // arrows jump to this value's previous and next keys.
  function ParamRow({ label, value, def, onChange, keyed, animated, pending, onToggleKey, onPrev, onNext }) {
    const tip = def.hint ? `${label}: ${def.hint}` : label;
    return h(
      "div",
      { className: "pxs-prow" + (keyed ? " keyed" : animated ? " animated" : "") + (pending ? " pending" : ""),
        title: pending ? "Changed on the preview, not keyed yet" : undefined },
      h("span", { className: "pxs-prow-label", title: tip }, label),
      h("input", {
        type: "range", min: def.min, max: def.max, step: def.step, value,
        onChange: (e) => onChange(Number(e.target.value)),
        onDoubleClick: () => onChange(def.def),
        title: "Double-click to reset",
      }),
      h("span", { className: "pxs-prow-value" }, def.fmt(value)),
      h("span", { className: "pxs-prow-keys" },
        h("button", { className: "pxs-prow-nav", onClick: onPrev, disabled: !onPrev, title: "Previous key of this value" }, "\u25C2"),
        h("button", {
          className: "pxs-prow-key", onClick: onToggleKey,
          title: keyed ? "Keyed here: click to remove this value's key" : animated ? "Animated: click to key this value here"
            : "Not animated: click to key this value here",
        }, keyed ? "\u25C6" : "\u25C7"),
        h("button", { className: "pxs-prow-nav", onClick: onNext, disabled: !onNext, title: "Next key of this value" }, "\u25B8"))
    );
  }

  // key state and actions for each value of a keyframe list (times offset by
  // `offset`, e.g. a caption's start)
  function keyInfo(kfs, key, time, fps, offset = 0) {
    const mine = (kfs || []).filter((k) => k[key] != null).sort((a, b) => a.t - b.t);
    const here = mine.find((k) => Math.abs(offset + k.t - time) < 0.5 / fps);
    const prev = [...mine].reverse().find((k) => offset + k.t < time - 0.5 / fps);
    const next = mine.find((k) => offset + k.t > time + 0.5 / fps);
    return { keyed: !!here, animated: mine.length > 1, prev: prev && offset + prev.t, next: next && offset + next.t };
  }

  function Slider({ value, def, onChange, onCommit }) {
    return h(
      "div",
      { className: "pxs-slider" },
      h("input", {
        type: "range", min: def.min, max: def.max, step: def.step, value,
        onChange: (e) => onChange(Number(e.target.value)),
        onPointerUp: onCommit,
        onDoubleClick: () => onChange(def.def),
        title: "Double-click to reset",
      }),
      h("span", null, def.fmt(value))
    );
  }

  function MediaBin({ project, cuts, cut, urls, status, job, onUseCut, onRecut }) {
    const [form, setForm] = React.useState({
      model: "human", people: "all", soft: 2, grow: 0, fill: "lama", interp: (cut && cut.meta.interp) || 1, upscale: (cut && cut.meta.upscale) || 1,
    });
    const bullet = !!project.source.span;
    const canAI = bullet && (status?.models || []).includes("rife");
    const canUpscale = !bullet && (status?.models || []).includes("upscale");
    const set = (patch) => setForm((f) => ({ ...f, ...patch }));
    const busy = job && (job.state === "queued" || job.state === "running");
    return h(
      "div",
      { className: "pxs-bin" },
      h("h5", null, "Media"),
      h(Link, { to: sourceLink(project.source), className: "pxs-bin-item", title: "Open the source in Stash" },
        urls.source && h("img", { src: urls.source, alt: "" }),
        h("span", null, sourceLabel(project.source))),
      cut && h("div", { className: "pxs-bin-item" }, h("img", { src: urls.bg, alt: "" }), h("span", null, "Background")),
      cut && h("div", { className: "pxs-bin-item pxs-checker" }, h("img", { src: urls.fg, alt: "" }), h("span", null, "Person")),

      h("h5", null, "Re-cut"),
      h("label", null, "Finder",
        h("select", { value: form.model, onChange: (e) => set({ model: e.target.value }) },
          (status?.models || ["human"]).map((m) => h("option", { key: m, value: m }, m === "human" ? "People (U²-Net)" : "Anything (ISNet)")))),
      h("label", null, "Who",
        h("select", { value: form.people, onChange: (e) => set({ people: e.target.value }) },
          h("option", { value: "all" }, "Everyone"), h("option", { value: "main" }, "Main person only"))),
      h("label", null, `Edge softness ${form.soft}`,
        h("input", { type: "range", min: 0, max: 10, step: 0.5, value: form.soft, onChange: (e) => set({ soft: Number(e.target.value) }) })),
      h("label", null, `Grow / shrink ${form.grow > 0 ? "+" : ""}${form.grow}`,
        h("input", { type: "range", min: -20, max: 20, step: 1, value: form.grow, onChange: (e) => set({ grow: Number(e.target.value) }) })),
      h("label", null, "Fill",
        h("select", { value: form.fill, onChange: (e) => set({ fill: e.target.value }) },
          h("option", { value: "lama" }, "Content-aware (LaMa)"), h("option", { value: "fast" }, "Fast (rough)"))),
      canUpscale && h("label", { title: "Real-ESRGAN enlarges the still before the cut-out, so zooms stay sharp (about 5 s more)" },
        "AI upscale first",
        h("select", { value: form.upscale, onChange: (e) => set({ upscale: Number(e.target.value) }) },
          h("option", { value: 1 }, "Off"), h("option", { value: 2 }, "2×"), h("option", { value: 4 }, "4× (capped at 3840 px)"))),
      canAI && h("label", { title: "RIFE makes new frames between the captured ones: much smoother slow motion, slower to cut" },
        "AI in-between frames",
        h("select", { value: form.interp, onChange: (e) => set({ interp: Number(e.target.value) }) },
          h("option", { value: 1 }, "Off (about 35 s)"),
          h("option", { value: 2 }, "2× (about 1 min)"),
          h("option", { value: 4 }, "4× (about 2½ min)"))),
      h("button", { className: "pxs-button", disabled: busy || !status?.enabled, onClick: () => onRecut(form) }, busy ? "Working…" : "Re-cut"),
      job && busy && h("div", { className: "pxs-progress" }, h("i", { style: { width: `${Math.round(job.progress * 100)}%` } }), h("span", null, job.stage)),
      job && job.state === "error" && h("div", { className: "pxs-warning" }, job.error),

      cuts.length > 1 && h("h5", null, "Cuts"),
      cuts.length > 1 &&
        cuts.map((c) =>
          h("button", {
            key: c.id,
            className: "pxs-cut" + (cut && c.id === cut.id ? " active" : ""),
            onClick: () => onUseCut(c.id),
            title: JSON.stringify(c.meta),
          },
          `${c.meta.model === "general" ? "Anything" : "People"} · ${c.meta.people === "main" ? "main" : "all"} · soft ${c.meta.soft} · ${c.meta.grow >= 0 ? "+" : ""}${c.meta.grow} · ${c.meta.fill}` +
            (c.meta.frames ? ` · ${c.meta.frames} frames${c.meta.interp > 1 ? ` (AI ${c.meta.interp}×)` : ""}` : "") +
            (c.meta.upscale > 1 ? ` · upscaled ${c.meta.upscale}×` : ""))
        )
    );
  }

  // A caption's effects: each with its options and a remove button, plus "Add effect".
  function CaptionEffects({ cap, update }) {
    const FX = R().CAPTION_EFFECTS;
    const effects = cap.effects || [];
    const set = (id, patch) => update({ effects: effects.map((fx) => (fx.id === id ? { ...fx, ...patch } : fx)) });
    const secs = { min: 0.1, max: 5, step: 0.05, def: 0.5, fmt: (v) => v.toFixed(2) + " s" };
    const options = (fx) => {
      if (fx.type === "fade") {
        return h(React.Fragment, null,
          h("label", { className: "pxs-check" },
            h("input", { type: "checkbox", checked: !!fx.in, onChange: (e) => set(fx.id, { in: e.target.checked }) }), " Fade in"),
          fx.in && h(Slider, { value: fx.inDur, def: secs, onChange: (v) => set(fx.id, { inDur: v }), onCommit: () => {} }),
          h("label", { className: "pxs-check" },
            h("input", { type: "checkbox", checked: !!fx.out, onChange: (e) => set(fx.id, { out: e.target.checked }) }), " Fade out"),
          fx.out && h(Slider, { value: fx.outDur, def: secs, onChange: (v) => set(fx.id, { outDur: v }), onCommit: () => {} }));
      }
      return null;
    };
    return h(
      React.Fragment,
      null,
      h("h5", null, "Effects"),
      effects.map((fx) =>
        h("div", { key: fx.id, className: "pxs-effect" },
          h("div", { className: "pxs-effect-head" },
            h("span", null, (FX[fx.type] || { label: fx.type }).label),
            h("button", { className: "pxs-link pxs-danger", onClick: () => update({ effects: effects.filter((x) => x.id !== fx.id) }), title: "Remove this effect" }, "Remove")),
          options(fx))),
      h("select", {
        value: "", className: "pxs-add-effect",
        onChange: (e) => {
          const type = e.target.value;
          if (type) update({ effects: [...effects, { id: newId(), type, ...FX[type].defaults }] });
        },
      },
        h("option", { value: "" }, "+ Add effect…"),
        Object.entries(FX).map(([k, v]) => h("option", { key: k, value: k }, v.label)))
    );
  }

  function CaptionInspector({ cap, update, remove, length, time, kfAt, onParam, onAddKf, onDeleteKf, onEase, onToggleKey, setTime, fps }) {
    const S = window.SlideshowCaptions || {};
    const fonts = R().fonts();
    const field = (label, el) => h("label", { className: "pxs-field" }, h("span", null, label), el);
    return h(
      "div",
      null,
      h("h5", null, "Caption"),
      field("Text", h("input", { value: cap.text, onChange: (e) => update({ text: e.target.value }) })),
      field("Line 2", h("input", { value: cap.text2, onChange: (e) => update({ text2: e.target.value }) })),
      h("div", { className: "pxs-row" },
        field("In", h("input", { type: "number", step: 0.1, min: 0, max: length, value: cap.start.toFixed(2),
          onChange: (e) => update({ start: Math.max(0, Math.min(cap.end - 0.1, Number(e.target.value))) }) })),
        field("Out", h("input", { type: "number", step: 0.1, min: 0, max: length, value: cap.end.toFixed(2),
          onChange: (e) => update({ end: Math.min(length, Math.max(cap.start + 0.1, Number(e.target.value))) }) }))),
      h("span", { className: "pxs-label" }, "Font"),
      h("div", { className: "pxs-fonts" },
        fonts.map((f) => h("button", {
          key: f.id, className: "pxs-font" + (cap.font === f.id ? " active" : ""),
          style: { fontFamily: f.css, fontWeight: f.weight || 400 }, onClick: () => update({ font: f.id }),
        }, f.label))),
      field(`Size ${cap.size}`, h("input", { type: "range", min: 2, max: 25, step: 0.5, value: cap.size, onChange: (e) => update({ size: Number(e.target.value) }) })),
      h("div", { className: "pxs-row" },
        field("Colour", h("input", { type: "color", value: cap.color, onChange: (e) => update({ color: e.target.value }) })),
        field("Blend", h("select", { value: cap.blend, onChange: (e) => update({ blend: e.target.value }) },
          (S.BLEND_MODES || ["normal"]).map((b) => h("option", { key: b, value: b }, b))))),
      h("div", { className: "pxs-row" },
        field("Style", h("select", { value: cap.style, onChange: (e) => update({ style: e.target.value }) },
          [["shadow", "Drop shadow"], ["outline", "Outline"], ["box", "Solid box"], ["plain", "Plain"]].map(([v, l]) => h("option", { key: v, value: v }, l)))),
        field("Animation", h("select", { value: cap.anim, onChange: (e) => update({ anim: e.target.value }) },
          [["rise", "Rise"], ["fade", "Fade"], ["slide", "Slide in"], ["pop", "Pop"], ["none", "None"]].map(([v, l]) => h("option", { key: v, value: v }, l))))),
      h("span", { className: "pxs-label" }, "Position"),
      h("div", { className: "pxs-positions" },
        (S.POSITIONS || ["bottom-left"]).map((p) => h("button", {
          key: p, className: "pxs-pos" + (cap.position === p ? " active" : ""), onClick: () => update({ position: p }), title: p,
        }))),
      h("label", { className: "pxs-check" },
        h("input", { type: "checkbox", checked: cap.uppercase, onChange: (e) => update({ uppercase: e.target.checked }) }), " Uppercase"),
      field("Attached to", h("select", { value: R().captionAttach(cap), onChange: (e) => update({ attach: e.target.value }) },
        [["person", "Person (moves in 3D like the person)"], ["background", "Background (behind the person, moves like it)"],
         ["camera", "Camera (turns with the camera only)"], ["screen", "Screen (flat, ignores the camera)"]].map(([v, l]) =>
          h("option", { key: v, value: v }, l)))),

      h(CaptionEffects, { cap, update }),

      h("h5", null, "Animation"),
      h("p", { className: "pxs-muted pxs-small" }, "Position, scale and rotation are within the plane the caption is attached to."),
      time >= cap.start && time <= cap.end
        ? h(React.Fragment, null,
            R().CAPTION_KEYS.map((k) => {
              const def = R().CAPTION_PARAMS[k];
              const ki = keyInfo(cap.keyframes, k, time, fps, cap.start);
              return h(ParamRow, {
                key: k, label: def.label, value: R().captionAt(cap, time)[k], def, onChange: (v) => onParam(k, v),
                keyed: ki.keyed, animated: ki.animated, onToggleKey: () => onToggleKey(k),
                onPrev: ki.prev != null ? () => setTime(ki.prev) : null, onNext: ki.next != null ? () => setTime(ki.next) : null,
              });
            }),
            h("div", { className: "pxs-row" },
              kfAt
                ? h("button", { className: "pxs-button", onClick: onDeleteKf }, "Delete keyframe")
                : h("button", { className: "pxs-button", onClick: onAddKf }, "Add keyframe (K)"),
              kfAt && h("select", { value: kfAt.ease, onChange: (e) => onEase(e.target.value), title: "Easing to the next keyframe" },
                EASE_OPTIONS.map(([v, l]) => h("option", { key: v, value: v }, l)))),
            h("p", { className: "pxs-muted pxs-small" },
              kfAt ? "Editing the caption keyframe at the playhead." : "Changing a value adds a caption keyframe at the playhead.",
              ` ${(cap.keyframes || []).length} keyframe${(cap.keyframes || []).length === 1 ? "" : "s"}.`))
        : h("p", { className: "pxs-muted pxs-small" }, "Move the playhead into this caption's clip to animate it."),

      h("button", { className: "pxs-link pxs-danger", onClick: remove }, "Delete caption")
    );
  }

  function CameraInspector({ project, time, fps, cover, onParam, onCommit, kfAt, onAddKf, onDeleteKf, onEase, onCentre, bullet,
    onToggleKey, setTime, viewKeyframes, pending }) {
    const P = R().PARAMS;
    const cam = R().cameraAt(viewKeyframes || project.keyframes, time, project.smooth);
    const sliders = (group) =>
      R().PARAM_KEYS.filter((k) => (P[k].group || "camera") === group).map((k) => {
        const ki = keyInfo(project.keyframes, k, time, fps);
        return h(ParamRow, {
          key: k, label: P[k].label, value: cam[k], def: P[k], onChange: (v) => onParam(k, v),
          keyed: ki.keyed, animated: ki.animated, pending: pending && pending[k] != null, onToggleKey: () => onToggleKey(k),
          onPrev: ki.prev != null ? () => setTime(ki.prev) : null, onNext: ki.next != null ? () => setTime(ki.next) : null,
        });
      });
    return h(
      "div",
      null,
      h("div", { className: "pxs-row" },
        kfAt
          ? h("button", { className: "pxs-button", onClick: onDeleteKf }, "Delete keyframe")
          : h("button", { className: "pxs-button", onClick: onAddKf }, "Add keyframe (K)"),
        kfAt && h("select", { value: kfAt.ease, onChange: (e) => onEase(e.target.value), title: "Easing to the next keyframe" },
          EASE_OPTIONS.map(([v, l]) =>
            h("option", { key: v, value: v }, l)))),
      h("p", { className: "pxs-muted pxs-small" },
        kfAt ? "Editing the keyframe at the playhead." : "Changing a value keys just that value at the playhead (◆ = keyed here).",
        ` ${project.keyframes.length} keyframe${project.keyframes.length === 1 ? "" : "s"}, ${fps} fps.`),


      h("h5", null, `Camera @ ${fmtTime(time)}`),
      sliders("camera"),
      h("div", { className: "pxs-muted pxs-small" },
        cover.c > 1.001 ? `Picture zoomed ${cover.c.toFixed(2)}× so the cut-off edge of the person never shows. ` : "",
        cover.cb > 1.001 ? `Background enlarged ${cover.cb.toFixed(2)}× so its edges never show.` : "No edge zoom needed.",
        cover.cb > 1.6 ? " Orbiting less, or a smaller depth gap, needs less." : ""),

      h("h5", null, "Scene"),
      sliders("scene"),
      bullet > 0 && h("h5", null, `Bullet time (${bullet} frames)`),
      bullet > 0 && sliders("action"),
      bullet > 0 && h("p", { className: "pxs-muted pxs-small" },
        "Action runs through the captured second: keyframe it slowly for slow motion, hold it for a freeze, ",
        "or shape it in Curves for speed ramps."),
      h("div", { className: "pxs-row" },
        h("button", { className: "pxs-button", onClick: onCentre, title: "Put the orbit point on the person's centre" }, "Orbit the person")),
      h("p", { className: "pxs-muted pxs-small" },
        "On the preview: drag the cross (or click) to move the orbit point; drag elsewhere orbits the camera around it, Shift+drag slides, the wheel dollies. These view changes aren't keyed until you press Key changes (K).")
    );
  }

  // Graph editor for keyframed values: one value's curve over time, keyframes as
  // points (drag up/down for the value, sideways to retime) and, between each pair,
  // the two Bézier handles of that move's timing curve (dragging one makes the move
  // "custom"). A keyframe holds every value, so a timing curve applies to all of
  // that move's values. Works on the camera's keyframes or the selected caption's.
  function CurveEditor({ project, time, setTime, fps, selection, setSelection, change, setPlaying }) {
    const cap = selection.caption && project.captions.find((c) => c.id === selection.caption);
    const params = cap ? R().CAPTION_PARAMS : R().PARAMS;
    const keys = Object.keys(params);
    const [chosen, setChosen] = React.useState({ camera: "turn", caption: "opacity" });
    const key = keys.includes(chosen[cap ? "caption" : "camera"]) ? chosen[cap ? "caption" : "camera"] : keys[0];
    const def = params[key];
    // smoothing: per value ({key: true}) on the project, or on the caption
    const smooth = (cap ? cap.smooth : project.smooth) || {};
    const isSmooth = !!smooth[key];
    const setSmooth = (s) => {
      if (cap) change((p) => ({ ...p, captions: p.captions.map((c) => (c.id === cap.id ? { ...c, smooth: s } : c)) }));
      else change((p) => ({ ...p, smooth: s }));
    };
    const allSmooth = keys.every((k) => smooth[k]);
    const offset = cap ? cap.start : 0;
    // this value's own keys (keys are per value)
    const kfs = (cap ? cap.keyframes || [] : project.keyframes).filter((k) => k[key] != null).sort((a, b) => a.t - b.t);
    const valueAt = (t) => (cap ? R().captionAt(cap, t) : R().cameraAt(project.keyframes, t, project.smooth))[key];
    const L = project.length;
    const t0 = cap ? cap.start : 0;
    const t1 = cap ? cap.end : L;

    const boxRef = React.useRef(null);
    const [w, setW] = React.useState(600);
    React.useEffect(() => {
      const ro = new ResizeObserver(() => boxRef.current && setW(boxRef.current.clientWidth));
      ro.observe(boxRef.current);
      return () => ro.disconnect();
    }, []);
    const HGT = 190;
    const PAD = 14;

    // value range: the curve's, padded (frozen while dragging so nothing jumps)
    const frozen = React.useRef(null);
    const [, redraw] = React.useState(0);
    let range = frozen.current;
    if (!range) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i <= 120; i++) {
        const v = valueAt(t0 + ((t1 - t0) * i) / 120);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      kfs.forEach((k, i) => {
        const v = k[key] ?? def.def;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
        // keep the timing curves' handles on screen too, so they can be grabbed
        const b = kfs[i + 1];
        if (b && k.ease === "custom" && k.bez) {
          const dv = (b[key] ?? def.def) - v;
          [k.bez[1], k.bez[3]].forEach((y) => { lo = Math.min(lo, v + y * dv); hi = Math.max(hi, v + y * dv); });
        }
      });
      const minSpan = (def.max - def.min) * 0.1;
      if (hi - lo < minSpan) { const m = (hi + lo) / 2; lo = m - minSpan / 2; hi = m + minSpan / 2; }
      const pad = (hi - lo) * 0.15;
      range = [lo - pad, hi + pad];
    }
    const X = (t) => (t / L) * w;
    const Y = (v) => PAD + (1 - (v - range[0]) / (range[1] - range[0])) * (HGT - 2 * PAD);
    const toT = (x) => (x / w) * L;
    const toV = (y) => range[0] + (1 - (y - PAD) / (HGT - 2 * PAD)) * (range[1] - range[0]);

    const setKfs = (fn) => {
      if (cap) change((p) => ({ ...p, captions: p.captions.map((c) => (c.id === cap.id ? { ...c, keyframes: fn(c.keyframes || []) } : c)) }));
      else change((p) => ({ ...p, keyframes: fn(p.keyframes) }));
    };
    const local = (e) => {
      const r = boxRef.current.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    function drag(e, onMove) {
      e.preventDefault();
      e.stopPropagation();
      setPlaying(false);
      frozen.current = range;
      const el = e.currentTarget;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
      const move = (ev) => onMove(local(ev));
      const up = () => {
        frozen.current = null;
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        redraw((n) => n + 1); // with a fresh range
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    }

    // the curve
    const pts = [];
    for (let i = 0; i <= 240; i++) {
      const tt = t0 + ((t1 - t0) * i) / 240;
      pts.push(`${X(tt).toFixed(1)},${Y(valueAt(tt)).toFixed(1)}`);
    }
    const span = range[1] - range[0];
    const handles = [];
    for (let i = 0; i + 1 < kfs.length && !isSmooth; i++) {
      const a = kfs[i], b = kfs[i + 1];
      if (a.ease === "hold") continue;
      const bez = a.ease === "custom" && a.bez ? a.bez : R().PRESET_BEZ[a.ease] || R().PRESET_BEZ.inout;
      const va = a[key] ?? def.def, vb = b[key] ?? def.def;
      // a flat move still gets handles, drawn as if it rose by a quarter of the view
      const dv = Math.abs(vb - va) > span * 0.02 ? vb - va : span * 0.25;
      const ta = offset + a.t, dt = b.t - a.t;
      const hp = (j) => ({ t: ta + bez[j * 2] * dt, v: va + bez[j * 2 + 1] * dv });
      handles.push({ a, b, ta, dt, va, dv, bez, h: [hp(0), hp(1)] });
    }

    const kfSelected = (k) => (cap ? selection.ckf === k.id : selection.kf === k.id);
    const selectKf = (k) => setSelection(cap ? { type: "caption", caption: cap.id, ckf: k.id } : { type: "camera", kf: k.id });

    return h(
      "div",
      { className: "pxs-track pxs-curves" },
      h(
        "div",
        { className: "pxs-track-label" },
        h("div", { className: "pxs-small pxs-muted" }, cap ? `Caption "${cap.text || ""}"` : "Camera & scene"),
        h("select", {
          value: key, className: "pxs-curve-param",
          onChange: (e) => { const v = e.target.value; setChosen((c) => ({ ...c, [cap ? "caption" : "camera"]: v })); },
        }, keys.map((k) => h("option", { key: k, value: k }, params[k].label))),
        h("div", { className: "pxs-small pxs-muted", style: { marginTop: 6 } }, def.fmt(valueAt(Math.max(t0, Math.min(t1, time))))),
        h("button", {
          className: "pxs-button pxs-curve-btn" + (isSmooth ? " pxs-primary" : ""),
          title: isSmooth ? "Back to the keyframes' timing curves for this value"
            : "Make this value flow smoothly through its keyframes (no stops, no overshoot)",
          onClick: () => setSmooth({ ...smooth, [key]: !isSmooth }),
        }, isSmooth ? "Unsmooth" : "Smooth"),
        h("button", {
          className: "pxs-button pxs-curve-btn",
          title: allSmooth ? "Back to the timing curves for every value" : "Smooth every value's curve",
          onClick: () => setSmooth(allSmooth ? {} : Object.fromEntries(keys.map((k) => [k, true]))),
        }, allSmooth ? "Unsmooth all" : "Smooth all")
      ),
      h(
        "div",
        { className: "pxs-lane pxs-curve-box", ref: boxRef, style: { height: HGT } },
        h(
          "svg",
          {
            width: w, height: HGT,
            onPointerDown: (e) => {
              const p = local(e);
              setPlaying(false);
              setTime(Math.max(0, Math.min(L, Math.round(toT(p.x) * fps) / fps)));
            },
          },
          // grid: a line per second and the value range's ends
          [...Array(Math.floor(L) + 1).keys()].map((s) => h("line", { key: "g" + s, x1: X(s), x2: X(s), y1: 0, y2: HGT, className: "pxs-grid" })),
          h("text", { x: 4, y: PAD - 3, className: "pxs-axis" }, def.fmt(range[1])),
          h("text", { x: 4, y: HGT - 3, className: "pxs-axis" }, def.fmt(range[0])),
          cap && h("rect", { x: X(t0), y: 0, width: X(t1) - X(t0), height: HGT, className: "pxs-curve-clip" }),
          h("polyline", { points: pts.join(" "), className: "pxs-curve" }),
          handles.map((s, i) =>
            h("g", { key: "h" + i },
              h("line", { x1: X(s.ta), y1: Y(s.va), x2: X(s.h[0].t), y2: Y(s.h[0].v), className: "pxs-handle-line" }),
              h("line", { x1: X(s.ta + s.dt), y1: Y(s.va + s.dv), x2: X(s.h[1].t), y2: Y(s.h[1].v), className: "pxs-handle-line" }),
              [0, 1].map((j) =>
                h("rect", {
                  key: j, x: X(s.h[j].t) - 4, y: Y(s.h[j].v) - 4, width: 8, height: 8, className: "pxs-handle",
                  onPointerDown: (e) => drag(e, (p) => {
                    const u = Math.max(0, Math.min(1, (toT(p.x) - s.ta) / Math.max(1e-6, s.dt)));
                    const y = (toV(p.y) - s.va) / s.dv;
                    const bez = s.bez.slice();
                    bez[j * 2] = u;
                    bez[j * 2 + 1] = Math.max(-2, Math.min(3, y));
                    setKfs((list) => list.map((k) => (k.id === s.a.id ? { ...k, ease: "custom", bez } : k)));
                  }),
                })))),
          kfs.map((k, i) => {
            const prev = kfs[i - 1], next = kfs[i + 1];
            return h("circle", {
              key: k.id, cx: X(offset + k.t), cy: Y(k[key] ?? def.def), r: 6,
              className: "pxs-curve-kf" + (kfSelected(k) ? " active" : ""),
              onPointerDown: (e) => {
                selectKf(k);
                setTime(offset + k.t);
                drag(e, (p) => {
                  const step = 1 / fps;
                  const lo = prev ? prev.t + step : 0;
                  const hi = next ? next.t - step : cap ? cap.end - cap.start : L;
                  const tt = Math.max(lo, Math.min(hi, Math.round((toT(p.x) - offset) * fps) / fps));
                  const v = Math.max(def.min, Math.min(def.max, toV(p.y)));
                  setKfs((list) => list.map((x) => (x.id === k.id ? { ...x, t: tt, [key]: v } : x)));
                  setTime(offset + tt);
                });
              },
            });
          }),
          h("line", { x1: X(time), x2: X(time), y1: 0, y2: HGT, className: "pxs-curve-playhead" })
        )
      )
    );
  }

  // Shaded ramps over a caption clip where its fades are.
  function fadeRamps(c) {
    const len = Math.max(0.001, c.end - c.start);
    const parts = [];
    for (const fx of c.effects || []) {
      if (fx.type !== "fade") continue;
      if (fx.in) parts.push(`linear-gradient(to right, rgba(0,0,0,0.55), transparent ${Math.min(100, (fx.inDur / len) * 100)}%)`);
      if (fx.out) parts.push(`linear-gradient(to left, rgba(0,0,0,0.55), transparent ${Math.min(100, (fx.outDur / len) * 100)}%)`);
    }
    return parts.join(", ") || undefined;
  }

  // Timeline: ruler + tracks. Drag the ruler or empty space to scrub, drag keyframe
  // diamonds to retime them, drag caption clips (or their edges) to move/trim them.
  function Timeline({ project, time, setTime, fps, playing, setPlaying, selection, setSelection, change, commit, addCaption, addKf, cutLabel, onFullscreen }) {
    const laneRef = React.useRef(null);
    const [curves, setCurves] = React.useState(false);
    const L = project.length;
    const snap = (t) => Math.max(0, Math.min(L, Math.round(t * fps) / fps));
    const timeAt = (clientX) => {
      const r = laneRef.current.getBoundingClientRect();
      return snap(((clientX - r.left) / r.width) * L);
    };
    const pct = (t) => `${(t / L) * 100}%`;

    function drag(e, onMove) {
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
      const startX = e.clientX;
      const move = (ev) => onMove(ev, ev.clientX - startX);
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        commit();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    }

    function scrub(e) {
      setPlaying(false);
      setTime(timeAt(e.clientX));
      drag(e, (ev) => setTime(timeAt(ev.clientX)));
    }

    const secPx = () => laneRef.current.getBoundingClientRect().width / L;
    const ticks = [];
    for (let s = 0; s <= L + 1e-6; s += L > 20 ? 5 : 1) ticks.push(s);

    const [expanded, setExpanded] = React.useState({}); // "camera" or a caption id -> its value lanes are shown
    const track = (label, content, extra) =>
      h("div", { className: "pxs-track" + (extra || "") }, h("div", { className: "pxs-track-label" }, label),
        h("div", { className: "pxs-lane", onPointerDown: scrub }, content, h("div", { className: "pxs-playhead", style: { left: pct(time) } })));
    const expander = (id, label, title) =>
      h("span", { className: "pxs-cap-label" },
        h("button", {
          className: "pxs-expand", title: expanded[id] ? "Hide the value lanes" : "Show a lane per animated value",
          onClick: () => setExpanded((x) => ({ ...x, [id]: !x[id] })),
        }, expanded[id] ? "\u25BE" : "\u25B8"),
        h("span", { title }, label));

    // A lane per value (keys), with diamonds only where that value is keyed. kfs are the
    // track's keyframes, timed from start (a caption's are relative to its start); dragging a
    // diamond retimes just that value's key: it moves to (or merges into) a keyframe at the
    // new time, and a keyframe left holding nothing goes. Worked on a copy kept for the drag,
    // so each move builds on the last one.
    function valueLanes({ keys, params, kfs, start, span, active, select, write }) {
      return keys.map((key) =>
        track(h("span", { className: "pxs-sub-label", title: params[key].hint }, params[key].label),
          h(React.Fragment, null,
            h("div", { className: "pxs-sub-extent", style: { left: pct(start), width: pct(span) } }),
            kfs.filter((k) => k[key] != null).map((k) =>
              h("span", {
                key: k.id,
                className: "pxs-kf pxs-vkf" + (active(k, key) ? " active" : ""),
                style: { left: pct(start + k.t) },
                title: `${params[key].label} ${params[key].fmt(k[key])} at ${fmtTime(start + k.t)}`,
                onPointerDown: (e) => {
                  select(k.id, key);
                  setPlaying(false);
                  setTime(start + k.t);
                  let local = kfs.slice();
                  let holder = k.id;
                  const t0 = k.t;
                  drag(e, (ev, dx) => {
                    const lt = Math.max(0, Math.min(span, snap(start + t0 + dx / secPx()) - start));
                    const src = local.find((y) => y.id === holder);
                    if (!src || Math.abs(src.t - lt) < 1e-6) return;
                    const value = src[key];
                    const { [key]: gone, ...rest } = src;
                    const keepSrc = Object.keys(rest).some((y) => !["id", "t", "ease", "bez"].includes(y));
                    let next = local.flatMap((y) => (y.id !== holder ? [y] : keepSrc ? [rest] : []));
                    const target = next.find((y) => Math.abs(y.t - lt) < 0.5 / fps);
                    if (target) {
                      holder = target.id;
                      next = next.map((y) => (y === target ? { ...y, [key]: value } : y));
                    } else {
                      holder = newId();
                      next = [...next, { id: holder, t: lt, [key]: value, ease: src.ease || "inout", ...(src.bez ? { bez: src.bez } : {}) }];
                    }
                    local = next;
                    write(next);
                    select(holder, key);
                    setTime(start + lt);
                  });
                },
              }))),
          " pxs-sub-track"));
    }
    // the camera's lanes: the values that are keyed somewhere (the rest are static)
    const cameraKeys = R().PARAM_KEYS.filter((key) => project.keyframes.some((k) => k[key] != null));

    return h(
      "div",
      { className: "pxs-timeline" },
      h(
        "div",
        { className: "pxs-transport" },
        h("button", { onClick: () => { setPlaying(false); setTime(0); }, title: "To start (Home)" }, "⏮︎"),
        h("button", { onClick: () => setPlaying(!playing), title: "Play/pause (Space)" }, playing ? "⏸︎" : "▶︎"),
        h("button", { onClick: onFullscreen, title: "Full screen preview (F)" }, "\u26F6"),
        h("span", { className: "pxs-timecode" }, `${fmtTime(time)} / ${fmtTime(L)}${project.boomerang ? " \u21C4 boomerang" : ""}`),
        h("span", { className: "pxs-spacer" }),
        h("button", {
          className: "pxs-button" + (curves ? " pxs-primary" : ""), onClick: () => setCurves(!curves),
          title: "Show the keyframed values as editable curves",
        }, "\u223F Curves"),
        h("button", { className: "pxs-button", onClick: addKf }, "+ Keyframe"),
        h("button", { className: "pxs-button", onClick: addCaption }, "+ Caption")
      ),
      h(
        "div",
        { className: "pxs-track pxs-ruler-row" },
        h("div", { className: "pxs-track-label" }),
        h("div", { className: "pxs-lane pxs-ruler", ref: laneRef, onPointerDown: scrub },
          ticks.map((s) => h("span", { key: s, className: "pxs-tick", style: { left: pct(s) } }, `${s}s`)),
          h("div", { className: "pxs-playhead", style: { left: pct(time) } }))
      ),
      curves ? h(CurveEditor, { project, time, setTime, fps, selection, setSelection, change, setPlaying }) : h(React.Fragment, null,
      track(expander("camera", "Camera", "Camera and scene keyframes"),
        project.keyframes.filter((k) => R().PARAM_KEYS.some((x) => k[x] != null)).map((k) =>
          h("span", {
            key: k.id,
            className: "pxs-kf" + (selection?.kf === k.id ? " active" : ""),
            style: { left: pct(k.t) },
            title: `${fmtTime(k.t)} · ${k.ease}`,
            onPointerDown: (e) => {
              setSelection({ type: "camera", kf: k.id });
              setPlaying(false);
              setTime(k.t);
              const t0 = k.t;
              drag(e, (ev, dx) => {
                const t = snap(t0 + dx / secPx());
                change((p) => ({ ...p, keyframes: p.keyframes.map((x) => (x.id === k.id ? { ...x, t } : x)) }));
                setTime(t);
              });
            },
          }))),
      expanded.camera && valueLanes({
        keys: cameraKeys, params: R().PARAMS, kfs: project.keyframes, start: 0, span: L,
        active: (k, key) => selection?.kf === k.id && selection?.key === key,
        select: (id, key) => setSelection({ type: "camera", kf: id, key }),
        write: (kfs) => change((p) => ({ ...p, keyframes: kfs })),
      }),
      expanded.camera && cameraKeys.length === 0 && track(h("span", { className: "pxs-sub-label" }, "(nothing keyed)"), null, " pxs-sub-track"),
      project.captions.map((c, i) =>
        h(React.Fragment, { key: c.id },
          track(expander(c.id, i === 0 && !c.text ? "Captions" : c.text || "Caption", c.text),
            h("div", {
              className: "pxs-clip pxs-clip-caption" + (selection?.caption === c.id ? " active" : ""),
              style: { left: pct(c.start), width: pct(c.end - c.start), backgroundImage: fadeRamps(c) },
              onPointerDown: (e) => {
                setSelection({ type: "caption", caption: c.id });
                const r = e.currentTarget.getBoundingClientRect();
                const edge = e.clientX - r.left < 8 ? "start" : r.right - e.clientX < 8 ? "end" : "move";
                const s0 = c.start;
                const e0 = c.end;
                drag(e, (ev, dx) => {
                  const d = dx / secPx();
                  change((p) => ({
                    ...p,
                    captions: p.captions.map((x) => {
                      if (x.id !== c.id) return x;
                      if (edge === "start") return { ...x, start: snap(Math.min(e0 - 0.1, s0 + d)) };
                      if (edge === "end") return { ...x, end: snap(Math.max(s0 + 0.1, e0 + d)) };
                      const len = e0 - s0;
                      const s = snap(Math.max(0, Math.min(L - len, s0 + d)));
                      return { ...x, start: s, end: s + len };
                    }),
                  }));
                });
              },
            },
            h("span", { className: "pxs-clip-label" }, c.text || "(empty)"),
            // keyframes that hold at least one value (keys are per value)
            (c.keyframes || []).filter((k) => R().CAPTION_KEYS.some((x) => k[x] != null)).map((k) =>
              h("span", {
                key: k.id,
                className: "pxs-kf pxs-ckf" + (selection?.ckf === k.id ? " active" : ""),
                style: { left: `${(k.t / Math.max(0.001, c.end - c.start)) * 100}%` },
                title: `${fmtTime(c.start + k.t)} · ${k.ease}`,
                onPointerDown: (e) => {
                  setSelection({ type: "caption", caption: c.id, ckf: k.id });
                  setPlaying(false);
                  setTime(c.start + k.t);
                  const t0 = k.t;
                  drag(e, (ev, dx) => {
                    const lt = Math.max(0, Math.min(c.end - c.start, snap(c.start + t0 + dx / secPx()) - c.start));
                    change((p) => ({
                      ...p,
                      captions: p.captions.map((x) => (x.id !== c.id ? x : {
                        ...x, keyframes: x.keyframes.map((y) => (y.id === k.id ? { ...y, t: lt } : y)),
                      })),
                    }));
                    setTime(c.start + lt);
                  });
                },
              })))),
          expanded[c.id] && valueLanes({
            keys: R().CAPTION_KEYS, params: R().CAPTION_PARAMS, kfs: c.keyframes || [], start: c.start, span: c.end - c.start,
            active: (k, key) => selection?.ckf === k.id && selection?.ckey === key,
            select: (id, key) => setSelection({ type: "caption", caption: c.id, ckf: id, ckey: key }),
            write: (kfs) => change((p) => ({ ...p, captions: p.captions.map((x) => (x.id === c.id ? { ...x, keyframes: kfs } : x)) })),
          }))),
      project.captions.length === 0 && track("Captions", null, " pxs-empty"),
      track("Person", h("div", { className: "pxs-clip pxs-clip-person", style: { left: 0, width: "100%" } }, h("span", null, cutLabel))),
      track("Background", h("div", { className: "pxs-clip pxs-clip-bg", style: { left: 0, width: "100%" } }, h("span", null, cutLabel))))
    );
  }

  // ---------------------------------------------------------------- studio

  function Studio({ pid }) {
    const history = useHistory();
    const location = useLocation();
    const status = useStatus();
    const [project, setProject] = React.useState(null);
    const [error, setError] = React.useState(null);
    const [cuts, setCuts] = React.useState([]);
    const [urls, setUrls] = React.useState({});
    const [images, setImages] = React.useState({});
    const [job, setJob] = React.useState(null);
    const [time, setTime] = React.useState(0);
    const [playing, setPlaying] = React.useState(false);
    const [selection, setSelection] = React.useState({ type: "camera" });
    const [saved, setSaved] = React.useState("saved");
    const [exporting, setExporting] = React.useState(null);
    const [confirmDelete, setConfirmDelete] = React.useState(false);
    const [confirmReset, setConfirmReset] = React.useState(false);
    const [versions, setVersions] = React.useState([]); // projects of the same still
    const canvasRef = React.useRef(null);
    const stageRef = React.useRef(null);
    const projectRef = React.useRef(null);
    // View changes made with the mouse on the preview (drag, click, wheel) aren't keyed:
    // they're held here and shown until "Key changes" keys them at the playhead (or
    // Discard drops them). Playback shows the keyed animation.
    const [pending, setPending] = React.useState(null);
    const pendingRef = React.useRef(null);
    pendingRef.current = pending;
    projectRef.current = project;
    const dirty = React.useRef(false);
    const exportState = React.useRef(null); // the running export, so Cancel can stop it

    // load project and cuts
    const loadCuts = React.useCallback(async (key) => {
      const list = await api(`cuts?source=${key}`);
      setCuts(list);
      return list;
    }, []);

    React.useEffect(() => {
      api(`project/${pid}`).then(async (p) => {
        const list = await loadCuts(p.source_key);
        if (!p.cut_id && list.length) p.cut_id = list[0].id;
        api(`projects?source=${p.source_key}`).then((v) => setVersions(v.slice().sort((a, b) => a.created - b.created)), () => {});
        setProject(withDefaults(p));
      }, (e) => setError(e.message));
    }, [pid, loadCuts]);

    // a cut job started by "new project" or "re-cut"
    const pollJob = React.useCallback((jid, onDone, onUpdate) => {
      let stop = false;
      const tick = () => api(`job/${jid}`).then((j) => {
        if (stop) return;
        (onUpdate || setJob)(j);
        if (j.state === "done") onDone(j);
        else if (j.state !== "error") setTimeout(tick, 700);
      }, (e) => setJob({ state: "error", error: e.message }));
      tick();
      return () => (stop = true);
    }, []);

    const useCut = React.useCallback((cid) => {
      dirty.current = true;
      setProject((p) => ({ ...p, cut_id: cid }));
    }, []);

    React.useEffect(() => {
      const jid = new URLSearchParams(location.search).get("job");
      if (!jid || !project) return;
      return pollJob(jid, async (j) => {
        await loadCuts(project.source_key);
        useCut(j.cut.id);
        history.replace(`/parallax/${pid}`);
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location.search, project && project.source_key]);

    function recut(settings) {
      api("cut", { source: project.source, settings }).then(
        (res) => pollJob(res.job, async (j) => { await loadCuts(project.source_key); useCut(j.cut.id); }),
        (e) => setJob({ state: "error", error: e.message })
      );
    }

    // layer images for the current cut
    const cut = project && cuts.find((c) => c.id === project.cut_id);
    // the background with its generated border, when the cut has one
    const bgFile = cut && (cut.background_ext || cut.background);
    React.useEffect(() => {
      if (!cut) return;
      let alive = true;
      (async () => {
        const u = { bg: await fileUrl(bgFile), fg: await fileUrl(cut.person), source: cut.source && (await fileUrl(cut.source)) };
        if (!alive) return;
        setUrls(u);
        const [bg, fg] = await Promise.all([loadImage(u.bg), loadImage(u.fg)]);
        if (!alive) return;
        let fgSeq = null;
        let fgEdges = R().touchingEdges(fg);
        if (cut.sequence && cut.meta.frames > 1) {
          // bullet time: every frame of the person
          const names = [...Array(cut.meta.frames).keys()].map((i) => cut.sequence.replace("%03d", String(i).padStart(3, "0")));
          fgSeq = await Promise.all(names.map(async (n) => loadImage(await fileUrl(n))));
          if (!alive) return;
          // an edge counts if the person touches it in any frame
          const all = fgSeq.map((f) => R().touchingEdges(f));
          fgEdges = Object.fromEntries(Object.keys(fgEdges).map((k) => [k, all.some((e) => e[k])]));
        }
        setImages({ bg, fg, fgSeq, fgEdges, pad: cut.background_ext ? cut.meta.pad || [0, 0] : [0, 0] });
      })().catch((e) => setError(e.message));
      return () => (alive = false);
    }, [cut && cut.id, bgFile]);

    // cuts made before backgrounds were extended get their border now
    const [extending, setExtending] = React.useState(null);
    React.useEffect(() => {
      if (!cut || cut.background_ext || !project) return;
      let stop = null;
      api("extend", { source_key: project.source_key, cut: cut.id }).then(
        (res) => { stop = pollJob(res.job, () => { setExtending(null); loadCuts(project.source_key); }, setExtending); },
        (e) => setExtending({ state: "error", error: e.message })
      );
      return () => stop && stop();
    }, [cut && cut.id, cut && !!cut.background_ext]);

    // the orbit point on the centre of the visible part of the person
    function personOrbit(framing) {
      const ext = R().extent(images.fg.naturalWidth, images.fg.naturalHeight, W, H, framing);
      const c = R().personCentre(images.fg, R().visibleBox(ext));
      return R().stillToView(c.fx, c.fy, ext);
    }
    React.useEffect(() => {
      if (!project || !project._centre || !images.fg) return;
      dirty.current = true;
      // one key for the orbit point (it holds from there), on the first keyframe
      setProject((p) => {
        const first = p.keyframes.slice().sort((a, b) => a.t - b.t)[0];
        const o = personOrbit(R().cameraAt(p.keyframes, first ? first.t : 0, p.smooth).framing);
        const keyframes = first
          ? p.keyframes.map((k) => (k === first ? { ...k, orbitX: o.u, orbitY: o.v } : k))
          : [{ id: newId(), t: 0, orbitX: o.u, orbitY: o.v, ease: "inout" }];
        return { ...p, _centre: false, keyframes };
      });
    }, [project && project._centre, images.fg]);

    // fonts used by captions
    const fontKey = project ? project.captions.map((c) => c.font).join(",") : "";
    const [fontsReady, setFontsReady] = React.useState(0);
    React.useEffect(() => {
      Promise.all([...new Set(fontKey.split(",").filter(Boolean))].map((f) => R().loadFont(f))).then(() => setFontsReady((n) => n + 1));
    }, [fontKey]);

    const [W, H] = project ? SIZES[project.size] || SIZES["1080p"] : [1920, 1080];
    const cover = React.useMemo(() => {
      if (!project || !images.bg) return { c: 1, cb: 1 };
      return R().coverFactor(project.keyframes, project.length, images.fg.naturalWidth, images.fg.naturalHeight, W, H,
        { fgEdges: images.fgEdges, pad: images.pad, smooth: project.smooth });
    }, [project && project.keyframes, project && project.length, project && project.smooth, images.bg, W, H]);

    const coverRef = React.useRef(cover);
    coverRef.current = cover;

    // undo/redo keep project snapshots; changes less than 500 ms apart (a slider
    // drag, a keyframe drag) count as one step
    const undoStack = React.useRef([]);
    const redoStack = React.useRef([]);
    const lastChange = React.useRef(0);
    const [, setHistoryTick] = React.useState(0);

    // autosave
    function change(fn) {
      const now = Date.now();
      if (now - lastChange.current > 500 && projectRef.current) {
        undoStack.current.push(projectRef.current);
        if (undoStack.current.length > 200) undoStack.current.shift();
        redoStack.current = [];
        setHistoryTick((n) => n + 1);
      }
      lastChange.current = now;
      dirty.current = true;
      setSaved("unsaved");
      setProject((p) => fn(p));
    }

    function undo(redo) {
      const from = redo ? redoStack : undoStack;
      const to = redo ? undoStack : redoStack;
      const snap = from.current.pop();
      if (!snap) return;
      to.current.push(projectRef.current);
      lastChange.current = 0;
      dirty.current = true;
      setSaved("unsaved");
      setProject({ ...snap, export: projectRef.current.export });
      setHistoryTick((n) => n + 1);
    }

    // save what's pending, then copy this project as a new version and open it
    async function newVersion() {
      try {
        const { _centre, ...body } = projectRef.current;
        await api(`project/${pid}`, body);
        dirty.current = false;
        const res = await api(`project/${pid}/duplicate`, {});
        history.push(`/parallax/${res.project.id}`);
      } catch (e) {
        setError(e.message);
      }
    }

    // the selected caption or keyframe, or the keyframe at the playhead
    function deleteSelected() {
      const sc = selection.caption && projectRef.current.captions.find((c) => c.id === selection.caption);
      if (sc && selection.ckf && selection.ckey && (sc.keyframes || []).some((k) => k.id === selection.ckf)) {
        // a value lane's diamond: just that value's key
        updateCap(sc.id, (c) => ({
          ...c,
          keyframes: c.keyframes.flatMap((x) => {
            if (x.id !== selection.ckf) return [x];
            const { [selection.ckey]: gone, ...rest } = x;
            return Object.keys(rest).some((y) => !["id", "t", "ease", "bez"].includes(y)) ? [rest] : [];
          }),
        }));
        setSelection({ type: "caption", caption: sc.id });
      } else if (sc && selection.ckf && (sc.keyframes || []).some((k) => k.id === selection.ckf)) deleteCapKf(sc.id, selection.ckf);
      else if (sc) removeCaption(sc.id);
      else if (selection.kf && selection.key && projectRef.current.keyframes.some((k) => k.id === selection.kf)) {
        // a camera value lane's diamond: just that value's key
        change((p) => ({
          ...p,
          keyframes: p.keyframes.flatMap((x) => {
            if (x.id !== selection.kf) return [x];
            const { [selection.key]: gone, ...rest } = x;
            return Object.keys(rest).some((y) => !KF_META.includes(y)) ? [rest] : [];
          }),
        }));
        setSelection({ type: "camera" });
      } else if (selection.kf && projectRef.current.keyframes.some((k) => k.id === selection.kf)) deleteKf(selection.kf);
      else if (kfAt) deleteKf(kfAt.id);
    }
    const commit = React.useCallback(() => {}, []);

    function thumbnail() {
      const c = document.createElement("canvas");
      c.width = 320;
      c.height = Math.round((320 * H) / W);
      const ctx = c.getContext("2d");
      ctx.scale(c.width / W, c.height / H);
      R().drawFrame(ctx, projectRef.current, images, Math.min(1, projectRef.current.length / 3), W, H, cover);
      return c.toDataURL("image/jpeg", 0.8);
    }

    React.useEffect(() => {
      if (!project || !dirty.current) return;
      const t = setTimeout(() => {
        dirty.current = false;
        setSaved("saving");
        const { _centre, ...body } = project;
        if (images.bg) body.thumb = thumbnail();
        api(`project/${pid}`, body).then(() => setSaved((s) => (s === "saving" ? "saved" : s)), (e) => setSaved("error: " + e.message));
      }, SAVE_DELAY);
      return () => clearTimeout(t);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [project]);

    // preview rendering: the canvas matches the export aspect at screen resolution
    const [box, setBox] = React.useState({ w: 640, h: 360 });
    React.useEffect(() => {
      const el = stageRef.current;
      if (!el) return;
      const ro = new ResizeObserver(() => {
        const r = el.getBoundingClientRect();
        const s = Math.min(r.width / W, r.height / H);
        setBox({ w: Math.max(1, Math.floor(W * s)), h: Math.max(1, Math.floor(H * s)), sw: r.width, sh: r.height });
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, [W, H, !!project]);

    const draw = React.useCallback((t) => {
      const canvas = canvasRef.current;
      if (!canvas || !projectRef.current) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cw = Math.round(box.w * dpr);
      const ch = Math.round(box.h * dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(cw / W, 0, 0, ch / H, 0, 0);
      const p = playing ? projectRef.current : withPending(projectRef.current, t, pendingRef.current);
      R().drawFrame(ctx, p, images, t, W, H, cover);
    }, [box, images, cover, W, H, playing, pending]);

    React.useEffect(() => draw(time), [draw, time, project, fontsReady]);

    const direction = React.useRef(1); // boomerang playback runs backwards on the way back
    React.useEffect(() => {
      if (!playing) return;
      let raf;
      let last = performance.now();
      const loop = (now) => {
        const L = projectRef.current.length;
        const boomerang = projectRef.current.boomerang;
        setTime((t) => {
          let n = t + direction.current * ((now - last) / 1000);
          if (!boomerang) {
            direction.current = 1;
            if (n > L) n = 0; // loop
          } else if (n > L) {
            n = 2 * L - n; // turn round at the end...
            direction.current = -1;
          } else if (n < 0) {
            n = -n; // ...and at the start
            direction.current = 1;
          }
          return Math.max(0, Math.min(L, n));
        });
        last = now;
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      return () => cancelAnimationFrame(raf);
    }, [playing]);

    // full screen preview (F): the stage fills the screen; its ResizeObserver refits the canvas
    function toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (stageRef.current && stageRef.current.requestFullscreen) stageRef.current.requestFullscreen();
    }

    // keyframe helpers
    const fps = project ? project.fps : 30;
    const kfAt = project && project.keyframes.find((k) => Math.abs(k.t - time) < 0.5 / fps);
    function setParam(key, value) {
      setParams({ [key]: value });
    }
    function setParams(values) {
      setPlaying(false);
      setPending((pd) => {
        if (!pd) return pd;
        const rest = Object.fromEntries(Object.entries(pd).filter(([k]) => !(k in values)));
        return Object.keys(rest).length ? rest : null;
      });
      change((p) => {
        const at = p.keyframes.find((k) => Math.abs(k.t - time) < 0.5 / p.fps);
        if (at) return { ...p, keyframes: p.keyframes.map((k) => (k === at ? { ...k, ...values } : k)) };
        // a key for just these values
        const kf = { id: newId(), t: Math.round(time * p.fps) / p.fps, ...values, ease: "inout" };
        setSelection({ type: "camera", kf: kf.id });
        return { ...p, keyframes: [...p.keyframes, kf] };
      });
    }
    // the diamond: remove this value's key at the playhead, or key it there
    const KF_META = ["id", "t", "ease", "bez"];
    function toggleKey(key) {
      const at = kfAt && kfAt[key] != null ? kfAt : null;
      if (!at) return setParams({ [key]: pending && pending[key] != null ? pending[key] : R().cameraAt(project.keyframes, time, project.smooth)[key] });
      change((p) => ({
        ...p,
        keyframes: p.keyframes.flatMap((k) => {
          if (k.id !== at.id) return [k];
          const { [key]: gone, ...rest } = k;
          // a keyframe left with no values goes too
          return Object.keys(rest).some((x) => !KF_META.includes(x)) ? [rest] : [];
        }),
      }));
    }
    // "+ Keyframe" pins the values that are animated (keyed at different numbers) at what
    // they are now; with nothing animated yet, the fallback values. Others are keyed by
    // changing them.
    const cameraGroup = R().PARAM_KEYS.filter((k) => (R().PARAMS[k].group || "camera") === "camera");
    function keyedNow(kfs, params, fallback, at, t) {
      const keyed = Object.keys(params).filter((k) => new Set((kfs || []).filter((x) => x[k] != null).map((x) => x[k])).size > 1);
      const v = at(t);
      return Object.fromEntries((keyed.length ? keyed : fallback).map((k) => [k, v[k]]));
    }
    function addKf() {
      if (kfAt) return setSelection({ type: "camera", kf: kfAt.id });
      const kf = { id: newId(), t: Math.round(time * fps) / fps, ...keyedNow(project.keyframes, R().PARAMS, cameraGroup, (t) => R().cameraAt(project.keyframes, t, project.smooth), time), ease: "inout" };
      setSelection({ type: "camera", kf: kf.id });
      change((p) => ({ ...p, keyframes: [...p.keyframes, kf] }));
    }
    function deleteKf(id) {
      change((p) => ({ ...p, keyframes: p.keyframes.filter((k) => k.id !== id) }));
      setSelection({ type: "camera" });
    }
    function addCaption() {
      const c = newCaption(time, project.length);
      change((p) => ({ ...p, captions: [...p.captions, c] }));
      setSelection({ type: "caption", caption: c.id });
    }
    function updateCaption(id, patch) {
      change((p) => ({ ...p, captions: p.captions.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
    }
    // caption keyframes: times are relative to the caption's start
    const capKfAt = (cap) => cap && (cap.keyframes || []).find((k) => Math.abs(cap.start + k.t - time) < 0.5 / fps);
    function updateCap(id, fn) {
      change((p) => ({ ...p, captions: p.captions.map((c) => (c.id === id ? fn(c) : c)) }));
    }
    function setCapParam(id, key, value) {
      setPlaying(false);
      updateCap(id, (c) => {
        if (time < c.start || time > c.end) return c;
        const at = (c.keyframes || []).find((k) => Math.abs(c.start + k.t - time) < 0.5 / fps);
        if (at) return { ...c, keyframes: c.keyframes.map((k) => (k === at ? { ...k, [key]: value } : k)) };
        const kf = { id: newId(), t: Math.round((time - c.start) * fps) / fps, [key]: value, ease: "inout" };
        setSelection({ type: "caption", caption: id, ckf: kf.id });
        return { ...c, keyframes: [...(c.keyframes || []), kf] };
      });
    }
    function addCapKf(id) {
      const c = projectRef.current.captions.find((x) => x.id === id);
      if (!c || time < c.start || time > c.end) return;
      const at = capKfAt(c);
      if (at) return setSelection({ type: "caption", caption: id, ckf: at.id });
      const kf = { id: newId(), t: Math.round((time - c.start) * fps) / fps, ...keyedNow(c.keyframes, R().CAPTION_PARAMS, R().CAPTION_KEYS, (t) => R().captionAt(c, t), time), ease: "inout" };
      setSelection({ type: "caption", caption: id, ckf: kf.id });
      updateCap(id, (x) => ({ ...x, keyframes: [...(x.keyframes || []), kf] }));
    }
    function deleteCapKf(id, kid) {
      updateCap(id, (c) => ({ ...c, keyframes: c.keyframes.filter((k) => k.id !== kid) }));
      setSelection({ type: "caption", caption: id });
    }

    function removeCaption(id) {
      change((p) => ({ ...p, captions: p.captions.filter((c) => c.id !== id) }));
      setSelection({ type: "camera" });
    }
    function setLength(len) {
      change((p) => {
        const f = len / p.length;
        return {
          ...p,
          length: len,
          keyframes: p.keyframes.map((k) => ({ ...k, t: Math.round(k.t * f * p.fps) / p.fps })),
          captions: p.captions.map((c) => ({
            ...c, start: c.start * f, end: c.end * f, keyframes: (c.keyframes || []).map((k) => ({ ...k, t: k.t * f })),
          })),
        };
      });
      setTime((t) => Math.min(t, len));
    }

    // ---- preview mouse controls: click sets the orbit point, drag orbits the camera,
    // Shift+drag slides it, the wheel dollies (view changes, keyed only by "Key changes")
    function setView(values) {
      setPlaying(false);
      setPending((pd) => ({ ...(pd || {}), ...values }));
    }
    const viewCam = () => {
      const p = withPending(projectRef.current, time, pendingRef.current);
      return R().cameraAt(p.keyframes, time, p.smooth);
    };
    function keyChanges() {
      if (pendingRef.current) setParams(pendingRef.current);
      setPending(null);
    }
    // drag the orbit point's cross: it follows the pointer at its current depth
    function orbitPointerDown(e) {
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
      setPlaying(false);
      const move = (ev) => {
        const pt = previewPoint(ev);
        const picked = R().pickOrbit(viewCam(), W, H, coverRef.current.c, pt.x, pt.y);
        if (picked) setView({ orbitX: picked.u, orbitY: picked.v });
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    }

    function previewPoint(e) {
      const r = canvasRef.current.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width - 0.5) * W, y: ((e.clientY - r.top) / r.height - 0.5) * H, scale: W / r.width };
    }
    function previewPointerDown(e) {
      if (!projectRef.current || !images.bg) return;
      e.preventDefault();
      const el = e.currentTarget;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
      setPlaying(false);
      const start = { x: e.clientX, y: e.clientY };
      const cam0 = viewCam();
      const P = R().PARAMS;
      const clamp = (k, v) => Math.max(P[k].min, Math.min(P[k].max, v));
      let moved = false;
      const move = (ev) => {
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        if (ev.shiftKey) {
          const r = canvasRef.current.getBoundingClientRect();
          setView({ panX: clamp("panX", cam0.panX - ((dx / r.width) / 0.12) / cam0.zoom),
                      panY: clamp("panY", cam0.panY - ((dy / r.height) / 0.12) / cam0.zoom) });
        } else {
          setView({ turn: clamp("turn", cam0.turn + dx * 0.12), tilt: clamp("tilt", cam0.tilt - dy * 0.12) });
        }
      };
      const up = (ev) => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        if (moved) return;
        const pt = previewPoint(ev);
        const picked = R().pickOrbit(viewCam(), W, H, cover.c, pt.x, pt.y);
        if (picked) setView({ orbitX: picked.u, orbitY: picked.v });
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    }
    function previewWheel(e) {
      if (!projectRef.current) return;
      const cam = viewCam();
      const P = R().PARAMS.zoom;
      setView({ zoom: Math.max(P.min, Math.min(P.max, cam.zoom * Math.exp(-e.deltaY * 0.001))) });
    }
    // the orbit point marker, in CSS pixels over the canvas
    let orbitMarker = null;
    if (project && images.bg && !playing && !exporting) {
      const vp = withPending(project, time, pending);
      const s = R().orbitOnScreen(R().cameraAt(vp.keyframes, time, project.smooth), W, H);
      if (s) {
        const left = (s.x * cover.c) / W * box.w + box.w / 2;
        const top = (s.y * cover.c) / H * box.h + box.h / 2;
        // the canvas is centred in the stage
        if (box.sw && left >= 0 && left <= box.w && top >= 0 && top <= box.h) {
          orbitMarker = { left: (box.sw - box.w) / 2 + left, top: (box.sh - box.h) / 2 + top };
        }
      }
    }

    // keyboard
    React.useEffect(() => {
      function onKey(e) {
        if (!projectRef.current || exporting) return;
        if (e.target.matches && e.target.matches("input, select, textarea")) return;
        const step = 1 / projectRef.current.fps;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); undo(e.shiftKey); }
        else if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); undo(true); }
        else if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); }
        else if ((e.key === "k" || e.key === "K") && pendingRef.current) keyChanges();
        else if (e.key === "Escape" && pendingRef.current) setPending(null);
        else if (e.key === "k" || e.key === "K") {
          const sc = selection.caption && projectRef.current.captions.find((c) => c.id === selection.caption);
          if (sc && time >= sc.start && time <= sc.end) addCapKf(sc.id);
          else addKf();
        }
        else if (e.key === "ArrowRight") { setPlaying(false); setTime((t) => Math.min(projectRef.current.length, t + step)); }
        else if (e.key === "ArrowLeft") { setPlaying(false); setTime((t) => Math.max(0, t - step)); }
        else if (e.key === "Home") { setPlaying(false); setTime(0); }
        else if (e.key === "f" || e.key === "F") toggleFullscreen();
        else if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
        else return;
        e.stopPropagation();
      }
      window.addEventListener("keydown", onKey, true);
      return () => window.removeEventListener("keydown", onKey, true);
    });

    // export: render every frame with the same renderer and stream JPEGs to ffmpeg
    async function exportVideo() {
      const p = projectRef.current;
      const forward = Math.max(1, Math.round(p.length * p.fps));
      const frames = p.boomerang ? 2 * forward - 1 : forward;
      // the project's time for output frame i
      const timeOf = (i) => (i < forward ? i / p.fps : (2 * (forward - 1) - i) / p.fps);
      const state = { cancelled: false, done: 0, frames, stage: "Preparing" };
      exportState.current = state;
      setExporting({ ...state });
      setPlaying(false);
      // shared with the Queues page's Renders tab
      const render = {
        id: newId(), pid, title: p.title, size: `${W}×${H}`, fps: p.fps, frames, done: 0, stage: "Preparing",
        boomerang: !!p.boomerang, started: Date.now(),
      };
      const report = (patch) => {
        Object.assign(render, patch);
        const secs = (Date.now() - render.started) / 1000;
        if (render.done > 0 && render.stage === "Rendering") {
          render.rate = render.done / secs;
          render.eta = (render.frames - render.done) / render.rate;
        }
        publishRender(render);
      };
      report({});
      try {
        await Promise.all(p.captions.map((c) => R().loadFont(c.font)));
        const { _centre, ...saveBody } = p;
        await api(`project/${pid}`, { ...saveBody, thumb: thumbnail() });
        await api(`export/${pid}/start`, { width: W, height: H, fps: p.fps, frames });
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext("2d");
        let batch = [];
        const flush = async () => {
          if (!batch.length) return;
          await api(`export/${pid}/frames`, new Blob(batch), true);
          batch = [];
        };
        for (let i = 0; i < frames; i++) {
          if (renderCancels.has(render.id)) state.cancelled = true;
          if (state.cancelled) throw new Error("cancelled");
          R().drawFrame(ctx, p, images, timeOf(i), W, H, cover);
          batch.push(await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.93)));
          if (batch.length >= FRAME_BATCH) await flush();
          state.done = i + 1;
          state.stage = "Rendering";
          setExporting({ ...state });
          if (i % 5 === 4 || i === frames - 1) report({ done: i + 1, stage: "Rendering" });
        }
        await flush();
        state.stage = "Encoding and importing into Stash";
        setExporting({ ...state });
        report({ stage: "Encoding and importing into Stash", eta: null });
        const info = await api(`export/${pid}/finish`, {});
        setProject((x) => ({ ...x, export: info }));
        setExporting({ ...state, stage: "done", info });
        report({ stage: "done", scene: info.scene_id, finished: Date.now() });
      } catch (e) {
        api(`export/${pid}/cancel`, {}).catch(() => {});
        const cancelled = e.message === "cancelled";
        setExporting({ ...state, stage: cancelled ? "cancelled" : "error", error: e.message });
        report({ stage: cancelled ? "cancelled" : "error", error: cancelled ? null : e.message, finished: Date.now() });
      }
      renderCancels.delete(render.id);
      exportState.current = null;
    }

    if (error) return h("div", { className: "pxs-list" }, h("div", { className: "pxs-warning" }, error), h(Link, { to: "/parallax" }, "← Projects"));
    if (!project) return h("div", { className: "pxs-list" }, "Loading…");

    const selCaption = selection.caption && project.captions.find((c) => c.id === selection.caption);
    const cutLabel = cut ? `${cut.meta.model === "general" ? "Anything" : "People"} cut · ${cut.meta.fill}` : "no layers yet";
    const generating = !cut;

    return h(
      "div",
      { className: "pxs-studio" },
      h(
        "div",
        { className: "pxs-toolbar" },
        h(Link, { to: "/parallax", className: "pxs-back" }, "← Projects"),
        h("input", {
          className: "pxs-title", value: project.title || "",
          onChange: (e) => { const v = e.target.value; change((p) => ({ ...p, title: v })); },
        }),
        h("span", { className: "pxs-muted pxs-small" }, saved === "saved" ? "Saved" : saved === "saving" ? "Saving…" : saved === "unsaved" ? "Unsaved" : saved),
        versions.length > 1 && h("select", {
          value: pid, title: "Versions of this still",
          onChange: (e) => history.push(`/parallax/${e.target.value}`),
        }, versions.map((v, i) => h("option", { key: v.id, value: v.id }, `Version ${i + 1}: ${v.title}`))),
        h("button", { className: "pxs-button", onClick: newVersion, title: "Copy this project as another version of the same still" }, "+ New version"),
        h("button", { className: "pxs-button", disabled: !undoStack.current.length, onClick: () => undo(false), title: "Undo (Ctrl+Z)" }, "\u21B6 Undo"),
        h("button", { className: "pxs-button", disabled: !redoStack.current.length, onClick: () => undo(true), title: "Redo (Ctrl+Shift+Z)" }, "\u21B7 Redo"),
        h("button", {
          className: "pxs-button",
          disabled: !(selCaption || kfAt || (selection.kf && project.keyframes.some((k) => k.id === selection.kf))),
          onClick: deleteSelected,
          title: "Delete the selected caption or keyframe (Delete)",
        }, "Delete"),
        h("button", {
          className: "pxs-button" + (confirmReset ? " pxs-warn" : ""),
          title: "Start this project over: default length, size, frame rate and keyframes, and no captions. " +
            "The title, cut-out layers and exported scene are kept; Undo brings everything back.",
          onClick: () => {
            if (!confirmReset) return setConfirmReset(true);
            setConfirmReset(false);
            change((p) => ({
              ...p, length: 6, size: "1080p", fps: 30, keyframes: defaultKeyframes(6, !!(p.source && p.source.span)), captions: [], smooth: {}, boomerang: false, _centre: true,
            }));
            setSelection({ type: "camera" });
            setPlaying(false);
            setTime(0);
          },
          onBlur: () => setConfirmReset(false),
        }, confirmReset ? "Click again to reset everything" : "\u27F2 Reset project"),
        h("span", { className: "pxs-spacer" }),
        h("label", { className: "pxs-small" }, "Length ",
          h("select", { value: project.length, onChange: (e) => setLength(Number(e.target.value)) },
            [3, 4, 5, 6, 8, 10, 12, 15, 20, 30].map((s) => h("option", { key: s, value: s }, `${s} s`)))),
        h("label", { className: "pxs-small" }, "Size ",
          h("select", { value: project.size, onChange: (e) => { const v = e.target.value; change((p) => ({ ...p, size: v })); } },
            Object.keys(SIZES).map((s) => h("option", { key: s, value: s }, s)))),
        h("label", { className: "pxs-check pxs-small", title: "Play the clip forward, then backward (the export is twice as long)" },
          h("input", { type: "checkbox", checked: !!project.boomerang, onChange: (e) => { const v = e.target.checked; change((p) => ({ ...p, boomerang: v })); } }),
          " Boomerang"),
        h("label", { className: "pxs-small" }, "FPS ",
          h("select", { value: project.fps, onChange: (e) => { const v = Number(e.target.value); change((p) => ({ ...p, fps: v })); } },
            [24, 25, 30, 50, 60].map((s) => h("option", { key: s, value: s }, s)))),
        project.export && project.export.scene_id &&
          h(Link, { to: `/scenes/${project.export.scene_id}`, className: "pxs-small" }, "Exported scene"),
        h("button", { className: "pxs-button pxs-primary", disabled: !images.bg || !!(exporting && !["done", "error", "cancelled"].includes(exporting.stage)), onClick: exportVideo },
          project.export ? "Re-export" : "Export"),
        h("button", {
          className: "pxs-link pxs-danger",
          title: "Delete this project (layers and any exported scene are kept)",
          onClick: () => {
            if (!confirmDelete) return setConfirmDelete(true);
            api(`project/${pid}/delete`, {}).then(() => history.push("/parallax"), (e) => setError(e.message));
          },
          onBlur: () => setConfirmDelete(false),
        }, confirmDelete ? "Click again to delete project" : "Delete project")
      ),
      h(MediaBin, { project, cuts, cut, urls, status, job, onUseCut: useCut, onRecut: recut }),
      h(
        "div",
        { className: "pxs-stage", ref: stageRef },
        h("canvas", {
          ref: canvasRef, style: { width: box.w, height: box.h },
          className: "pxs-canvas", onPointerDown: previewPointerDown, onWheel: previewWheel,
          title: "Click: set the orbit point. Drag: orbit. Shift+drag: slide. Wheel: dolly. Then Key changes (K) keys them.",
        }),
        pending && !playing && h("div", { className: "pxs-pending-bar" },
          h("span", null, "View changed (not keyed): ", Object.keys(pending).map((k) => R().PARAMS[k].label).join(", ")),
          h("button", { className: "pxs-button pxs-primary", onClick: keyChanges, title: "Key these values at the playhead (K)" }, "\u25C6 Key changes"),
          h("button", { className: "pxs-button", onClick: () => setPending(null), title: "Back to the keyed view (Esc)" }, "Discard")),
        orbitMarker && h("div", {
          className: "pxs-orbit", style: { left: orbitMarker.left, top: orbitMarker.top },
          onPointerDown: orbitPointerDown, title: "Drag to move the orbit point",
        }),
        extending && h("div", { className: "pxs-note" },
          extending.state === "error" ? `Couldn't extend the background: ${extending.error}`
            : `Extending the background past the photo's edges… ${Math.round((extending.progress || 0) * 100)}%`),
        generating && h("div", { className: "pxs-overlay" },
          job && job.state === "error" ? h("div", { className: "pxs-warning" }, job.error)
            : h(React.Fragment, null,
              h("div", null, job ? `${job.stage[0].toUpperCase()}${job.stage.slice(1)}…` : "Waiting for the layers…"),
              h("div", { className: "pxs-progress" }, h("i", { style: { width: `${Math.round((job?.progress || 0) * 100)}%` } })),
              h("div", { className: "pxs-muted pxs-small" }, project.source.span
                ? "Bullet time: cutting out the person in every frame and building one background takes about 40 seconds " +
                  "(about 2½ minutes with AI in-between frames)."
                : "Cutting out the person and filling the background takes about 15 seconds.")))
      ),
      h(
        "div",
        { className: "pxs-inspector" },
        selCaption
          ? h(CaptionInspector, {
              cap: selCaption, length: project.length, time, kfAt: capKfAt(selCaption),
              update: (patch) => updateCaption(selCaption.id, patch),
              remove: () => removeCaption(selCaption.id),
              onParam: (k, v) => setCapParam(selCaption.id, k, v),
              fps, setTime: (t) => { setPlaying(false); setTime(t); },
              onToggleKey: (k) => {
                const at = capKfAt(selCaption);
                if (!at || at[k] == null) return setCapParam(selCaption.id, k, R().captionAt(selCaption, time)[k]);
                updateCap(selCaption.id, (c) => ({
                  ...c,
                  keyframes: c.keyframes.flatMap((x) => {
                    if (x.id !== at.id) return [x];
                    const { [k]: gone, ...rest } = x;
                    return Object.keys(rest).some((y) => !["id", "t", "ease", "bez"].includes(y)) ? [rest] : [];
                  }),
                }));
              },
              onAddKf: () => addCapKf(selCaption.id),
              onDeleteKf: () => { const k = capKfAt(selCaption); if (k) deleteCapKf(selCaption.id, k.id); },
              onEase: (ease) => { const at = capKfAt(selCaption); updateCap(selCaption.id, (c) => ({ ...c, keyframes: c.keyframes.map((k) => (k.id === at.id ? withEase(k, ease) : k)) })); },
            })
          : h(CameraInspector, {
              project, time, fps, cover, kfAt, bullet: images.fgSeq ? images.fgSeq.length : 0,
              pending, viewKeyframes: pending ? withPending(project, time, pending).keyframes : null,
              onParam: setParam, onCommit: commit, onAddKf: addKf, onToggleKey: toggleKey, setTime: (t) => { setPlaying(false); setTime(t); },
              onCentre: () => {
                if (!images.fg) return;
                const o = personOrbit(R().cameraAt(project.keyframes, time, project.smooth).framing);
                setParams({ orbitX: o.u, orbitY: o.v, orbitZ: 0 });
              },
              onDeleteKf: () => kfAt && deleteKf(kfAt.id),
              onEase: (ease) => change((p) => ({ ...p, keyframes: p.keyframes.map((k) => (k.id === kfAt.id ? withEase(k, ease) : k)) })),
            }),
        selCaption && h("button", { className: "pxs-link", onClick: () => setSelection({ type: "camera" }) }, "← Camera")
      ),
      h(Timeline, {
        project, time, setTime, fps, playing, setPlaying, selection, setSelection, change, commit, addCaption, addKf, cutLabel,
        onFullscreen: toggleFullscreen,
      }),
      exporting && h(
        "div",
        { className: "pxs-export" },
        h("h5", null, "Export"),
        exporting.stage === "done"
          ? h(React.Fragment, null,
              h("p", null, "Imported into Stash and tagged Parallax."),
              h(Link, { to: `/scenes/${exporting.info.scene_id}`, className: "pxs-button pxs-primary" }, "Open scene"))
          : exporting.stage === "error" || exporting.stage === "cancelled"
            ? h("p", { className: "pxs-warning" }, exporting.stage === "cancelled" ? "Export cancelled." : exporting.error)
            : h(React.Fragment, null,
                h("p", null, `${exporting.stage}… ${exporting.done} / ${exporting.frames} frames`),
                h("div", { className: "pxs-progress" }, h("i", { style: { width: `${Math.round((exporting.done / exporting.frames) * 100)}%` } })),
                h("button", { className: "pxs-link", onClick: () => { if (exportState.current) exportState.current.cancelled = true; } }, "Cancel")),
        ["done", "error", "cancelled"].includes(exporting.stage) && h("button", { className: "pxs-link", onClick: () => setExporting(null) }, "Close")
      )
    );
  }

  function ParallaxRoute() {
    const location = useLocation();
    const m = /^\/parallax\/([a-f0-9]{12})/.exec(location.pathname);
    if (m) return h(Studio, { pid: m[1], key: m[1] });
    if (/^\/parallax\/new/.test(location.pathname)) return h(NewProject, { key: location.search });
    return h(ProjectList);
  }

  window.PluginApi.register.route("/parallax", ParallaxRoute);
})();
