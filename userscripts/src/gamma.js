// ---- Gamma Entertainment helpers (PlayboyTV, AdultTime) ----
// Gamma member sites load their catalogue from Algolia. The site's own responses
// are captured by the core; these helpers turn the records into downloader jobs.
const GAMMA = {
  captureUrl: /algolia\.net|algolianet\.com/,

  onCapture(url, json, data) {
    data.scenes = data.scenes || {};
    data.series = data.series || {};
    data.movies = data.movies || {};
    data.photosets = data.photosets || {};
    data.seasonLoaded = data.seasonLoaded || {};
    const results = json.results || (json.hits ? [json] : []);
    for (const r of results) {
      const index = r.index || "";
      // episode pages list their whole season with this index; a single scene
      // lookup arrives first, so only this marks a season as complete
      if (index.startsWith("all_scenes_clippath")) {
        for (const h of r.hits || []) data.seasonLoaded[h.movie_id] = true;
      }
      for (const h of r.hits || []) {
        if (index.startsWith("all_scenes") && h.clip_id) data.scenes[h.clip_id] = h;
        else if (index.startsWith("all_series") && h.serie_id) {
          data.series[h.serie_id] = h;
          GAMMA.cacheSerie(h);
        } else if (index.startsWith("all_movies") && h.movie_id) data.movies[h.movie_id] = h;
        else if (index.startsWith("all_photosets") && h.set_id) data.photosets[h.set_id] = h;
      }
    }
  },

  // series are only listed on the Shows page, so remember them across pages
  cacheSerie(h) {
    const cache = GM_getValue("series", {});
    cache[h.serie_id] = {
      serie_id: h.serie_id,
      title: h.title,
      description: h.description,
      categories: h.categories,
      multicontent_data: h.multicontent_data,
      first_clip: h.first_clip,
    };
    GM_setValue("series", cache);
  },

  serie(data, id) {
    return (data.series && data.series[id]) || GM_getValue("series", {})[id] || null;
  },

  // "2160p" -> 2160, "4k" -> 2160
  resValue(r) {
    if (/4k/i.test(r)) return 2160;
    const m = /(\d+)p/i.exec(r);
    return m ? +m[1] : 0;
  },

  bestResolution(hit) {
    const sizes = Object.keys(hit.download_file_sizes || {});
    const list = sizes.length ? sizes : hit.download_sizes || [];
    return list.slice().sort((a, b) => GAMMA.resValue(b) - GAMMA.resValue(a))[0] || null;
  },

  memberDownloadUrl(hit) {
    const res = GAMMA.bestResolution(hit);
    if (!res) return null;
    return `${location.origin}/movieaction/download/${hit.clip_id}/${res}/mp4?codec=h264`;
  },

  // largest image from a record's multicontent_data, optionally preferring some names
  mediaImage(rec, prefer) {
    const list = ((rec && rec.multicontent_data && rec.multicontent_data.nsfw) || []).map((i) => ({
      url: "https://transform.gammacdn.com/media/" + i.file,
      width: +i.width,
      height: +i.height,
      name: i.name,
    }));
    const preferred = prefer ? list.filter((i) => prefer.includes(i.name)) : [];
    const pick = (arr) => arr.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    return (pick(preferred) || pick(list) || {}).url || null;
  },

  // one URL, or a list of URLs to try in order
  sceneImage(hit) {
    const media = GAMMA.mediaImage(hit, ["contentHero"]);
    if (media) return media;
    // older scenes: pictures {"960x544": "/68747/68747_01/previews/2/239/top_1_960x544/68747_01_01.jpg", ...}
    const area = (k) => k.split("x").reduce((a, b) => a * b, 1);
    const pics = hit.pictures || {};
    const path = Object.entries(pics)
      .filter(([k, v]) => /^\d+x\d+$/.test(k) && typeof v === "string")
      .sort((a, b) => area(b[0]) - area(a[0]))
      .map(([, v]) => v)[0];
    if (!path) return null;
    // the sites request the 1920x1080 rendition of these previews, but older scenes
    // lack it, so also offer the largest listed size (the downloader tries in order)
    const base = "https://transform.gammacdn.com/movies";
    return [base + path.replace(/\/top_1_\d+x\d+\//, "/top_1_1920x1080/"), base + path];
  },

  names(list) {
    return (list || []).map((x) => x && x.name).filter(Boolean);
  },

  // resolve every scene item's member download link into a signed media URL;
  // callers drop already-known items first so no links are resolved for them
  async resolveItems(items, ctx) {
    let n = 0;
    for (const it of items) {
      n += 1;
      ctx.setStatus(`Resolving download links ${n}/${items.length}…`);
      it.media.url = await ctx.resolveRedirect(it.media.resolve);
    }
  },
};
