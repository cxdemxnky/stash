// Parallax Studio entry points: a navbar item, a "Parallax" button on image pages
// and on scene pages (uses the paused player's time), and "Open in Parallax Studio"
// on scenes that were exported from a project.
(function () {
  const { React, libraries } = window.PluginApi;
  const { Link, useHistory } = libraries.ReactRouterDOM;
  const { FontAwesomeIcon } = libraries.ReactFontAwesome;
  const { faLayerGroup } = libraries.FontAwesomeSolid;
  const { Nav, Button } = libraries.Bootstrap;
  const h = React.createElement;

  const ICON =
    '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 17l6-6 4 4 3-3 5 5"/><rect x="2" y="4" width="20" height="16" rx="2"/>' +
    '<circle cx="9" cy="8" r="1.6" fill="currentColor"/></svg>';

  let routerHistory = null;
  function HistoryGrabber() {
    routerHistory = useHistory();
    return null;
  }

  function go(to) {
    if (routerHistory) routerHistory.push(to);
    else window.location.href = new URL(to.slice(1), document.baseURI).href;
  }

  window.PluginApi.patch.before("MainNavBar.MenuItems", function (props) {
    const item = h(
      Nav.Link,
      { key: "parallax", eventKey: "/parallax", as: "div", className: "col-4 col-sm-3 col-md-2 col-lg-auto" },
      h(
        Link,
        { to: "/parallax" },
        h(
          Button,
          { className: "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center" },
          h(FontAwesomeIcon, { icon: faLayerGroup, className: "nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0 mr-xl-1" }),
          h("span", null, "Parallax")
        )
      )
    );
    return [{ ...props, children: h(React.Fragment, null, props.children, item, h(HistoryGrabber, { key: "parallax-history" })) }];
  });

  function makeButton(id, target, title, label, onClick) {
    const wrapper = document.createElement("span");
    const button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.dataset.target = target;
    button.className = "minimal btn btn-secondary pxs-page-button";
    button.title = title;
    button.innerHTML = ICON + (label ? `<span>${label}</span>` : "");
    button.addEventListener("click", onClick);
    wrapper.appendChild(button);
    return wrapper;
  }

  // a small menu under a button; closes on any click elsewhere
  function showMenu(anchor, items) {
    const old = document.getElementById("pxs-menu");
    if (old) old.remove();
    const menu = document.createElement("div");
    menu.id = "pxs-menu";
    menu.className = "pxs-menu";
    for (const [label, hint, run] of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `<b></b><span></span>`;
      b.querySelector("b").textContent = label;
      b.querySelector("span").textContent = hint;
      b.addEventListener("click", () => { menu.remove(); run(); });
      menu.appendChild(b);
    }
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - 308, r.left))}px`;
    menu.style.top = `${r.bottom + 4}px`;
    document.body.appendChild(menu);
    setTimeout(() => {
      const close = (e) => {
        if (!menu.contains(e.target)) {
          menu.remove();
          document.removeEventListener("pointerdown", close, true);
        }
      };
      document.addEventListener("pointerdown", close, true);
    });
  }

  function lastGroup(selector) {
    const groups = document.querySelectorAll(selector);
    return groups[groups.length - 1] || null;
  }

  // the downloader's address and token (the Downloads plugin's settings)
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
          const cfg = (body.data && body.data.configuration.plugins && body.data.configuration.plugins.downloads) || {};
          return { base: (cfg.downloader_url || `${location.protocol}//${location.hostname}:10141`).replace(/\/$/, ""), token: cfg.token || "" };
        });
    }
    return backendPromise;
  }

  // ---- AI frames: a smoother, higher frame rate or slow motion, as a new scene
  const FPS_OPTIONS = [
    ["smooth2", "Smoother: double frame rate", "same speed and length, audio kept"],
    ["slowmo2", "Slow motion 2×", "half speed, twice as long"],
    ["slowmo4", "Slow motion 4×", "quarter speed, 4× as long"],
  ];
  // the scene page's Upscale button (same job queue as AI frames)
  const UPSCALE_OPTIONS = [
    ["upscale2", "Upscale 2×", "twice the resolution (1080p → 4K), same speed; slow, best for markers"],
    ["upscale4k", "Upscale to 4K", "one AI pass to 3840 px wide (e.g. 720p → 4K: better and faster than 2× twice)"],
  ];
  const isUpscaleJob = (job) => (job.option || "").startsWith("upscale");
  const fpsState = {}; // scene id -> last status

  function duration(s) {
    if (s == null) return "?";
    if (s < 90) return `${Math.round(s)} s`;
    if (s < 5400) return `${Math.round(s / 60)} min`;
    return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  }

  async function fpsStatus(sid) {
    const { base } = await backend();
    const st = await (await fetch(`${base}/parallax/fps?scene=${sid}`)).json();
    fpsState[sid] = st;
    updateFpsButton(sid);
    return st;
  }

  async function fpsPost(path, body) {
    const { base, token } = await backend();
    const res = await fetch(`${base}/parallax/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Token": token }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  const active = (job) => job && (job.state === "queued" || job.state === "running" || job.state === "cancelling");

  function updateFpsButton(sid) {
    const st = fpsState[sid];
    for (const [id, upscaling, idle] of [["parallax-fps-button", false, "AI frames"], ["parallax-scene-upscale-button", true, "Upscale"]]) {
      const b = document.getElementById(id);
      if (!b || b.dataset.target !== sid) continue;
      const job = st && (st.jobs || []).find((j) => active(j) && isUpscaleJob(j) === upscaling);
      const label = b.querySelector("span");
      if (label) label.textContent = job ? (job.state === "queued" ? `${upscaling ? "Upscale" : "AI"} queued`
        : `${upscaling ? "Upscale" : "AI"} ${Math.round(job.progress * 100)}%`) : idle;
    }
  }

  // while a job runs, keep the button's percentage fresh
  setInterval(() => {
    const m = /\/scenes\/(\d+)(?:\/|$)/.exec(window.location.pathname);
    if (m && fpsState[m[1]] && (fpsState[m[1]].jobs || []).some(active)) fpsStatus(m[1]).catch(() => {});
  }, 15000);

  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  // mode "frames": the AI frames button (smoother, slow motion, marker clips);
  // mode "upscale": the Upscale button. Both list the scene's jobs of their kind.
  async function openFpsMenu(anchor, sid, mode = "frames") {
    const upscaling = mode === "upscale";
    let OPTIONS = upscaling ? UPSCALE_OPTIONS : FPS_OPTIONS;
    let st;
    try {
      st = await fpsStatus(sid);
      if (upscaling) {
        const { base } = await backend();
        st.available = ((await (await fetch(`${base}/parallax/status`)).json()).models || []).includes("upscale");
      }
    } catch (e) {
      showMenu(anchor, [["Downloader unreachable", e.message, () => {}]]);
      return;
    }
    if (!st.available) {
      showMenu(anchor, [[upscaling ? "AI upscale isn't available" : "AI frames aren't available",
        `the ${upscaling ? "Real-ESRGAN" : "RIFE"} model is missing (see STASH-RESTORE step 6c)`, () => {}]]);
      return;
    }
    const optionName = (opt) => (opt === "clip" ? "Clip" : ([...FPS_OPTIONS, ...UPSCALE_OPTIONS].find((o) => o[0] === opt) || [, "AI frames"])[1]);
    const start = (body) => fpsPost("fps", { scene_id: sid, ...body }).then(() => fpsStatus(sid))
      .catch((e) => showMenu(anchor, [["Couldn't start", e.message, () => {}]]));
    const items = [];
    // jobs for this scene: running ones can be cancelled, finished ones opened
    for (const job of (st.jobs || []).filter((j) => isUpscaleJob(j) === upscaling)) {
      const what = `${optionName(job.option)}${job.marker ? ` of "${job.marker.title}"` : ""}`;
      if (active(job)) {
        items.push([job.state === "queued" ? `${what}: queued` : `${what}: ${Math.round(job.progress * 100)}%`,
          job.state === "running" ? `about ${duration(job.eta)} left · click to cancel` : "waits for the job before it · click to cancel",
          () => fpsPost(`fps/${job.id}/cancel`, {}).then(() => fpsStatus(sid))]);
      } else if (job.state === "done" && job.scene && items.length < 6) {
        items.push([`Open: ${what}`, "the new scene it made", () => go(`/scenes/${job.scene}`)]);
      } else if (job.state === "error" && items.length < 6) {
        items.push([`${what} failed`, job.error || "", () => {}]);
      }
    }
    const est = st.estimate;
    // "to 4K" only for sources that aren't 4K wide already
    if (upscaling && est && est.width >= 3840) OPTIONS = OPTIONS.filter(([opt]) => opt !== "upscale4k");
    const markers = (est && est.markers) || [];
    const span = (m) => `${fmtTime(m.start)}–${fmtTime(m.start + m.duration)}${m.has_end ? "" : " (no end set: 10 s)"}`;
    // the marker this page is about: opened from a marker (?t=its start), or the player is inside one
    const t = Number(new URLSearchParams(location.search).get("t"));
    const el = document.querySelector(".video-js");
    const now = el && el.player ? el.player.currentTime() || 0 : 0;
    const here = (!isNaN(t) && t > 0 && markers.find((m) => Math.abs(m.start - t) < 1))
      || (now > 0 && markers.find((m) => now >= m.start && now < m.start + m.duration));
    if (here) {
      if (!upscaling) items.push([`This marker, clip only: ${here.title}`, `${span(here)} · just this part, as it is; a few seconds`,
        () => start({ option: "clip", marker_id: here.id })]);
      for (const [opt, label, hint] of OPTIONS) {
        items.push([`This marker: ${label}`, `${span(here)} · ${hint}; about ${duration(here.seconds[opt])} on the GPU`,
          () => start({ option: opt, marker_id: here.id })]);
      }
    }
    for (const [opt, label, hint] of OPTIONS) {
      items.push([`Whole scene: ${label}`, `${hint}; about ${duration(est && est.seconds[opt])} on the GPU. Made as a new scene.`,
        () => start({ option: opt })]);
    }
    // markers: a short video of just that part, plain or with AI frames
    for (const m of markers.filter((m) => m !== here)) {
      if (upscaling) {
        for (const [opt, label] of OPTIONS) {
          items.push([`Marker: ${m.title}: ${label}`, `${span(m)} · about ${duration(m.seconds[opt])} on the GPU`,
            () => start({ option: opt, marker_id: m.id })]);
        }
        continue;
      }
      items.push([`Marker: ${m.title}`, `${span(m)} · make a short video…`,
        () => showMenu(anchor, [
          ["Clip only", "just this part, as it is; a few seconds", () => start({ option: "clip", marker_id: m.id })],
          ...FPS_OPTIONS.map(([opt, label, hint]) =>
            [label, `${hint}; about ${duration(m.seconds[opt])} on the GPU`, () => start({ option: opt, marker_id: m.id })]),
        ])]);
    }
    showMenu(anchor, items);
  }

  // ---- AI upscale for an image or a whole gallery: new images (a gallery's in a new gallery)
  async function openUpscaleMenu(anchor, kind, id) {
    const { base } = await backend();
    let st;
    try {
      st = await (await fetch(`${base}/parallax/upscale?${kind}=${id}`)).json();
    } catch (e) {
      showMenu(anchor, [["Downloader unreachable", e.message, () => {}]]);
      return;
    }
    if (!st.available) {
      showMenu(anchor, [["AI upscale isn't available", "the Real-ESRGAN model is missing (see STASH-RESTORE step 6c)", () => {}]]);
      return;
    }
    const items = [];
    for (const job of st.jobs || []) {
      if (active(job)) {
        items.push([job.state === "queued" ? `Upscale ${job.factor}×: queued` : `Upscale ${job.factor}×: ${job.frames} of ${job.total} images`,
          job.state === "running" ? `about ${duration(job.eta)} left · click to cancel` : "waits for the job before it · click to cancel",
          () => fpsPost(`fps/${job.id}/cancel`, {})]);
      } else if (job.state === "done" && items.length < 4) {
        if (job.gallery) items.push([`Open the upscaled gallery (${job.factor}×)`, "made by the last upscale", () => go(`/galleries/${job.gallery}`)]);
        else if (job.image) items.push([`Open the upscaled image (${job.factor}×)`, "made by the last upscale", () => go(`/images/${job.image}`)]);
      } else if (job.state === "error" && items.length < 4) {
        items.push(["The last upscale failed", job.error || "", () => {}]);
      }
    }
    const est = st.estimate || { images: 1, seconds: {} };
    const what = kind === "gallery" ? `all ${est.images} images, as a new gallery` : "a new, bigger image (in the Upscaled folder)";
    for (const f of [2, 4]) {
      items.push([`AI upscale ${f}×`, `${what}; about ${duration(est.seconds[String(f)])} on the GPU`,
        () => fpsPost("upscale", { [`${kind}_id`]: id, factor: f }).catch((e) => showMenu(anchor, [["Couldn't start", e.message, () => {}]]))]);
    }
    showMenu(anchor, items);
  }

  // exported scenes: which project (if any) made this scene, cached per scene id
  const projectForScene = {};
  async function findProject(sid) {
    if (sid in projectForScene) return projectForScene[sid];
    projectForScene[sid] = null;
    try {
      const res = await fetch(new URL("graphql", document.baseURI), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ configuration { plugins } }" }),
      });
      const body = await res.json();
      const cfg = (body.data && body.data.configuration.plugins && body.data.configuration.plugins.downloads) || {};
      const base = (cfg.downloader_url || `${location.protocol}//${location.hostname}:10141`).replace(/\/$/, "");
      const list = await (await fetch(`${base}/parallax/projects?scene=${sid}`)).json();
      projectForScene[sid] = list[0] ? list[0].id : null;
    } catch (e) {
      projectForScene[sid] = null;
    }
    ensureButtons();
    return projectForScene[sid];
  }

  function ensure(id, target, mount) {
    const existing = document.getElementById(id);
    if (existing && existing.dataset.target === target) return;
    if (existing) existing.parentNode.remove();
    if (target) mount();
  }

  function ensureButtons() {
    const path = window.location.pathname;
    const image = /\/images\/(\d+)(?:\/|$)/.exec(path);
    const scene = /\/scenes\/(\d+)(?:\/|$)/.exec(path);

    ensure("parallax-image-button", image && image[1], () => {
      const group = lastGroup(".image-toolbar .image-toolbar-group");
      if (!group) return;
      group.insertBefore(
        makeButton("parallax-image-button", image[1], "Make a parallax clip from this image", "", () =>
          go(`/parallax/new?image=${image[1]}`)),
        group.firstChild
      );
    });

    ensure("parallax-scene-button", scene && scene[1], () => {
      const group = lastGroup(".scene-toolbar .scene-toolbar-group");
      if (!group) return;
      group.insertBefore(
        makeButton("parallax-scene-button", scene[1], "Make a parallax clip from the current (paused) frame", "", (ev) => {
          const el = document.querySelector(".video-js");
          const player = el && el.player;
          const t = player ? player.currentTime() || 0 : 0;
          if (player) player.pause();
          const base = `/parallax/new?scene=${scene[1]}&t=${t.toFixed(3)}`;
          showMenu(ev.currentTarget, [
            ["Still frame", "the paused frame", () => go(base)],
            ["Bullet time (1 s)", "slow motion from the next second of video", () => go(`${base}&span=1`)],
            ["Bullet time, AI-smoothed", "AI in-between frames (4×): smoother slow motion, about 2½ min to make",
              () => go(`${base}&span=1&ai=4`)],
          ]);
        }),
        group.firstChild
      );
    });

    const pid = scene && projectForScene[scene[1]];
    if (scene && !(scene[1] in projectForScene)) findProject(scene[1]);
    ensure("parallax-upscale-image-button", image && image[1], () => {
      const group = lastGroup(".image-toolbar .image-toolbar-group");
      if (!group) return;
      group.insertBefore(
        makeButton("parallax-upscale-image-button", image[1], "AI upscale this image (a new, bigger copy)", "Upscale",
          (ev) => openUpscaleMenu(ev.currentTarget, "image", image[1])),
        group.firstChild
      );
    });

    const gallery = /\/galleries\/(\d+)(?:\/|$)/.exec(path);
    ensure("parallax-upscale-gallery-button", gallery && gallery[1], () => {
      const groups = document.querySelectorAll(".gallery-toolbar .gallery-toolbar-group");
      const group = groups[groups.length - 1];
      if (!group) return;
      group.insertBefore(
        makeButton("parallax-upscale-gallery-button", gallery[1], "AI upscale every image of this gallery (a new gallery)", "Upscale",
          (ev) => openUpscaleMenu(ev.currentTarget, "gallery", gallery[1])),
        group.firstChild
      );
    });

    ensure("parallax-scene-upscale-button", scene && scene[1], () => {
      const group = lastGroup(".scene-toolbar .scene-toolbar-group");
      if (!group) return;
      group.insertBefore(
        makeButton("parallax-scene-upscale-button", scene[1], "AI upscale this scene or one of its markers (made as a new scene)",
          "Upscale", (ev) => openFpsMenu(ev.currentTarget, scene[1], "upscale")),
        group.firstChild
      );
      fpsStatus(scene[1]).catch(() => {});
    });

    ensure("parallax-fps-button", scene && scene[1], () => {
      const group = lastGroup(".scene-toolbar .scene-toolbar-group");
      if (!group) return;
      group.insertBefore(
        makeButton("parallax-fps-button", scene[1], "AI frames: a smoother, higher frame rate or slow motion, made as a new scene",
          "AI frames", (ev) => openFpsMenu(ev.currentTarget, scene[1])),
        group.firstChild
      );
      fpsStatus(scene[1]).catch(() => {});
    });

    ensure("parallax-open-button", pid ? scene[1] : null, () => {
      const group = lastGroup(".scene-toolbar .scene-toolbar-group");
      if (!group) return;
      group.insertBefore(
        makeButton("parallax-open-button", scene[1], "Open the project this clip was made from", "Studio", () => go(`/parallax/${pid}`)),
        group.firstChild
      );
    });
  }

  // toolbars render asynchronously, so watch for them
  new MutationObserver(ensureButtons).observe(document.body, { childList: true, subtree: true });
  ensureButtons();
})();
