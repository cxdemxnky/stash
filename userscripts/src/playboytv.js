// ---- PlayboyTV ----
// Show = Gamma "serie", season = Gamma "movie", episode = scene.
// Episode pages only load the current season's episodes, so whole-show downloads
// load each season's first episode in a hidden frame to collect the rest.
const SITE = {
  name: "PlayboyTV",
  captureUrl: GAMMA.captureUrl,
  onCapture: GAMMA.onCapture,

  episodePath(hit) {
    return `/en/episode/view/${hit.url_title}/${hit.clip_id}`;
  },

  seasonNumber(data, hit) {
    const movie = data.movies[hit.movie_id];
    const title = (movie && movie.series_sort && movie.series_sort.title) || hit.movie_title || "";
    const m = /season\s*(\d+)/i.exec(title);
    if (m) return +m[1];
    return movie && movie.series_sort ? movie.series_sort.rank + 1 : 1;
  },

  episodeNumber(hit) {
    const m = /_(\d+)$/.exec(hit.clip_path || "") || /episode\s*(\d+)/i.exec(hit.title || "");
    return m ? +m[1] : null;
  },

  cards(data) {
    const out = [];
    const onShows = /\/shows\/?$/.test(location.pathname);
    // episode links come as /en/episode/view/<slug>/<id> and /en/episode/<site>/<slug>/<id>
    for (const a of document.querySelectorAll('a[href*="/episode/"]')) {
      if (!a.querySelector("img")) continue;
      const id = (/\/(\d+)\/?$/.exec(a.getAttribute("href")) || [])[1];
      if (!id) continue;
      const el = a.closest(".ListingGrid-ListingGridItem") || a.parentElement;
      // show cards link to the show's first episode; prefer the episode reading
      // except on the Shows listing
      const serie = Object.values(data.series).find((s) => s.first_clip && String(s.first_clip.clip_id) === id);
      if (data.scenes[id] && !(onShows && serie)) {
        out.push({ el, key: "clip:" + id, kind: "scene", url: location.origin + SITE.episodePath(data.scenes[id]) });
      } else if (serie) {
        out.push({ el, key: "serie:" + serie.serie_id, kind: "show" });
      }
    }
    return out;
  },

  async loadWholeShow(serieId, data, ctx) {
    const serie = GAMMA.serie(data, serieId);
    const seasons = () => Object.values(data.movies).filter((m) => String(m.serie_id) === String(serieId));
    const loaded = (movieId) => !!(data.seasonLoaded || {})[movieId];

    if (!seasons().length) {
      const first = serie && serie.first_clip;
      if (!first) throw new Error("Open the show's page first so its seasons can be found");
      ctx.setStatus(`Loading ${serie.title}…`);
      await ctx.loadInFrame(`/en/episode/view/${first.url_title}/${first.clip_id}`, () =>
        seasons().some((m) => loaded(m.movie_id)));
    }
    // On the show's page, click its season links: the page then loads each
    // season's full episode list itself. Elsewhere fall back to hidden frames.
    const seasonLink = (m) =>
      [...document.querySelectorAll("a[href]")].find(
        (a) => /^season\s*\d+$/i.test(a.textContent.trim()) && a.getAttribute("href").endsWith("/" + m.first_clip.clip_id)
      );
    const startPath = location.pathname;
    const all = seasons();
    let clicked = false;
    for (const [i, m] of all.entries()) {
      if (loaded(m.movie_id) || !m.first_clip) continue;
      ctx.setStatus(`Loading ${m.title || "season"} (${i + 1}/${all.length})…`);
      const link = seasonLink(m);
      let ok;
      if (link) {
        link.click();
        clicked = true;
        ok = await SITE.waitFor(() => loaded(m.movie_id), 20000);
      } else {
        ok = await ctx.loadInFrame(`/en/episode/view/${m.first_clip.url_title}/${m.first_clip.clip_id}`, () =>
          loaded(m.movie_id));
      }
      if (!ok) {
        throw new Error(
          `Couldn't load the episode list for ${m.title || "a season"}.` +
            (link ? " Try again." : " Open the show's page and use Download all seasons there.")
        );
      }
    }
    if (clicked) {
      // go back to the season the user was looking at
      const back = [...document.querySelectorAll("a[href]")].find((a) => a.getAttribute("href") === startPath);
      if (back) back.click();
    }
    return Object.values(data.scenes).filter((s) => String(s.serie_id) === String(serieId));
  },

  waitFor(cond, timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (cond() || Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(!!cond());
        }
      }, 300);
    });
  },

  async buildJobs(keys, data, ctx) {
    const scenes = {};
    for (const key of keys) {
      const [type, id] = key.split(":");
      if (type === "clip" && data.scenes[id]) scenes[id] = data.scenes[id];
      if (type === "serie") (await SITE.loadWholeShow(id, data, ctx)).forEach((s) => (scenes[s.clip_id] = s));
    }

    const bySerie = {};
    for (const hit of Object.values(scenes)) (bySerie[hit.serie_id] = bySerie[hit.serie_id] || []).push(hit);

    const jobs = [];
    for (const [serieId, hits] of Object.entries(bySerie)) {
      const serie = GAMMA.serie(data, serieId);
      const first = hits[0];
      let items = hits
        .map((hit) => {
          const resolve = GAMMA.memberDownloadUrl(hit);
          if (!resolve) return null;
          return {
            kind: "scene",
            url: location.origin + SITE.episodePath(hit),
            title: /^episode\s*\d+$/i.test(hit.title) ? `${hit.serie_name} - ${hit.title}` : hit.title,
            date: hit.release_date,
            details: hit.description,
            season: SITE.seasonNumber(data, hit),
            episode: SITE.episodeNumber(hit),
            performers: GAMMA.names(hit.actors),
            tags: GAMMA.names(hit.categories),
            image: GAMMA.sceneImage(hit),
            media: { resolve },
          };
        })
        .filter(Boolean);
      items = await ctx.dropKnown(SITE.name, items);
      await GAMMA.resolveItems(items, ctx);
      jobs.push({
        site: SITE.name,
        show: {
          title: first.serie_name,
          url: serie && serie.first_clip
            ? location.origin + `/en/episode/view/${serie.first_clip.url_title}/${serie.first_clip.clip_id}`
            : null,
          description: (serie && serie.description) || first.movie_desc,
          image: GAMMA.mediaImage(serie, ["thumbnailSquare"]) || [].concat(GAMMA.sceneImage(first))[0],
          tags: GAMMA.names((serie && serie.categories) || first.categories),
        },
        items,
      });
    }
    return jobs;
  },

  pageActions(data) {
    const id = (/\/episode\/[^/]+\/[^/]+\/(\d+)/.exec(location.pathname) || [])[1];
    const hit = id && data.scenes[id];
    if (!hit) return [];
    return [
      {
        label: `Download all seasons: ${hit.serie_name}`,
        run: (ctx) => SITE.buildJobs(["serie:" + hit.serie_id], data, ctx),
      },
    ];
  },
};
