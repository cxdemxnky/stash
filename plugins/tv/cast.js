// Adds a "Cast to TV" button to the scene page toolbar. Clicking it pauses the
// local player and tells any open /tv page to play the scene from the current time.
// The cast command is stored in this plugin's configuration, which /tv polls.
(function () {
  const BUTTON_ID = "tv-cast-button";
  const TV_ICON =
    '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="2" y="5" width="20" height="13" rx="2"/><path d="M8 21h8M12 18v3"/></svg>';

  function sceneIdFromPath() {
    const m = /\/scenes\/(\d+)(?:\/|$)/.exec(window.location.pathname);
    return m ? m[1] : null;
  }

  function currentPlayerTime() {
    const el = document.querySelector(".video-js");
    const player = el && el.player;
    if (!player) return { time: 0, player: null };
    // Stash's offset middleware makes currentTime() absolute for transcoded streams
    return { time: player.currentTime() || 0, player };
  }

  function toast(message, isError) {
    let el = document.getElementById("tv-cast-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "tv-cast-toast";
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.className = isError ? "error show" : "show";
    clearTimeout(el._timer);
    el._timer = setTimeout(() => (el.className = ""), 3000);
  }

  function formatTime(secs) {
    secs = Math.floor(secs);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = String(secs % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  }

  async function cast() {
    const sceneId = sceneIdFromPath();
    if (!sceneId) return;
    const { time, player } = currentPlayerTime();

    const res = await fetch(new URL("graphql", document.baseURI), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query:
          "mutation($input: Map!) { configurePlugin(plugin_id: \"tv\", input: $input) }",
        variables: {
          input: {
            cast_id: String(Date.now()),
            cast_scene: sceneId,
            cast_time: Math.floor(time),
          },
        },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.errors) {
      throw new Error((body.errors && body.errors[0].message) || res.statusText);
    }

    if (player) player.pause();
    toast(`Sent to TV at ${formatTime(time)}`);
  }

  function ensureButton() {
    if (!sceneIdFromPath()) return;
    if (document.getElementById(BUTTON_ID)) return;
    const groups = document.querySelectorAll(".scene-toolbar .scene-toolbar-group");
    const group = groups[groups.length - 1];
    if (!group) return;

    const wrapper = document.createElement("span");
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.className = "minimal px-0 px-sm-2 pt-2 btn btn-secondary";
    button.title = "Cast to TV (open /tv on the TV first)";
    button.innerHTML = TV_ICON;
    button.addEventListener("click", () => {
      cast().catch((e) => toast(`Cast failed: ${e.message}`, true));
    });
    wrapper.appendChild(button);
    group.insertBefore(wrapper, group.firstChild);
  }

  // the toolbar is rendered asynchronously, so watch for it
  new MutationObserver(ensureButton).observe(document.body, {
    childList: true,
    subtree: true,
  });
  ensureButton();
})();
