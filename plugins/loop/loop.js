// A Loop button in the scene player's control bar, before the fullscreen button.
// On, the player loops (video.js loop()) on this scene and every scene opened after
// it, until it's turned off: the choice is kept in localStorage. Stash's own Shift+L
// shortcut toggles the same loop, and the button follows it.
(function () {
  const KEY = "stash-loop";
  const ICON =
    '<svg viewBox="0 0 24 24" width="1.5em" height="1.5em" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/>' +
    '<path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>';

  function remembered() {
    try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; }
  }
  function remember(on) {
    try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (e) { /* blocked */ }
  }

  function show(button, on) {
    button.classList.toggle("stash-loop-on", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.title = on ? "Looping (click to stop)" : "Loop this video (Shift+L)";
  }

  function attach(player) {
    const bar = player.controlBar && player.controlBar.el();
    if (!bar || bar.querySelector(".stash-loop-button")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vjs-control vjs-button stash-loop-button";
    button.innerHTML = ICON + '<span class="vjs-control-text" aria-live="polite">Loop</span>';
    // Stash calls loop(false) on each new scene (unless it's shorter than "maximum
    // loop duration"): while the button is on, that call loops anyway
    const loop = player.loop.bind(player);
    player.loop = (v) => (v === undefined ? loop() : loop(!!v || remembered()));
    const set = (on) => {
      remember(on);
      loop(on);
      show(button, on);
    };
    button.addEventListener("click", (ev) => {
      ev.stopPropagation();
      set(!loop());
    });
    const fullscreen = player.controlBar.getChild("fullscreenToggle");
    bar.insertBefore(button, fullscreen ? fullscreen.el() : null);
    player.loop(loop());
    show(button, loop());

    // Shift+L, Stash's shortcut (the player's hotkeys, so only with focus in the
    // player), toggles loop() too: the capturing listener sees it first, so the
    // button changes with it and the wrapper lets it through
    const key = (ev) => {
      if (player.isDisposed()) return document.removeEventListener("keydown", key, true);
      if (ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.key.toLowerCase() === "l" &&
          player.el().contains(ev.target) && !/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) {
        remember(!loop());
        setTimeout(() => show(button, loop()), 0);
      }
    };
    document.addEventListener("keydown", key, true);
  }

  function ensure() {
    document.querySelectorAll(".video-js").forEach((el) => {
      if (el.player && !el.player.isDisposed()) attach(el.player);
    });
  }

  new MutationObserver(ensure).observe(document.body, { childList: true, subtree: true });
  ensure();
})();
