/*
 * Stash TV - a lightweight scene browser/player for old TV browsers.
 * Written in plain ES5 (no fetch, Promises, arrow functions or classList).
 *
 * Routes (location.hash):
 *   #/                     scene grid
 *   #/scene/<id>/<secs>    play a scene from <secs>
 * Query params on first load: ?scene=<id>&t=<secs> to start playing,
 * ?apikey=<key> to authenticate (remembered in localStorage).
 */
(function () {
  "use strict";

  var PER_PAGE = 24;
  var POLL_MS = 3000;
  var ACTIVITY_MS = 30000;
  var OSD_HIDE_MS = 5000;
  var SEEK_DEBOUNCE_MS = 800;
  var QUALITIES = [
    { key: "direct", label: "Direct" },
    { key: "FULL_HD", label: "1080p" },
    { key: "STANDARD_HD", label: "720p" },
    { key: "STANDARD", label: "480p" }
  ];

  // e.g. "/plugin/tv/assets/index.html" -> "/"; keeps any reverse-proxy prefix
  var BASE = location.pathname.replace(/plugin\/tv\/assets\/.*$/, "");

  function $(id) { return document.getElementById(id); }

  function hasClass(el, c) { return (" " + el.className + " ").indexOf(" " + c + " ") >= 0; }
  function addClass(el, c) { if (!hasClass(el, c)) el.className = (el.className + " " + c).replace(/^\s+/, ""); }
  function removeClass(el, c) {
    el.className = (" " + el.className + " ").replace(" " + c + " ", " ").replace(/^\s+|\s+$/g, "");
  }
  function show(el) { removeClass(el, "hidden"); }
  function hide(el) { addClass(el, "hidden"); }

  function store(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem("stashtv." + key);
      window.localStorage.setItem("stashtv." + key, value);
    } catch (e) { /* storage unavailable */ }
    return null;
  }

  function queryParam(name) {
    var m = new RegExp("[?&]" + name + "=([^&#]*)").exec(location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : null;
  }

  var apiKey = queryParam("apikey") || store("apikey") || "";
  if (queryParam("apikey")) store("apikey", apiKey);

  function withKey(url) {
    if (!apiKey) return url;
    return url + (url.indexOf("?") >= 0 ? "&" : "?") + "apikey=" + encodeURIComponent(apiKey);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function fmtTime(secs) {
    secs = Math.max(0, Math.floor(secs || 0));
    var h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    return (h ? h + ":" + pad(m) : m) + ":" + pad(s);
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $("toast");
    t.innerHTML = escapeHtml(msg);
    show(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { hide(t); }, 3000);
  }

  function gql(query, variables, cb) {
    var x = new XMLHttpRequest();
    x.open("POST", BASE + "graphql", true);
    x.setRequestHeader("Content-Type", "application/json");
    if (apiKey) x.setRequestHeader("ApiKey", apiKey);
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      if (x.status === 401) {
        cb("Not logged in. Log in to Stash in this browser, or open /tv?apikey=YOUR_KEY");
        return;
      }
      var res;
      try { res = JSON.parse(x.responseText); } catch (e) { cb("Bad response (" + x.status + ")"); return; }
      if (res.errors && res.errors.length) { cb(res.errors[0].message); return; }
      cb(null, res.data);
    };
    x.send(JSON.stringify({ query: query, variables: variables || {} }));
  }

  /* ---------- spatial navigation ---------- */

  function visibleFocusables() {
    var all = document.querySelectorAll(".focusable"), out = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].offsetWidth > 0 || all[i].offsetHeight > 0) out.push(all[i]);
    }
    return out;
  }

  function center(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function moveFocus(dir) {
    var items = visibleFocusables();
    if (!items.length) return;
    var cur = document.activeElement;
    if (!cur || items.indexOf(cur) < 0) { items[0].focus(); return; }
    var c = center(cur), best = null, bestScore = Infinity;
    for (var i = 0; i < items.length; i++) {
      if (items[i] === cur) continue;
      var p = center(items[i]);
      var dx = p.x - c.x, dy = p.y - c.y, main, cross;
      if (dir === "left") { main = -dx; cross = dy; }
      else if (dir === "right") { main = dx; cross = dy; }
      else if (dir === "up") { main = -dy; cross = dx; }
      else { main = dy; cross = dx; }
      if (main <= 1) continue;
      var score = main + Math.abs(cross) * 2;
      if (score < bestScore) { bestScore = score; best = items[i]; }
    }
    if (best) {
      best.focus();
      if (best.scrollIntoView && hasClass(best, "card")) {
        var r = best.getBoundingClientRect();
        if (r.top < 0 || r.bottom > window.innerHeight) best.scrollIntoView(r.top < 0);
      }
    }
  }

  /* ---------- scene list ---------- */

  var listState = { page: 1, sort: store("sort") || "created_at", q: "", count: 0, focusIndex: 0 };

  var SCENES_QUERY =
    "query($f: FindFilterType) { findScenes(filter: $f) { count scenes {" +
    " id title date resume_time" +
    " files { basename duration }" +
    " paths { screenshot }" +
    " studio { name } performers { name } } } }";

  function sceneTitle(s) {
    return s.title || (s.files[0] && s.files[0].basename) || ("Scene " + s.id);
  }

  function loadList() {
    $("status").innerHTML = "Loading&hellip;";
    var sorts = document.querySelectorAll(".sort");
    for (var i = 0; i < sorts.length; i++) {
      if (sorts[i].getAttribute("data-sort") === listState.sort) addClass(sorts[i], "active");
      else removeClass(sorts[i], "active");
    }
    gql(SCENES_QUERY, {
      f: {
        q: listState.q,
        page: listState.page,
        per_page: PER_PAGE,
        sort: listState.sort,
        direction: "DESC"
      }
    }, function (err, data) {
      if (err) { $("status").innerHTML = escapeHtml(err); return; }
      renderList(data.findScenes);
    });
  }

  function renderList(res) {
    listState.count = res.count;
    var pages = Math.max(1, Math.ceil(res.count / PER_PAGE));
    $("status").innerHTML = res.count ? "" : "No scenes found.";
    $("pageinfo").innerHTML = "Page " + listState.page + " of " + pages + " (" + res.count + ")";
    $("prev").style.visibility = listState.page > 1 ? "visible" : "hidden";
    $("next").style.visibility = listState.page < pages ? "visible" : "hidden";

    var html = [];
    for (var i = 0; i < res.scenes.length; i++) {
      var s = res.scenes[i];
      var dur = s.files[0] ? s.files[0].duration : 0;
      var resume = dur && s.resume_time ? Math.min(100, (s.resume_time / dur) * 100) : 0;
      var meta = [];
      if (s.studio) meta.push(s.studio.name);
      if (s.date) meta.push(s.date);
      if (s.performers.length) {
        var names = [];
        for (var j = 0; j < s.performers.length; j++) names.push(s.performers[j].name);
        meta.push(names.join(", "));
      }
      html.push(
        '<a href="#/scene/' + s.id + "/" + Math.floor(s.resume_time || 0) + '" class="card focusable">' +
        '<div class="thumb" style="background-image:url(\'' + escapeHtml(withKey(s.paths.screenshot)) + '\')">' +
        (dur ? '<span class="dur">' + fmtTime(dur) + "</span>" : "") +
        (resume ? '<span class="resume" style="width:' + resume + '%"></span>' : "") +
        "</div>" +
        '<div class="title">' + escapeHtml(sceneTitle(s)) + "</div>" +
        '<div class="meta">' + escapeHtml(meta.join(" · ")) + "</div>" +
        "</a>"
      );
    }
    $("grid").innerHTML = html.join("");

    var cards = document.querySelectorAll(".card");
    if (cards.length) {
      cards[Math.min(listState.focusIndex, cards.length - 1)].focus();
    }
  }

  function changePage(delta) {
    var pages = Math.max(1, Math.ceil(listState.count / PER_PAGE));
    var p = listState.page + delta;
    if (p < 1 || p > pages) return;
    listState.page = p;
    listState.focusIndex = 0;
    window.scrollTo(0, 0);
    loadList();
  }

  /* ---------- player ---------- */

  var video = $("video");
  var player = {
    scene: null,     // scene object from GraphQL
    duration: 0,
    quality: store("quality") || "",
    offset: 0,       // start offset of a transcoded stream
    pendingSeek: null,
    seekTimer: null,
    activityTimer: null,
    osdTimer: null,
    lastSaved: 0
  };

  var SCENE_QUERY =
    "query($id: ID!) { findScene(id: $id) { id title resume_time" +
    " files { basename duration format video_codec audio_codec }" +
    " studio { name } } }";

  function canDirectPlay(file) {
    var fmt = (file.format || "").toLowerCase();
    var vc = (file.video_codec || "").toLowerCase();
    var ac = (file.audio_codec || "").toLowerCase();
    return fmt === "mp4" && vc === "h264" && (ac === "" || ac === "aac" || ac === "mp3");
  }

  function isDirect() { return player.quality === "direct"; }

  function currentTime() {
    return isDirect() ? video.currentTime : player.offset + video.currentTime;
  }

  function qualityLabel() {
    for (var i = 0; i < QUALITIES.length; i++) {
      if (QUALITIES[i].key === player.quality) return QUALITIES[i].label;
    }
    return player.quality;
  }

  function streamURL(start) {
    var id = player.scene.id;
    if (isDirect()) return withKey(BASE + "scene/" + id + "/stream");
    return withKey(BASE + "scene/" + id + "/stream.mp4?resolution=" + player.quality + "&start=" + Math.floor(start));
  }

  function loadStream(start) {
    show($("spinner"));
    start = Math.max(0, Math.min(start, player.duration ? player.duration - 5 : start));
    if (isDirect()) {
      player.offset = 0;
      video.src = streamURL(0);
      var onMeta = function () {
        video.removeEventListener("loadedmetadata", onMeta);
        if (start > 0) {
          try { video.currentTime = start; } catch (e) { /* some TVs reject early seeks */ }
        }
      };
      video.addEventListener("loadedmetadata", onMeta);
    } else {
      player.offset = start;
      video.src = streamURL(start);
    }
    video.load();
    var p = video.play();
    if (p && p.then) p.then(null, function () { /* autoplay blocked; Enter starts playback */ });
  }

  function playScene(id, start) {
    showView("player");
    saveActivity(true);
    player.scene = null;
    $("osd-title").innerHTML = "Loading&hellip;";
    gql(SCENE_QUERY, { id: id }, function (err, data) {
      if (err || !data.findScene) { toast(err || "Scene not found"); go("#/"); return; }
      var s = data.findScene;
      var f = s.files[0];
      if (!f) { toast("Scene has no file"); go("#/"); return; }
      player.scene = s;
      player.duration = f.duration;
      player.lastSaved = 0;
      if (!store("quality")) player.quality = canDirectPlay(f) ? "direct" : "STANDARD_HD";
      $("osd-title").innerHTML = escapeHtml(sceneTitle(s) + (s.studio ? " · " + s.studio.name : ""));
      $("btn-quality").innerHTML = qualityLabel();
      loadStream(start);
      showOsd(true);
    });
  }

  function stopPlayer() {
    exitFullscreen();
    saveActivity(true);
    player.scene = null;
    video.pause();
    video.removeAttribute("src");
    try { video.load(); } catch (e) { /* ignore */ }
  }

  function seekTo(t) {
    if (!player.scene) return;
    t = Math.max(0, Math.min(t, player.duration - 1));
    if (isDirect()) {
      video.currentTime = t;
    } else {
      loadStream(t);
    }
  }

  function seekBy(delta) {
    if (!player.scene) return;
    var base = player.pendingSeek !== null ? player.pendingSeek : currentTime();
    player.pendingSeek = Math.max(0, Math.min(base + delta, player.duration - 1));
    updateOsd();
    showOsd(false);
    clearTimeout(player.seekTimer);
    player.seekTimer = setTimeout(function () {
      var t = player.pendingSeek;
      player.pendingSeek = null;
      seekTo(t);
    }, SEEK_DEBOUNCE_MS);
  }

  function togglePlay() {
    if (video.paused) video.play(); else video.pause();
    updateOsd();
    showOsd(false);
  }

  function cycleQuality() {
    var idx = 0;
    for (var i = 0; i < QUALITIES.length; i++) if (QUALITIES[i].key === player.quality) idx = i;
    var t = currentTime();
    player.quality = QUALITIES[(idx + 1) % QUALITIES.length].key;
    store("quality", player.quality);
    $("btn-quality").innerHTML = qualityLabel();
    loadStream(t);
  }

  function updateOsd() {
    var t = player.pendingSeek !== null ? player.pendingSeek : currentTime();
    var d = player.duration || 0;
    $("osd-time").innerHTML = fmtTime(t) + " / " + fmtTime(d) +
      (player.pendingSeek !== null ? " &nbsp;(seeking)" : "");
    $("osd-progress").style.width = (d ? Math.min(100, (t / d) * 100) : 0) + "%";
    $("btn-play").innerHTML = video.paused ? "Play" : "Pause";
  }

  function osdVisible() { return !hasClass($("osd"), "faded"); }

  function showOsd(focusPlay) {
    if (hasClass($("player"), "hidden") || isFullscreen()) return;
    removeClass($("osd"), "faded");
    updateOsd();
    if (focusPlay || visibleFocusables().indexOf(document.activeElement) < 0) $("btn-play").focus();
    clearTimeout(player.osdTimer);
    player.osdTimer = setTimeout(function () {
      if (!video.paused) {
        addClass($("osd"), "faded");
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      }
    }, OSD_HIDE_MS);
  }

  /* ---------- fullscreen mode ---------- */

  function isFullscreen() { return hasClass($("player"), "fullscreen"); }

  function nativeFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement ||
      document.mozFullScreenElement || document.msFullscreenElement || null;
  }

  function enterFullscreen() {
    addClass($("player"), "fullscreen");
    addClass(document.body, "fullscreen");
    clearTimeout(player.osdTimer);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    // also ask the browser to go fullscreen where supported (old TV browsers usually already are)
    var el = document.documentElement;
    var req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
    if (req) {
      try {
        var p = req.call(el);
        if (p && p.then) p.then(null, function () { /* not allowed; CSS mode still applies */ });
      } catch (e) { /* ignore */ }
    }
  }

  function exitFullscreen() {
    if (!isFullscreen()) return;
    removeClass($("player"), "fullscreen");
    removeClass(document.body, "fullscreen");
    if (nativeFullscreenElement()) {
      var exit = document.exitFullscreen || document.webkitExitFullscreen ||
        document.mozCancelFullScreen || document.msExitFullscreen;
      if (exit) {
        try {
          var p = exit.call(document);
          if (p && p.then) p.then(null, function () {});
        } catch (e) { /* ignore */ }
      }
    }
    showOsd(true);
  }

  function onNativeFullscreenChange() {
    // browser fullscreen left via Esc etc. also leaves fullscreen mode
    if (!nativeFullscreenElement() && isFullscreen()) exitFullscreen();
  }
  document.addEventListener("fullscreenchange", onNativeFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onNativeFullscreenChange);
  document.addEventListener("mozfullscreenchange", onNativeFullscreenChange);
  document.addEventListener("MSFullscreenChange", onNativeFullscreenChange);

  function saveActivity(force) {
    if (!player.scene) return;
    var now = new Date().getTime();
    var t = currentTime();
    if (!force && now - player.lastSaved < ACTIVITY_MS) return;
    var played = player.lastSaved ? (now - player.lastSaved) / 1000 : 0;
    player.lastSaved = now;
    gql("mutation($id: ID!, $t: Float, $d: Float) { sceneSaveActivity(id: $id, resume_time: $t, playDuration: $d) }",
      { id: player.scene.id, t: t, d: played }, function () {});
  }

  video.addEventListener("timeupdate", function () {
    if (osdVisible()) updateOsd();
    if (!video.paused) saveActivity(false);
  });
  video.addEventListener("playing", function () { hide($("spinner")); updateOsd(); });
  video.addEventListener("waiting", function () { show($("spinner")); });
  video.addEventListener("pause", function () { updateOsd(); showOsd(false); });
  video.addEventListener("ended", function () { saveActivity(true); go("#/"); });
  video.addEventListener("error", function () {
    exitFullscreen();
    hide($("spinner"));
    if (player.scene) toast("Playback error - press Quality to try another format");
    showOsd(false);
  });

  /* ---------- cast receiver ---------- */

  var lastCastId = null;

  function pollCast() {
    gql('query { configuration { plugins(include: ["tv"]) } }', {}, function (err, data) {
      setTimeout(pollCast, POLL_MS);
      if (err) return;
      var cfg = (data.configuration.plugins || {}).tv || {};
      var id = cfg.cast_id ? String(cfg.cast_id) : "";
      if (lastCastId === null) { lastCastId = id; return; } // ignore casts from before this page loaded
      if (!id || id === lastCastId) return;
      lastCastId = id;
      toast("Casting scene " + cfg.cast_scene);
      go("#/scene/" + cfg.cast_scene + "/" + Math.floor(cfg.cast_time || 0));
    });
  }

  /* ---------- routing & input ---------- */

  function showView(name) {
    if (name === "list") { show($("list")); hide($("player")); }
    else { hide($("list")); show($("player")); }
  }

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  var listLoaded = false;
  function route() {
    var m = /^#\/scene\/(\d+)(?:\/(\d+))?/.exec(location.hash);
    if (m) {
      playScene(m[1], parseInt(m[2] || "0", 10));
      return;
    }
    if (player.scene) stopPlayer();
    showView("list");
    if (!listLoaded) { listLoaded = true; loadList(); }
    else {
      var cards = document.querySelectorAll(".card");
      if (cards.length) cards[Math.min(listState.focusIndex, cards.length - 1)].focus();
    }
  }

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
    BACK: [8, 27, 461, 10009, 166],
    PLAYPAUSE: [179, 10252, 415, 19, 32],
    STOP: [413, 178],
    FF: [417, 228],
    RW: [412, 227],
    PAGEUP: [33], PAGEDOWN: [34]
  };
  function isKey(code, list) { return list.indexOf(code) >= 0; }

  document.addEventListener("keydown", function (e) {
    var code = e.keyCode;
    var inInput = document.activeElement && document.activeElement.tagName === "INPUT";
    var playing = !hasClass($("player"), "hidden");

    if (inInput && code !== KEY.UP && code !== KEY.DOWN && code !== KEY.ENTER) return;

    // in fullscreen mode any button only brings the controls back
    if (playing && isFullscreen()) { e.preventDefault(); exitFullscreen(); return; }

    if (isKey(code, KEY.BACK)) {
      e.preventDefault();
      if (playing) go("#/");
      return;
    }

    if (playing) {
      if (isKey(code, KEY.PLAYPAUSE)) { e.preventDefault(); togglePlay(); return; }
      if (isKey(code, KEY.STOP)) { e.preventDefault(); go("#/"); return; }
      if (isKey(code, KEY.FF)) { e.preventDefault(); seekBy(30); return; }
      if (isKey(code, KEY.RW)) { e.preventDefault(); seekBy(-30); return; }
      if (!osdVisible()) {
        e.preventDefault();
        if (code === KEY.LEFT) seekBy(-30);
        else if (code === KEY.RIGHT) seekBy(30);
        else if (code === KEY.UP) seekBy(300);
        else if (code === KEY.DOWN) seekBy(-300);
        else showOsd(true);
        return;
      }
      showOsd(false);
      if (code === KEY.UP) { e.preventDefault(); seekBy(300); return; }
      if (code === KEY.DOWN) { e.preventDefault(); seekBy(-300); return; }
    } else {
      if (isKey(code, KEY.PAGEUP)) { e.preventDefault(); changePage(-1); return; }
      if (isKey(code, KEY.PAGEDOWN)) { e.preventDefault(); changePage(1); return; }
    }

    if (code === KEY.LEFT) { e.preventDefault(); moveFocus("left"); }
    else if (code === KEY.RIGHT) { e.preventDefault(); moveFocus("right"); }
    else if (code === KEY.UP) { e.preventDefault(); moveFocus("up"); }
    else if (code === KEY.DOWN) { e.preventDefault(); moveFocus("down"); }
  });

  document.addEventListener("click", function (e) {
    if (isFullscreen()) { e.preventDefault(); exitFullscreen(); return; }
    var el = e.target;
    while (el && el !== document && !(el.getAttribute && (el.getAttribute("data-act") || el.getAttribute("data-sort") || el.id === "prev" || el.id === "next"))) {
      el = el.parentNode;
    }
    if (!el || el === document) return;
    e.preventDefault();
    var act = el.getAttribute("data-act");
    var sort = el.getAttribute("data-sort");
    if (sort) {
      listState.sort = sort;
      listState.page = 1;
      listState.focusIndex = 0;
      store("sort", sort);
      loadList();
    } else if (el.id === "prev") changePage(-1);
    else if (el.id === "next") changePage(1);
    else if (act === "back") go("#/");
    else if (act === "play") togglePlay();
    else if (act === "quality") cycleQuality();
    else if (act === "fullscreen") enterFullscreen();
    else if (act) seekBy(parseInt(act, 10));
  });

  // remember which card was opened so Back returns focus to it
  $("grid").addEventListener("focus", function (e) {
    var cards = document.querySelectorAll(".card");
    for (var i = 0; i < cards.length; i++) if (cards[i] === e.target) listState.focusIndex = i;
  }, true);

  var searchTimer = null;
  $("search").addEventListener("keyup", function (e) {
    if (e.keyCode === KEY.UP || e.keyCode === KEY.DOWN) return;
    clearTimeout(searchTimer);
    var delay = e.keyCode === KEY.ENTER ? 0 : 600;
    searchTimer = setTimeout(function () {
      if ($("search").value === listState.q) return;
      listState.q = $("search").value;
      listState.page = 1;
      listState.focusIndex = 0;
      loadList();
    }, delay);
  });

  $("player").addEventListener("mousemove", function () { showOsd(false); });
  window.addEventListener("hashchange", route);
  window.addEventListener("beforeunload", function () { saveActivity(true); });

  // ?scene=ID&t=SECS on first load starts playback directly
  var initialScene = queryParam("scene");
  if (initialScene && !/^#\/scene\//.test(location.hash)) {
    location.hash = "#/scene/" + initialScene + "/" + Math.floor(parseFloat(queryParam("t") || "0"));
  }
  route();
  pollCast();
})();
