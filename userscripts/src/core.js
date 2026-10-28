// ---- Stash downloader userscript core (shared by all sites) ----
// A site adapter defines `SITE` before this file:
//   name           studio name, also the downloader's site key
//   captureUrl     RegExp of the site's own data requests to record
//   onCapture(url, json, data)   store records from a captured response
//   cards(data)    -> [{el, key, kind, label}] DOM cards to put checkboxes on
//   buildJobs(keys, data, ctx) -> Promise<[job]> jobs for the downloader
//   pageActions(data) -> [{label, run(ctx) -> Promise<[job]>}] optional extra panel buttons
// The build step prepends the metadata block and replaces __SERVICE_URL__ / __TOKEN__.
/* global SITE, GM_getValue, GM_setValue, GM_xmlhttpRequest, GM_registerMenuCommand, GM_addStyle, unsafeWindow */
(function () {
  "use strict";

  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const IN_FRAME = W.top !== W.self;
  const DEFAULTS = { service: "__SERVICE_URL__", token: "__TOKEN__" };
  const setting = (k) => GM_getValue(k, DEFAULTS[k]);
  const data = {}; // adapter-owned record store

  // ---------------------------------------------------------------- capture
  // Record the JSON responses of the site's own requests (fetch + XHR).

  function handleCapture(url, text) {
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return;
    }
    try {
      SITE.onCapture(url, json, data);
    } catch (e) {
      console.error("[stash-dl] capture", e);
    }
    if (IN_FRAME) {
      // hidden loader frames forward everything to the main page
      W.parent.postMessage({ stashDl: "capture", url, json }, W.location.origin);
    } else {
      scheduleScan();
    }
  }

  const origFetch = W.fetch;
  W.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (SITE.captureUrl.test(url)) {
      p.then((r) => r.clone().text().then((t) => handleCapture(url, t))).catch(() => {});
    }
    return p;
  };
  const XHR = W.XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  XHR.open = function (method, url) {
    this.__stashDlUrl = String(url);
    return origOpen.apply(this, arguments);
  };
  XHR.send = function () {
    if (SITE.captureUrl.test(this.__stashDlUrl || "")) {
      this.addEventListener("load", () => {
        if (this.responseType === "" || this.responseType === "text") {
          handleCapture(this.__stashDlUrl, this.responseText);
        } else if (this.responseType === "json") {
          handleCapture(this.__stashDlUrl, JSON.stringify(this.response));
        }
      });
    }
    return origSend.apply(this, arguments);
  };

  if (IN_FRAME) return; // frames only capture

  W.addEventListener("message", (e) => {
    if (e.origin !== W.location.origin || !e.data || e.data.stashDl !== "capture") return;
    try {
      SITE.onCapture(e.data.url, e.data.json, data);
    } catch (err) {
      console.error("[stash-dl] frame capture", err);
    }
  });

  // ---------------------------------------------------------------- helpers

  function gm(details) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...details,
        onload: resolve,
        onerror: (e) => reject(new Error(e && e.error ? e.error : "network error")),
        ontimeout: () => reject(new Error("timeout")),
      });
    });
  }

  function service(method, path, body) {
    return gm({
      method,
      url: setting("service").replace(/\/$/, "") + path,
      headers: { "Content-Type": "application/json", "X-Token": setting("token") },
      data: body ? JSON.stringify(body) : undefined,
      timeout: 20000,
    }).then((r) => {
      if (r.status !== 200) throw new Error(`downloader: HTTP ${r.status} ${r.responseText || ""}`);
      return JSON.parse(r.responseText);
    });
  }

  // Follow a member download link's redirects without downloading the file, and
  // return the final (signed CDN) URL.
  function resolveRedirect(url) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (r, req) => {
        if (done || !r || r.readyState < 2) return;
        done = true;
        if (req) req.abort();
        if (r.status >= 400) reject(new Error(`HTTP ${r.status} resolving download`));
        else resolve(r.finalUrl || url);
      };
      const req = GM_xmlhttpRequest({
        method: "GET",
        url,
        headers: { Range: "bytes=0-0" },
        onreadystatechange: (r) => finish(r, req),
        onload: (r) => finish(r),
        onerror: () => !done && reject(new Error("network error resolving download")),
        timeout: 30000,
      });
    });
  }

  // Load a same-origin page in a hidden frame so the site loads its own data for
  // it (captured by this script inside the frame); resolves when ready(doc) is
  // true. onReady(doc) can then act on the frame's page, e.g. click a button.
  function loadInFrame(path, ready, timeoutMs = 30000, onReady = null, lingerMs = 500) {
    return new Promise((resolve) => {
      const f = document.createElement("iframe");
      f.style.cssText = "position:fixed;left:-10000px;top:0;width:1280px;height:800px;visibility:hidden";
      f.src = path;
      const started = Date.now();
      const doc = () => {
        try {
          return f.contentDocument;
        } catch (e) {
          return null;
        }
      };
      const timer = setInterval(() => {
        const ok = !!ready(doc());
        if (ok || Date.now() - started > timeoutMs) {
          clearInterval(timer);
          let acted = ok;
          if (ok && onReady) {
            try {
              onReady(doc());
            } catch (e) {
              console.error("[stash-dl] frame action", e);
              acted = false;
            }
          }
          setTimeout(() => {
            f.remove();
            resolve(acted);
          }, ok && onReady ? lingerMs : 500);
        }
      }, 400);
      document.body.appendChild(f);
    });
  }

  function largestImage(list) {
    // list: [{url, width, height}]
    return (list || [])
      .filter((i) => i && i.url)
      .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];
  }

  // ---------------------------------------------------------------- overlay

  GM_addStyle(`
    .sdl-host { position: relative !important; }
    .sdl-check { position: absolute; top: 8px; left: 8px; z-index: 50; width: 30px; height: 30px;
      border-radius: 6px; background: rgba(0,0,0,.65); border: 2px solid #fff; cursor: pointer;
      display: flex; align-items: center; justify-content: center; color: #fff; font: bold 20px/1 sans-serif; }
    .sdl-check.on { background: #2f7dd1; border-color: #2f7dd1; }
    .sdl-check.on::after { content: "\\2713"; }
    .sdl-host.sdl-selected { outline: 4px solid #2f7dd1; outline-offset: -4px; }
    .sdl-badge { position: absolute; top: 8px; left: 46px; z-index: 50; padding: 3px 8px; border-radius: 6px;
      background: rgba(0,0,0,.7); color: #fff; font: 600 12px/1.4 sans-serif; pointer-events: none; }
    .sdl-badge.done { background: #2e8b57; } .sdl-badge.failed { background: #b33; }
    #sdl-panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; min-width: 260px; max-width: 360px;
      background: #1d2329; color: #eee; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.5);
      font: 13px/1.4 system-ui, sans-serif; padding: 10px 12px; }
    #sdl-panel .sdl-title { font-weight: 700; margin-bottom: 6px; display: flex; justify-content: space-between; }
    #sdl-panel button { margin: 3px 4px 3px 0; padding: 5px 10px; border: 0; border-radius: 6px; cursor: pointer;
      background: #394450; color: #fff; font: inherit; }
    #sdl-panel button.primary { background: #2f7dd1; }
    #sdl-panel button:disabled { opacity: .5; cursor: default; }
    #sdl-panel .sdl-status { margin-top: 6px; color: #b8c2cc; white-space: pre-wrap; max-height: 120px; overflow: auto; }
    #sdl-panel.min .sdl-body { display: none; }
  `);

  const selected = new Set();
  let cards = [];
  let known = {};

  const panel = document.createElement("div");
  panel.id = "sdl-panel";
  panel.innerHTML = `
    <div class="sdl-title"><span>Stash · ${SITE.name}</span><a href="#" class="sdl-min" style="color:#9ab">–</a></div>
    <div class="sdl-body">
      <div class="sdl-count"></div>
      <div><button class="sdl-all">Select all</button><button class="sdl-none">Deselect all</button></div>
      <div><button class="primary sdl-go">Download selected</button></div>
      <div class="sdl-actions"></div>
      <div class="sdl-status"></div>
    </div>`;
  const $ = (sel) => panel.querySelector(sel);

  function setStatus(msg) {
    $(".sdl-status").textContent = msg;
  }

  function updatePanel() {
    $(".sdl-count").textContent = `${selected.size} selected · ${cards.length} on page`;
    $(".sdl-go").disabled = selected.size === 0 || busy;
    const actions = $(".sdl-actions");
    const list = (SITE.pageActions && SITE.pageActions(data)) || [];
    const sig = list.map((a) => a.label).join("|");
    if (actions.dataset.sig !== sig) {
      actions.dataset.sig = sig;
      actions.innerHTML = "";
      list.forEach((a) => {
        const b = document.createElement("button");
        b.textContent = a.label;
        b.onclick = () =>
          run(async () => {
            const jobs = await a.run(ctx);
            if (jobs) await submit(jobs);
          });
        actions.appendChild(b);
      });
    }
    actions.querySelectorAll("button").forEach((b) => (b.disabled = busy));
  }

  function toggle(key, on) {
    if (on) selected.add(key);
    else selected.delete(key);
    cards.filter((c) => c.key === key).forEach(paintCard);
    updatePanel();
  }

  function paintCard(c) {
    const on = selected.has(c.key);
    c.el.classList.toggle("sdl-selected", on);
    c.box.classList.toggle("on", on);
    const st = known[c.url];
    c.badge.style.display = st ? "" : "none";
    c.badge.className = "sdl-badge " + (st || "");
    c.badge.textContent = st ? `Stash: ${st}` : "";
  }

  function scan() {
    let found = [];
    try {
      found = SITE.cards(data) || [];
    } catch (e) {
      console.error("[stash-dl] cards", e);
    }
    cards = [];
    for (const c of found) {
      if (!c.el.__sdl) {
        const box = document.createElement("div");
        box.className = "sdl-check";
        box.title = "Select for Stash download";
        const badge = document.createElement("div");
        badge.className = "sdl-badge";
        badge.style.display = "none";
        // checkboxes sit inside links, so swallow the click before the site sees it
        const stop = (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        };
        ["mousedown", "mouseup", "pointerdown", "pointerup", "touchstart"].forEach((t) => box.addEventListener(t, stop, true));
        box.addEventListener("click", (e) => {
          stop(e);
          const card = e.currentTarget.__card;
          toggle(card.key, !selected.has(card.key));
        }, true);
        c.el.classList.add("sdl-host");
        c.el.appendChild(box);
        c.el.appendChild(badge);
        c.el.__sdl = { box, badge };
      }
      Object.assign(c, c.el.__sdl);
      c.box.__card = c;
      cards.push(c);
      paintCard(c);
    }
    updatePanel();
  }

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 300);
  }

  const ALREADY = ["queued", "downloading", "awaiting_file", "expired", "done"];
  $(".sdl-all").onclick = () => {
    // skip what the downloader already has
    cards.filter((c) => !ALREADY.includes(known[c.url])).forEach((c) => selected.add(c.key));
    cards.forEach(paintCard);
    updatePanel();
  };
  $(".sdl-none").onclick = () => {
    selected.clear();
    cards.forEach(paintCard);
    updatePanel();
  };
  $(".sdl-min").onclick = (e) => {
    e.preventDefault();
    panel.classList.toggle("min");
  };
  $(".sdl-go").onclick = () =>
    run(async () => {
      const keys = [...selected];
      const jobs = await SITE.buildJobs(keys, data, ctx);
      if (!jobs.some((j) => j.items.length) && !ctx.preSkipped.already_queued && !ctx.preSkipped.in_stash) {
        setStatus("Nothing to download.");
      } else {
        await submit(jobs);
      }
      selected.clear();
    });

  let busy = false;
  async function run(fn) {
    if (busy) return;
    busy = true;
    ctx.preSkipped = { already_queued: 0, in_stash: 0 };
    updatePanel();
    try {
      await fn();
    } catch (e) {
      console.error("[stash-dl]", e);
      setStatus("Error: " + e.message);
    } finally {
      busy = false;
      scan();
      refreshKnown();
    }
  }

  async function submit(jobs) {
    const total = { queued: 0, already_queued: ctx.preSkipped.already_queued, in_stash: ctx.preSkipped.in_stash };
    for (const job of jobs) {
      if (!job.items.length) continue;
      const res = await service("POST", "/jobs", job);
      total.queued += res.queued;
      total.already_queued += res.already_queued || 0;
      total.in_stash += res.in_stash || 0;
    }
    const skipped = [];
    if (total.already_queued) skipped.push(`${total.already_queued} already queued/downloaded`);
    if (total.in_stash) skipped.push(`${total.in_stash} already in Stash`);
    setStatus(`Queued ${total.queued} new item(s).` + (skipped.length ? `\nSkipped ${skipped.join(", ")}.` : ""));
  }

  // drop items the downloader already has or Stash already contains
  async function dropKnown(site, items) {
    if (!items.length) return items;
    const states = await service("POST", "/check", { site, items: items.map((i) => ({ kind: i.kind, url: i.url })) });
    states.forEach((st) => {
      if (st === "in_stash") ctx.preSkipped.in_stash += 1;
      else if (st !== "new") ctx.preSkipped.already_queued += 1;
    });
    return items.filter((_, i) => states[i] === "new");
  }

  async function refreshKnown() {
    try {
      known = await service("GET", "/known?site=" + encodeURIComponent(SITE.name));
      cards.forEach(paintCard);
    } catch (e) {
      setStatus("Downloader unreachable: " + e.message + "\nSet its address from the Tampermonkey menu.");
    }
  }

  // re-resolve links the downloader reports as expired while a site tab is open
  async function refreshExpired() {
    try {
      const list = await service("GET", "/expired?site=" + encodeURIComponent(SITE.name));
      for (const it of list) {
        const mediaUrl = await resolveRedirect(it.resolve);
        await service("POST", "/refresh", { url: it.url, media_url: mediaUrl });
      }
      if (list.length) setStatus(`Refreshed ${list.length} expired download link(s).`);
    } catch (e) {
      console.warn("[stash-dl] refresh", e);
    }
  }

  const ctx = { setStatus, resolveRedirect, loadInFrame, largestImage, service, dropKnown, preSkipped: {} };

  GM_registerMenuCommand("Set downloader address", () => {
    const v = prompt("Downloader URL (e.g. http://192.168.1.10:10141)", setting("service"));
    if (v) GM_setValue("service", v.trim().replace(/\/$/, ""));
  });
  GM_registerMenuCommand("Set downloader token", () => {
    const v = prompt("Downloader token", setting("token"));
    if (v != null) GM_setValue("token", v.trim());
  });

  function start() {
    document.body.appendChild(panel);
    new MutationObserver((muts) => {
      if (muts.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && !n.closest?.("#sdl-panel") && !n.classList?.contains("sdl-check") && !n.classList?.contains("sdl-badge")))) {
        scheduleScan();
      }
    }).observe(document.body, { childList: true, subtree: true });
    scan();
    refreshKnown();
    setInterval(refreshKnown, 20000);
    setInterval(refreshExpired, 60000);
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
