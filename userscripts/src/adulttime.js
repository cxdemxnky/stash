// ---- AdultTime ----
// Videos are Gamma scenes; the Stash studio is the scene's channel/studio and every
// performer is tagged. Each video's photo gallery is downloaded too: the site's own
// "Download Gallery" button is clicked (in a hidden frame) so the browser saves the
// full-size zip, and the downloader picks it up from the browser's download folder.
const SITE = {
  name: "AdultTime",
  captureUrl: GAMMA.captureUrl,
  onCapture: GAMMA.onCapture,

  videoPath(hit) {
    return `/en/video/${hit.sitename}/${hit.url_title}/${hit.clip_id}`;
  },

  galleryPath(set) {
    return `/en/picture/${set.url_title}/${set.set_id}`;
  },

  // zips are named after the picture files: "/190655/previews/190655_1.jpg" -> 190655
  zipId(set) {
    return (/^\/?(\d+)\//.exec((set && set.picture) || "") || [])[1] || null;
  },

  // same number from a gallery page's images: .../photo_set/190655/190655_001.jpg
  zipIdFromDoc(doc) {
    for (const img of (doc && doc.images) || []) {
      const m = /\/photo_set\/(\d+)\//.exec(img.currentSrc || img.src || "");
      if (m) return m[1];
    }
    return null;
  },

  cards(data) {
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/video/"], a[href*="/picture/"]')) {
      if (!a.querySelector("img")) continue;
      const href = a.getAttribute("href");
      const video = /\/video\/[^/]+\/[^/]+\/(\d+)\/?$/.exec(href);
      const picture = /\/picture\/[^/]+\/(\d+)\/?$/.exec(href);
      if (video && data.scenes[video[1]]) {
        const hit = data.scenes[video[1]];
        out.push({ el: a, key: "clip:" + hit.clip_id, kind: "scene", url: location.origin + SITE.videoPath(hit) });
      } else if (picture && data.photosets[picture[1]]) {
        const set = data.photosets[picture[1]];
        out.push({ el: a, key: "set:" + set.set_id, kind: "gallery", url: location.origin + SITE.galleryPath(set) });
      }
    }
    return out;
  },

  sceneItem(hit) {
    const resolve = GAMMA.memberDownloadUrl(hit);
    if (!resolve) return null;
    return {
      kind: "scene",
      url: location.origin + SITE.videoPath(hit),
      title: hit.title,
      studio: hit.studio_name || hit.sitename_pretty,
      date: hit.release_date,
      details: hit.description,
      performers: GAMMA.names(hit.actors),
      tags: GAMMA.names(hit.categories),
      image: GAMMA.sceneImage(hit),
      media: { resolve },
    };
  },

  // set may be missing when the gallery page's data wasn't captured; fall back to the video's
  galleryItem(set, scene, path, zipId) {
    return {
      kind: "gallery",
      url: location.origin + path,
      title: (set && set.title) || (scene && (scene.photoset_name || scene.title)),
      studio: scene ? scene.studio_name || scene.sitename_pretty : null,
      date: (set && set.date_online) || (scene && scene.release_date),
      details: (set && set.description) || null,
      performers: GAMMA.names((set && set.actors) || (scene && scene.actors)),
      tags: GAMMA.names((set && set.categories) || (scene && scene.categories)),
      zip_id: zipId,
      scene_url: scene ? location.origin + SITE.videoPath(scene) : null,
    };
  },

  findDownloadButton(doc) {
    return doc && [...doc.querySelectorAll("button")].find((b) => /download gallery/i.test(b.textContent));
  },

  // Make the browser download a gallery's zip by clicking the site's own button,
  // here if we're on that gallery's page, otherwise in a hidden frame.
  // Returns the zip's number, or null if the button couldn't be clicked.
  async triggerGalleryZip(setId, path, data, ctx) {
    const zipOf = (doc) => SITE.zipId(data.photosets[setId]) || SITE.zipIdFromDoc(doc);
    const here = location.pathname.endsWith("/" + setId) && SITE.findDownloadButton(document);
    if (here) {
      here.click();
      return zipOf(document);
    }
    let zip = null;
    const ok = await ctx.loadInFrame(
      path,
      (doc) => !!(SITE.findDownloadButton(doc) && zipOf(doc)),
      30000,
      (doc) => {
        zip = zipOf(doc);
        SITE.findDownloadButton(doc).click();
      },
      8000 // keep the frame until the download has started
    );
    return ok ? zip : null;
  },

  // keys: "clip:<id>" (video + its gallery) or "set:<id>" (gallery only)
  async buildJobs(keys, data, ctx) {
    const scenes = [];
    let galleries = []; // [{setId, path, scene}]
    for (const key of keys) {
      const [type, id] = key.split(":");
      if (type === "clip" && data.scenes[id]) {
        const hit = data.scenes[id];
        scenes.push(hit);
        if (hit.photoset_id && hit.photoset_url_name) {
          galleries.push({ setId: String(hit.photoset_id), path: `/en/picture/${hit.photoset_url_name}/${hit.photoset_id}`, scene: hit });
        }
      } else if (type === "set" && data.photosets[id]) {
        const set = data.photosets[id];
        const scene = set.clip_id ? data.scenes[set.clip_id] : null;
        galleries.push({ setId: String(id), path: SITE.galleryPath(set), scene });
      } else if (type === "set") {
        // gallery page whose own record wasn't captured
        galleries.push({ setId: String(id), path: location.pathname, scene: null });
      }
    }

    const items = await ctx.dropKnown(SITE.name, scenes.map(SITE.sceneItem).filter(Boolean));
    await GAMMA.resolveItems(items, ctx);

    // don't make the browser download zips for galleries we already have
    const fresh = new Set(
      (await ctx.dropKnown(SITE.name, galleries.map((g) => ({ kind: "gallery", url: location.origin + g.path })))).map((g) => g.url)
    );
    galleries = galleries.filter((g) => fresh.has(location.origin + g.path));

    // queue the galleries before the zips arrive so the downloader can match them
    const galleryItems = [];
    for (const [i, g] of galleries.entries()) {
      ctx.setStatus(`Starting gallery download ${i + 1}/${galleries.length}…`);
      const zip = await SITE.triggerGalleryZip(g.setId, g.path, data, ctx);
      if (zip) galleryItems.push(SITE.galleryItem(data.photosets[g.setId], g.scene, g.path, zip));
      else console.warn("[stash-dl] gallery download failed", g.path);
    }
    return [{ site: SITE.name, items: items.concat(galleryItems) }];
  },

  pageActions(data) {
    const video = (/\/video\/[^/]+\/[^/]+\/(\d+)/.exec(location.pathname) || [])[1];
    if (video && data.scenes[video]) {
      return [{ label: "Download this video + gallery", run: (ctx) => SITE.buildJobs(["clip:" + video], data, ctx) }];
    }
    const set = (/\/picture\/[^/]+\/(\d+)/.exec(location.pathname) || [])[1];
    if (set) {
      return [{ label: "Download this gallery", run: (ctx) => SITE.buildJobs(["set:" + set], data, ctx) }];
    }
    return [];
  },
};
