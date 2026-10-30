// Parallax Studio entry points: a navbar item, a "Parallax" button on image pages
// and on scene pages (uses the paused player's time), and "Open in Parallax Studio"
// on scenes that were exported from a project. Also the Enhance buttons: on scene
// pages (opens Enhance Studio, enhance.js) and on image and gallery pages (opens
// the image studio, /enhance-image).
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
    // images and galleries: restore, upscale, colourise, faces, background... in the image studio
    ensure("parallax-enhance-image-button", image && image[1], () => {
      const group = lastGroup(".image-toolbar .image-toolbar-group");
      if (!group) return;
      group.insertBefore(
        makeButton("parallax-enhance-image-button", image[1], "Enhance this image: restore, upscale, colourise, faces, background (a new copy)", "Enhance",
          () => go(`/enhance-image?image=${image[1]}`)),
        group.firstChild
      );
    });

    const gallery = /\/galleries\/(\d+)(?:\/|$)/.exec(path);
    ensure("parallax-enhance-gallery-button", gallery && gallery[1], () => {
      const groups = document.querySelectorAll(".gallery-toolbar .gallery-toolbar-group");
      const group = groups[groups.length - 1];
      if (!group) return;
      group.insertBefore(
        makeButton("parallax-enhance-gallery-button", gallery[1], "Enhance the images of this gallery (a new gallery)", "Enhance",
          () => go(`/enhance-image?gallery=${gallery[1]}`)),
        group.firstChild
      );
    });

    // scenes: deinterlacing, cleaning, upscaling and frame rates are all in Enhance Studio
    ensure("parallax-enhance-button", scene && scene[1], () => {
      const group = lastGroup(".scene-toolbar .scene-toolbar-group");
      if (!group) return;
      group.insertBefore(
        makeButton("parallax-enhance-button", scene[1], "Enhance Studio: deinterlace, clean up, upscale or change the frame rate (made as a new scene)",
          "Enhance", () => {
            const el = document.querySelector(".video-js");
            const player = el && el.player;
            const t = player ? player.currentTime() || 0 : 0;
            if (player) player.pause();
            go(`/enhance?scene=${scene[1]}${t > 0 ? `&t=${t.toFixed(2)}` : ""}`);
          }),
        group.firstChild
      );
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
