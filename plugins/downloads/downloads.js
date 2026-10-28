// "Queues" page (/queues; /downloader still works) with a tab per queue: Downloads (every
// downloader job with live progress), Interpolation and Upscaling (the AI jobs from the
// Parallax plugin's scene, image and gallery buttons), Renders (Parallax exports, which
// render in the browser) and Parallax (projects and exports).
(function () {
  const { React, GQL, libraries } = window.PluginApi;
  const { Link } = libraries.ReactRouterDOM;
  const { FontAwesomeIcon } = libraries.ReactFontAwesome;
  const { faTrash, faListUl } = libraries.FontAwesomeSolid;
  const { Nav, Button } = libraries.Bootstrap;
  const h = React.createElement;

  const POLL_MS = 2000;
  // the queue sits right under the active downloads, front of the queue first
  const ORDER = ["downloading", "queued", "expired", "awaiting_file", "failed", "done"];
  const LABELS = {
    downloading: "Downloading",
    expired: "Waiting for a fresh link",
    awaiting_file: "Waiting for browser download",
    queued: "Queued",
    failed: "Failed",
    done: "Done",
  };

  function usePluginSettings() {
    const { data } = GQL.useConfigurationQuery();
    const cfg = (data && data.configuration.plugins && data.configuration.plugins.downloads) || {};
    const base = (cfg.downloader_url || `${location.protocol}//${location.hostname}:10141`).replace(/\/$/, "");
    return { base, token: cfg.token || "" };
  }

  function timeAgo(secs) {
    if (!secs) return "";
    const d = Date.now() / 1000 - secs;
    if (d < 60) return "just now";
    if (d < 3600) return `${Math.floor(d / 60)} min ago`;
    if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
    return new Date(secs * 1000).toLocaleDateString();
  }

  function itemTitle(it) {
    const code =
      it.season != null && it.episode != null
        ? `S${String(it.season).padStart(2, "0")}E${String(it.episode).padStart(2, "0")} `
        : "";
    return (it.show ? `${it.show} · ` : "") + code + (it.title || it.url);
  }

  const itemKey = (it) => it.kind + " " + it.url;

  // trash icon; the first click arms it ("Delete?"), a second click within 3 s deletes
  // "Cancel all" for a queue tab: two clicks, so one stray click can't empty a queue
  function CancelAllButton({ count, what, onConfirm }) {
    const [armed, setArmed] = React.useState(false);
    if (!count) return null;
    return h("button", {
      className: "dl-cancel-all" + (armed ? " armed" : ""),
      onBlur: () => setArmed(false),
      onClick: () => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      },
      title: `Cancel ${count} ${what}`,
    }, armed ? `Click again to cancel all ${count}` : `Cancel all (${count})`);
  }

  function DeleteButton({ it, onDelete }) {
    const [armed, setArmed] = React.useState(false);
    React.useEffect(() => {
      if (!armed) return;
      const t = setTimeout(() => setArmed(false), 3000);
      return () => clearTimeout(t);
    }, [armed]);
    const title =
      it.status === "downloading"
        ? "Cancel this download and remove it"
        : it.status === "done"
        ? "Remove from this list (the video stays in Stash)"
        : "Remove from the queue";
    return h(
      Button,
      {
        size: "sm",
        variant: armed ? "danger" : "secondary",
        className: "dl-delete" + (armed ? " armed" : ""),
        title,
        onClick: () => (armed ? onDelete(it) : setArmed(true)),
      },
      armed ? "Delete?" : h(FontAwesomeIcon, { icon: faTrash })
    );
  }

  function Item({ it, drag, onTop, onDelete }) {
    const pct = Math.round((it.progress || 0) * 100);
    const stashLink =
      it.stash_id && h(Link, { to: `/${it.kind === "gallery" ? "galleries" : "scenes"}/${it.stash_id}` }, "Open in Stash");
    const key = itemKey(it);
    const cls =
      `dl-item dl-${it.status}` +
      (drag && drag.state && drag.state.key === key ? " dl-dragging" : "") +
      (drag && drag.state && drag.state.before === key ? " dl-drop-before" : "");
    return h(
      "div",
      { className: cls, "data-key": key },
      h(
        "div",
        { className: "dl-item-head" },
        drag &&
          h(
            "span",
            { className: "dl-handle", title: "Drag to reorder the queue", onPointerDown: (e) => drag.start(e, it) },
            "\u2807\u2807"
          ),
        h("span", { className: "dl-site" }, it.site),
        h("span", { className: "dl-kind" }, it.kind),
        h("a", { className: "dl-title", href: it.url, target: "_blank", rel: "noopener" }, itemTitle(it)),
        it.status === "queued" && it.position && h("span", { className: "dl-pos" }, `#${it.position}`),
        onTop &&
          h(
            Button,
            {
              size: "sm",
              variant: "secondary",
              className: "dl-top",
              title: "Move to the top of the queue",
              onClick: () => onTop(it),
            },
            "\u2191 Top"
          ),
        onDelete && !it.cancel && h(DeleteButton, { it, onDelete }),
        h("span", { className: "dl-when" }, timeAgo(it.updated || it.added))
      ),
      it.status === "downloading" &&
        h(
          "div",
          { className: "dl-bar" },
          h("div", { className: "dl-bar-fill" + (!it.progress ? " indeterminate" : ""), style: { width: `${it.progress ? pct : 100}%` } })
        ),
      h(
        "div",
        { className: "dl-item-foot" },
        it.status === "downloading" && h("span", null, it.progress ? `${pct}%` : "downloading…"),
        it.error && h("span", { className: "dl-error" }, it.error),
        stashLink,
        it.status === "done" && !it.stash_id && it.path && h("span", { className: "dl-path" }, it.path)
      )
    );
  }

  function DownloadsPage() {
    const { base, token } = usePluginSettings();
    const [state, setState] = React.useState({ loading: true });
    const [filter, setFilter] = React.useState("all");
    // drag = { key, before } while a queued item is being dragged; before is the key of the
    // item it will be dropped in front of, or null for the end of the queue
    const [drag, setDrag] = React.useState(null);
    const dragRef = React.useRef(null);
    const queueRef = React.useRef(null);

    const load = React.useCallback(() => {
      fetch(`${base}/status?all=1`)
        .then((r) => r.json())
        .then((d) => dragRef.current || setState({ data: d }))
        .catch((e) => setState({ error: `Can't reach the downloader at ${base}: ${e.message}` }));
    }, [base]);

    React.useEffect(() => {
      load();
      const t = setInterval(load, POLL_MS);
      return () => clearInterval(t);
    }, [load]);

    const retry = () =>
      fetch(`${base}/retry`, { method: "POST", headers: { "X-Token": token } }).then((r) => {
        if (r.status === 403) alert("Set the downloader token in Settings → Plugins → Downloads to retry.");
        load();
      });

    const data = state.data;
    const items = (data && data.items) || [];
    const queue = items.filter((i) => i.status === "queued").sort((a, b) => (a.position || 0) - (b.position || 0));

    const remove = (it) => {
      // hide it straight away; a running download disappears once its worker has stopped
      setState({ data: { ...data, items: items.filter((i) => i !== it) } });
      fetch(`${base}/delete`, {
        method: "POST",
        headers: { "X-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: it.kind, url: it.url }),
      }).then((r) => {
        if (r.status === 403) alert("Set the downloader token in Settings → Plugins → Downloads to delete downloads.");
        load();
      });
    };

    // every download not finished yet: the queue first (so nothing starts in the
    // meantime), then the running ones; done and failed items stay
    const UNFINISHED = ["queued", "expired", "awaiting_file", "downloading"];
    const unfinished = items.filter((i) => UNFINISHED.includes(i.status))
      .sort((a, b) => UNFINISHED.indexOf(a.status) - UNFINISHED.indexOf(b.status));
    const cancelAll = async () => {
      setState({ data: { ...data, items: items.filter((i) => !unfinished.includes(i)) } });
      for (const it of unfinished) {
        await fetch(`${base}/delete`, {
          method: "POST",
          headers: { "X-Token": token, "Content-Type": "application/json" },
          body: JSON.stringify({ kind: it.kind, url: it.url }),
        }).catch(() => {});
      }
      load();
    };

    const move = (it, before) => {
      // reorder locally straight away so the drop doesn't jump back until the next poll
      const order = queue.filter((q) => q !== it);
      const at = before ? order.findIndex((q) => itemKey(q) === before) : order.length;
      order.splice(at < 0 ? order.length : at, 0, it);
      const pos = new Map(order.map((q, n) => [q, n + 1]));
      setState({ data: { ...data, items: items.map((i) => (pos.has(i) ? { ...i, position: pos.get(i) } : i)) } });
      const target = before && queue.find((q) => itemKey(q) === before);
      fetch(`${base}/move`, {
        method: "POST",
        headers: { "X-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: it.kind, url: it.url, before: target ? { kind: target.kind, url: target.url } : null }),
      }).then((r) => {
        if (r.status === 403) alert("Set the downloader token in Settings → Plugins → Downloads to reorder the queue.");
        load();
      });
    };

    // pointer events rather than HTML5 drag and drop, so it also works on phones and tablets
    const startDrag = (e, it) => {
      if (e.button) return;
      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      const key = itemKey(it);
      const next = queue[queue.indexOf(it) + 1];
      const original = next ? itemKey(next) : null;
      dragRef.current = { key, before: original };
      setDrag(dragRef.current);
      const target = (y) => {
        const rows = [...queueRef.current.querySelectorAll(".dl-item")].filter((el) => el.dataset.key !== key);
        const row = rows.find((el) => {
          const r = el.getBoundingClientRect();
          return y < r.top + r.height / 2;
        });
        return row ? row.dataset.key : null;
      };
      const onMove = (ev) => {
        const before = target(ev.clientY);
        if (before !== dragRef.current.before) {
          dragRef.current = { key, before };
          setDrag(dragRef.current);
        }
      };
      const onEnd = (ev) => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
        const { before } = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        if (ev.type === "pointerup" && before !== original) move(it, before);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onEnd);
      handle.addEventListener("pointercancel", onEnd);
    };
    const counts = (data && data.counts) || {};
    const groups = ORDER.map((s) => {
      // the queue is shown in download order; everything else stays most recent first
      return { status: s, items: s === "queued" ? queue : items.filter((i) => i.status === s) };
    }).filter(
      (g) => g.items.length && (filter === "all" || filter === g.status)
    );

    return h(
      "div",
      null,
      h(
        "div",
        { className: "dl-summary" },
        h(
          "button",
          { className: "dl-chip" + (filter === "all" ? " active" : ""), onClick: () => setFilter("all") },
          `All ${items.length}`
        ),
        ORDER.filter((s) => counts[s]).map((s) =>
          h(
            "button",
            { key: s, className: `dl-chip dl-chip-${s}` + (filter === s ? " active" : ""), onClick: () => setFilter(s) },
            `${LABELS[s]} ${counts[s]}`
          )
        ),
        counts.failed ? h(Button, { size: "sm", variant: "secondary", onClick: retry }, "Retry failed") : null,
        h(CancelAllButton, { count: unfinished.length, what: "unfinished downloads (finished ones stay)", onConfirm: cancelAll }),
        data && data.credits && (data.credits.queued || data.credits.scanning)
          ? h("span", { className: "dl-speed" }, `Reading end credits: ${data.credits.queued + (data.credits.scanning ? 1 : 0)} left`)
          : null,
        data && data.workers && counts.downloading
          ? h(
              "span",
              { className: "dl-speed" },
              `${(data.workers.rate / 1e6).toFixed(1)} MB/s · up to ${data.workers.target} at once (${data.workers.mode})`
            )
          : null,
        h("a", { className: "dl-ext", href: `${base}/`, target: "_blank", rel: "noopener" }, "Downloader status page")
      ),
      state.error && h("div", { className: "dl-error-box" }, state.error),
      state.loading && h("div", null, "Loading…"),
      data && !items.length && h("p", { className: "dl-empty" }, "Nothing downloaded yet. Use the userscripts (</> icon in the navbar) on a member site."),
      groups.map((g) =>
        h(
          "section",
          {
            key: g.status,
            ref: g.status === "queued" ? queueRef : undefined,
            className: g.status === "queued" && drag && drag.before === null ? "dl-drop-end" : undefined,
          },
          h("h4", { className: "dl-group-title" }, `${LABELS[g.status]} (${g.items.length})`),
          g.items.map((it) =>
            h(Item, {
              key: itemKey(it),
              it,
              drag: g.status === "queued" && g.items.length > 1 ? { state: drag, start: startDrag } : null,
              onTop: g.status === "queued" && it !== queue[0] ? (x) => move(x, itemKey(queue[0])) : null,
              onDelete: remove,
            })
          )
        )
      )
    );
  }

  // ---------------------------------------------------------------- AI jobs

  const AI_POLL_MS = 3000;
  const OPTION_LABELS = {
    clip: "Marker clip",
    smooth2: "Smoother (double frame rate)",
    slowmo2: "Slow motion 2×",
    slowmo4: "Slow motion 4×",
    upscale2: "Video upscale 2×",
    upscale4k: "Video upscale to 4K",
    upscale4: "Image upscale 4×",
  };
  const isUpscale = (j) => j.kind === "upscale" || (j.option || "").startsWith("upscale");
  const isActive = (j) => ["queued", "running", "cancelling"].includes(j.state);

  function duration(s) {
    if (s == null) return "";
    if (s < 90) return `${Math.round(s)} s`;
    if (s < 5400) return `${Math.round(s / 60)} min`;
    return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  }

  // every AI job, polled while a tab that shows them is open
  function useAIJobs(base) {
    const [state, setState] = React.useState({ loading: true });
    const load = React.useCallback(() => {
      fetch(`${base}/parallax/ai-jobs`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`downloader: ${r.status}`))))
        .then((jobs) => setState({ jobs }), (e) => setState((s) => ({ ...s, loading: false, error: e.message })));
    }, [base]);
    React.useEffect(() => {
      load();
      const t = setInterval(load, AI_POLL_MS);
      return () => clearInterval(t);
    }, [load]);
    return { ...state, reload: load };
  }

  function AIJob({ job, base, token, reload }) {
    const [armed, setArmed] = React.useState(false);
    const label = job.kind === "upscale" ? `${job.gallery_id ? "Gallery" : "Image"} upscale ${job.factor}×` : OPTION_LABELS[job.option] || job.option;
    const source = job.gallery_id ? h(Link, { to: `/galleries/${job.gallery_id}` }, job.title || `Gallery ${job.gallery_id}`)
      : job.image_id ? h(Link, { to: `/images/${job.image_id}` }, job.title || `Image ${job.image_id}`)
      : h(Link, { to: `/scenes/${job.scene_id}${job.marker ? `?t=${Math.floor(job.marker.start)}` : ""}` }, job.title || `Scene ${job.scene_id}`);
    const result = job.state !== "done" ? null
      : job.gallery ? h(Link, { to: `/galleries/${job.gallery}`, className: "dl-ai-open" }, "Open the new gallery")
      : job.image ? h(Link, { to: `/images/${job.image}`, className: "dl-ai-open" }, "Open the new image")
      : job.scene ? h(Link, { to: `/scenes/${job.scene}`, className: "dl-ai-open" }, "Open the new scene") : null;
    const cancel = () => {
      if (!armed) return setArmed(true);
      fetch(`${base}/parallax/fps/${job.id}/cancel`, { method: "POST", headers: { "X-Token": token } }).then(reload);
    };
    const pct = Math.round((job.progress || 0) * 100);
    const unit = job.kind === "upscale" ? "images" : "frames";
    return h(
      "div",
      { className: `dl-item dl-ai-${job.state}` },
      h("div", { className: "dl-item-head" },
        h("span", { className: "dl-kind" }, label),
        h("span", { className: "dl-title" }, source),
        job.restarted && isActive(job) && h("span", { className: "dl-when", title: "The downloader restarted, so the job started again from the beginning" }, "restarted"),
        isActive(job) && job.state !== "cancelling" &&
          h("button", { className: "dl-top" + (armed ? " armed" : ""), onClick: cancel, onBlur: () => setArmed(false) }, armed ? "Click again to cancel" : "Cancel"),
        result,
        h("span", { className: "dl-when" }, timeAgo(job.finished || job.started || job.created))),
      job.state === "running" && h("div", { className: "dl-bar" }, h("div", { className: "dl-bar-fill", style: { width: `${Math.max(1, pct)}%` } })),
      h("div", { className: "dl-item-foot" },
        h("span", null,
          job.state === "running" ? `${pct}% · ${job.frames || 0} of ${job.total || "?"} ${unit}` +
            (job.eta != null ? ` · about ${duration(job.eta)} left` : "") + (job.speed ? ` · ${job.speed} ${unit}/s` : "")
          : job.state === "queued" ? `Queued${job.eta ? ` · about ${duration(job.eta)} once it starts` : ""}`
          : job.state === "cancelling" ? "Cancelling…"
          : job.state === "cancelled" ? "Cancelled"
          : job.state === "done" ? `Done${job.finished && job.started ? ` in ${duration(job.finished - job.started)}` : ""}`
          : job.state),
        job.marker && h("span", { className: "dl-path" }, `marker "${job.marker.title}"`),
        job.error && h("span", { className: "dl-error" }, job.error))
    );
  }

  function AIJobsTab({ base, token, ai, which }) {
    const jobs = (ai.jobs || []).filter((j) => (which === "upscaling" ? isUpscale(j) : !isUpscale(j)));
    const order = { running: 0, cancelling: 0, queued: 1 };
    jobs.sort((a, b) => (order[a.state] ?? 2) - (order[b.state] ?? 2) || b.created - a.created);
    const active = jobs.filter(isActive).filter((j) => j.state !== "cancelling")
      .sort((a, b) => (a.state === "queued" ? 0 : 1) - (b.state === "queued" ? 0 : 1));
    const cancelAll = async () => {
      for (const j of active) {
        await fetch(`${base}/parallax/fps/${j.id}/cancel`, { method: "POST", headers: { "X-Token": token } }).catch(() => {});
      }
      ai.reload();
    };
    const hint = which === "upscaling"
      ? "AI upscaling (Real-ESRGAN): the Upscale buttons on image and gallery pages, and Upscale 2× in a scene's AI frames menu."
      : "AI frames (RIFE): a smoother, higher frame rate, slow motion or marker clips, from the AI frames button on scene pages.";
    return h(
      "div",
      null,
      h("div", { className: "dl-tab-bar" },
        h("p", { className: "dl-empty" }, hint, " One job runs at a time; they survive restarts but start again from the beginning."),
        h(CancelAllButton, { count: active.length, what: "queued and running jobs", onConfirm: cancelAll })),
      ai.error && h("div", { className: "dl-error-box" }, ai.error),
      ai.loading && !ai.jobs && h("div", null, "Loading…"),
      ai.jobs && !jobs.length && h("p", { className: "dl-empty" }, "No jobs yet."),
      jobs.map((j) => h(AIJob, { key: j.id, job: j, base, token, reload: ai.reload }))
    );
  }

  // ---------------------------------------------------------------- Parallax

  function ParallaxTab({ base }) {
    const [projects, setProjects] = React.useState(null);
    const [error, setError] = React.useState(null);
    React.useEffect(() => {
      fetch(`${base}/parallax/projects`).then((r) => r.json()).then(setProjects, (e) => setError(e.message));
    }, [base]);
    const src = (s) => (s.kind === "image" ? `Image ${s.id}` : `Scene ${s.id}${s.span ? " · bullet time" : ""}`);
    return h(
      "div",
      null,
      h("p", { className: "dl-empty" },
        "Parallax exports render in your browser, in the studio, so there is no server queue for them; here are the projects and their exported scenes. ",
        h(Link, { to: "/parallax" }, "Open Parallax Studio")),
      error && h("div", { className: "dl-error-box" }, error),
      !projects && !error && h("div", null, "Loading…"),
      (projects || []).map((p) =>
        h("div", { key: p.id, className: "dl-item" + (p.scene_id ? " dl-ai-done" : "") },
          h("div", { className: "dl-item-head" },
            h("span", { className: "dl-kind" }, src(p.source)),
            h(Link, { className: "dl-title", to: `/parallax/${p.id}` }, p.title),
            p.scene_id ? h(Link, { to: `/scenes/${p.scene_id}`, className: "dl-ai-open" }, "Exported scene") : h("span", { className: "dl-when" }, "not exported"),
            h("span", { className: "dl-when" }, timeAgo(p.updated)))))
    );
  }

  // ---------------------------------------------------------------- Renders

  // Parallax exports render in the browser, in Parallax Studio. The studio shares
  // their progress through a BroadcastChannel and localStorage (see its studio.js);
  // this tab shows that, and can ask the studio to cancel one.
  const RENDERS_KEY = "parallax-renders";
  const STALLED_MS = 30000; // no news for this long: the studio tab was probably closed

  function useRenders() {
    const read = () => {
      try {
        return JSON.parse(localStorage.getItem(RENDERS_KEY) || "[]");
      } catch (e) {
        return [];
      }
    };
    const [renders, setRenders] = React.useState(read);
    const [, tick] = React.useState(0);
    React.useEffect(() => {
      const ch = "BroadcastChannel" in window ? new BroadcastChannel("parallax-renders") : null;
      if (ch) {
        ch.onmessage = (e) => {
          const r = e.data && e.data.render;
          if (r) setRenders((list) => [r, ...list.filter((x) => x.id !== r.id)].slice(0, 20));
        };
      }
      const t = setInterval(() => tick((n) => n + 1), 5000); // re-check for stalled renders
      return () => {
        clearInterval(t);
        if (ch) ch.close();
      };
    }, []);
    const cancel = (id) => {
      if (!("BroadcastChannel" in window)) return;
      const ch = new BroadcastChannel("parallax-renders");
      ch.postMessage({ cancel: id });
      ch.close();
    };
    return { renders, cancel };
  }

  const renderRunning = (r) => !["done", "error", "cancelled"].includes(r.stage);
  const renderStalled = (r) => renderRunning(r) && Date.now() - r.updated > STALLED_MS;

  function RenderItem({ r, cancel }) {
    const [armed, setArmed] = React.useState(false);
    const stalled = renderStalled(r);
    const running = renderRunning(r) && !stalled;
    const pct = r.frames ? Math.round((r.done / r.frames) * 100) : 0;
    const state = stalled ? "error" : r.stage === "done" ? "done" : r.stage === "error" ? "error" : r.stage === "cancelled" ? "cancelled" : "running";
    return h(
      "div",
      { className: `dl-item dl-ai-${state}` },
      h("div", { className: "dl-item-head" },
        h("span", { className: "dl-kind" }, `Export ${r.size}${r.boomerang ? " · boomerang" : ""}`),
        h(Link, { className: "dl-title", to: `/parallax/${r.pid}` }, r.title || "Parallax project"),
        running && h("button", { className: "dl-top" + (armed ? " armed" : ""), onBlur: () => setArmed(false),
          onClick: () => (armed ? cancel(r.id) : setArmed(true)) }, armed ? "Click again to cancel" : "Cancel"),
        r.stage === "done" && r.scene && h(Link, { to: `/scenes/${r.scene}`, className: "dl-ai-open" }, "Open the exported scene"),
        h("span", { className: "dl-when" }, timeAgo(Math.round((r.finished || r.updated || r.started) / 1000)))),
      running && h("div", { className: "dl-bar" }, h("div", { className: "dl-bar-fill" + (r.stage !== "Rendering" ? " indeterminate" : ""),
        style: { width: `${r.stage === "Rendering" ? Math.max(1, pct) : 100}%` } })),
      h("div", { className: "dl-item-foot" },
        h("span", null,
          stalled ? `Stopped at ${r.done} of ${r.frames} frames: the studio tab doing it was probably closed`
          : r.stage === "Rendering" ? `${pct}% · ${r.done} of ${r.frames} frames` + (r.eta != null ? ` · about ${duration(r.eta)} left` : "") +
            (r.rate ? ` · ${r.rate.toFixed(1)} frames/s` : "")
          : r.stage === "done" ? `Done: ${r.frames} frames at ${r.fps} fps in ${duration(((r.finished || r.updated) - r.started) / 1000)}`
          : r.stage === "cancelled" ? "Cancelled"
          : r.stage === "error" ? "Failed"
          : `${r.stage}…`),
        r.error && h("span", { className: "dl-error" }, r.error))
    );
  }

  function RendersTab({ renders, cancel }) {
    const running = renders.filter((r) => renderRunning(r) && !renderStalled(r));
    return h(
      "div",
      null,
      h("div", { className: "dl-tab-bar" },
        h("p", { className: "dl-empty" },
          "Parallax exports render in this browser while their studio is open (switching to this page in the same tab is fine), ",
          "then the downloader encodes them and imports them into Stash. Renders from other browsers don't show here."),
        h(CancelAllButton, { count: running.length, what: "running exports", onConfirm: () => running.forEach((r) => cancel(r.id)) })),
      !renders.length && h("p", { className: "dl-empty" }, "No exports yet."),
      renders.map((r) => h(RenderItem, { key: r.id, r, cancel }))
    );
  }

  // ---------------------------------------------------------------- the page

  const TABS = [["downloads", "Downloads"], ["interpolation", "Interpolation"], ["upscaling", "Upscaling"], ["renders", "Renders"],
    ["parallax", "Parallax"]];

  function QueuesPage() {
    const { base, token } = usePluginSettings();
    const location = ReactRouterDOM.useLocation();
    const history = ReactRouterDOM.useHistory();
    const tab = new URLSearchParams(location.search).get("tab") || "downloads";
    const ai = useAIJobs(base);
    const rd = useRenders();
    const busy = (which) => (ai.jobs || []).filter((j) => isActive(j) && (which === "upscaling" ? isUpscale(j) : !isUpscale(j))).length;
    return h(
      "div",
      { className: "dl-page" },
      h("h2", null, "Queues"),
      h("div", { className: "dl-tabs" },
        TABS.map(([k, label]) => {
          const n = k === "interpolation" || k === "upscaling" ? busy(k)
            : k === "renders" ? rd.renders.filter((r) => renderRunning(r) && !renderStalled(r)).length : 0;
          return h("button", {
            key: k, className: "dl-tab" + (tab === k ? " active" : ""),
            onClick: () => history.replace(`${location.pathname}?tab=${k}`),
          }, label, n ? h("span", { className: "dl-tab-count", title: "running or queued" }, n) : null);
        })),
      tab === "downloads" ? h(DownloadsPage)
        : tab === "parallax" ? h(ParallaxTab, { base })
        : tab === "renders" ? h(RendersTab, rd)
        : h(AIJobsTab, { base, token, ai, which: tab })
    );
  }

  const ReactRouterDOM = libraries.ReactRouterDOM;
  window.PluginApi.register.route("/queues", QueuesPage);
  window.PluginApi.register.route("/downloader", QueuesPage);

  window.PluginApi.patch.before("MainNavBar.MenuItems", function (props) {
    const item = h(
      Nav.Link,
      { key: "downloads", eventKey: "/queues", as: "div", className: "col-4 col-sm-3 col-md-2 col-lg-auto" },
      h(
        Link,
        { to: "/queues" },
        h(
          Button,
          { className: "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center" },
          h(FontAwesomeIcon, { icon: faListUl, className: "nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0 mr-xl-1" }),
          h("span", null, "Queues")
        )
      )
    );
    return [{ ...props, children: h(React.Fragment, null, props.children, item) }];
  });
})();
