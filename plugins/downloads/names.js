// Adds a "Read names" button to the scene page toolbar. Clicking it pauses the player,
// asks the downloader to OCR the frames around that position (POST /credits/frame) and
// shows the names it found; the ticked ones are added to the scene (POST /credits/apply),
// creating performers that don't exist yet.
(function () {
  const BUTTON_ID = "dl-names-button";
  const ID_ICON =
    '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="2" y="4" width="20" height="16" rx="2"/><circle cx="8" cy="11" r="2.5"/>' +
    '<path d="M4.5 17c.7-1.8 2-2.7 3.5-2.7s2.8.9 3.5 2.7M14 9h5M14 13h4"/></svg>';

  function sceneIdFromPath() {
    const m = /\/scenes\/(\d+)(?:\/|$)/.exec(window.location.pathname);
    return m ? m[1] : null;
  }

  async function settings() {
    const res = await fetch(new URL("graphql", document.baseURI), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ configuration { plugins } }" }),
    });
    const body = await res.json();
    const cfg = (body.data && body.data.configuration.plugins && body.data.configuration.plugins.downloads) || {};
    const base = (cfg.downloader_url || `${location.protocol}//${location.hostname}:10141`).replace(/\/$/, "");
    return { base, token: cfg.token || "" };
  }

  async function call(path, payload) {
    const { base, token } = await settings();
    if (!token) throw new Error("set the downloader token in Settings → Plugins → Downloads");
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "X-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
  }

  function formatTime(secs) {
    secs = Math.floor(secs);
    const m = Math.floor(secs / 60);
    return `${m}:${String(secs % 60).padStart(2, "0")}`;
  }

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    Object.assign(e, attrs || {});
    for (const c of children) if (c != null) e.append(c);
    return e;
  }

  function closeDialog() {
    const d = document.getElementById("dl-names-dialog");
    if (d) d.remove();
  }

  function dialog(title, ...body) {
    closeDialog();
    const box = el("div", { className: "dl-names-box" }, el("h5", null, title), ...body);
    const backdrop = el("div", { id: "dl-names-dialog" }, box);
    backdrop.addEventListener("click", (e) => e.target === backdrop && closeDialog());
    document.body.append(backdrop);
    return box;
  }

  function refreshScene() {
    // the scene page reads from Apollo's cache; refetch so the new performers show up
    try {
      window.PluginApi.utils.StashService.getClient().refetchQueries({ include: "active" });
    } catch (e) {
      console.warn("[names] refetch failed", e);
    }
  }

  function showResults(sceneId, time, res) {
    const rows = res.candidates.map((c) => {
      const input = el("input", { type: "text", value: c.name, className: "form-control form-control-sm" });
      const check = el("input", {
        type: "checkbox",
        checked: !c.on_scene,
        disabled: c.on_scene,
      });
      const badge = el(
        "span",
        { className: "dl-names-badge" + (c.on_scene ? " on" : c.exists ? " exists" : "") },
        c.on_scene ? "on scene" : c.exists ? "in Stash" : "new"
      );
      return { check, input, badge, node: el("label", { className: "dl-names-row" }, check, input, badge) };
    });
    const extra = el("input", { type: "text", placeholder: "Add another name…", className: "form-control form-control-sm" });
    const extraBadge = el("span", { className: "dl-names-badge" });
    const status = el("div", { className: "dl-names-status" });
    const fill = el("div", { className: "dl-names-progress-fill" });
    const progress = el("div", { className: "dl-names-progress" }, fill);
    const add = el("button", { type: "button", className: "btn btn-primary btn-sm", textContent: "Add to scene" });
    const cancel = el("button", { type: "button", className: "btn btn-secondary btn-sm", textContent: "Cancel" });
    cancel.onclick = closeDialog;
    const setBadge = (badge, text, cls, title) => {
      badge.textContent = text;
      badge.className = "dl-names-badge " + cls;
      badge.title = title || "";
    };
    // names are added one request at a time so each row can show how it went
    add.onclick = async () => {
      const jobs = rows
        .filter((r) => r.check.checked && r.input.value.trim())
        .map((r) => ({ name: r.input.value.trim(), badge: r.badge, row: r }));
      if (extra.value.trim()) jobs.push({ name: extra.value.trim(), badge: extraBadge });
      if (!jobs.length) return closeDialog();
      add.disabled = cancel.disabled = extra.disabled = true;
      rows.forEach((r) => (r.check.disabled = r.input.disabled = true));
      jobs.forEach((j) => setBadge(j.badge, "waiting", "wait"));
      progress.className = "dl-names-progress show";
      const added = [];
      const failed = [];
      for (const [n, j] of jobs.entries()) {
        status.textContent = `Adding ${n + 1} of ${jobs.length}: ${j.name}…`;
        fill.style.width = `${(n / jobs.length) * 100}%`;
        setBadge(j.badge, "adding…", "busy");
        try {
          await call("/credits/apply", { scene_id: sceneId, names: [j.name] });
          setBadge(j.badge, "\u2713 added", "done");
          added.push(j);
        } catch (e) {
          setBadge(j.badge, "\u2717 failed", "error", e.message);
          failed.push(j);
        }
      }
      fill.style.width = "100%";
      if (added.length) refreshScene();
      if (!failed.length) {
        status.textContent = `Added ${added.length} name${added.length === 1 ? "" : "s"}.`;
        setTimeout(closeDialog, 1200);
        toast(`Added ${added.map((j) => j.name).join(", ")}`);
        return;
      }
      // leave the failed ones ticked so "Retry" only re-sends those
      status.textContent = `${added.length} of ${jobs.length} added; ${failed.length} failed (hover for why).`;
      for (const j of added) if (j.row) j.row.check.checked = false;
      if (added.some((j) => !j.row)) extra.value = "";
      rows.forEach((r) => {
        const ok = added.some((j) => j.row === r);
        r.check.disabled = r.input.disabled = ok || r.badge.textContent === "on scene";
      });
      add.textContent = "Retry";
      add.disabled = cancel.disabled = extra.disabled = false;
    };
    dialog(
      `Names at ${formatTime(time)}`,
      rows.length
        ? el("div", null, ...rows.map((r) => r.node))
        : el("p", { className: "dl-names-empty" }, "No names found in these frames. Try pausing where the names are fully shown."),
      res.rows.length && !rows.length
        ? el("details", null, el("summary", null, "Text that was read"), el("pre", null, res.rows.join("\n")))
        : null,
      el("div", { className: "dl-names-row dl-names-extra" }, extra, extraBadge),
      progress,
      status,
      el("div", { className: "dl-names-actions" }, cancel, add)
    );
  }

  function toast(message) {
    let t = document.getElementById("dl-names-toast");
    if (!t) document.body.append((t = el("div", { id: "dl-names-toast" })));
    t.textContent = message;
    t.className = "show";
    clearTimeout(t._timer);
    t._timer = setTimeout(() => (t.className = ""), 3000);
  }

  async function readNames() {
    const sceneId = sceneIdFromPath();
    const v = document.querySelector(".video-js");
    const player = v && v.player;
    if (!sceneId || !player) return;
    player.pause();
    // Stash's offset middleware makes currentTime() absolute for transcoded streams
    const time = player.currentTime() || 0;
    dialog(`Reading names at ${formatTime(time)}…`, el("p", null, "Running OCR on the frames around this point (a few seconds)."));
    try {
      showResults(sceneId, time, await call("/credits/frame", { scene_id: sceneId, time }));
    } catch (e) {
      dialog("Couldn't read names", el("p", null, e.message), el("div", { className: "dl-names-actions" },
        el("button", { type: "button", className: "btn btn-secondary btn-sm", textContent: "Close", onclick: closeDialog })));
    }
  }

  function ensureButton() {
    if (!sceneIdFromPath() || document.getElementById(BUTTON_ID)) return;
    const groups = document.querySelectorAll(".scene-toolbar .scene-toolbar-group");
    const group = groups[groups.length - 1];
    if (!group) return;
    const button = el("button", {
      id: BUTTON_ID,
      type: "button",
      className: "minimal px-0 px-sm-2 pt-2 btn btn-secondary",
      title: "Read performer names on screen at the current position",
      innerHTML: ID_ICON,
    });
    button.addEventListener("click", readNames);
    group.insertBefore(el("span", null, button), group.firstChild);
  }

  // the toolbar is rendered asynchronously, so watch for it
  new MutationObserver(ensureButton).observe(document.body, { childList: true, subtree: true });
  ensureButton();
})();
