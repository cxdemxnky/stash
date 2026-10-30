// "Slideshow" page at /slideshow: full-screen image slideshow with Ken Burns
// movement, transitions, captions (font, blend mode, position) and filters by tag
// and orientation. /slideshow?gallery=<id> or ?performer=<id> plays just that
// gallery or performer instead (linked from buttons on their pages). Settings are
// kept per browser in localStorage.
(function () {
  const { React, libraries } = window.PluginApi;
  const { Link, useHistory, useLocation } = libraries.ReactRouterDOM;
  const { FontAwesomeIcon } = libraries.ReactFontAwesome;
  const { faImages } = libraries.FontAwesomeSolid;
  const { Nav, Button } = libraries.Bootstrap;
  const h = React.createElement;

  const STORAGE_KEY = "slideshow-settings";
  const PAGE_SIZE = 200;

  // family names match the @font-face rules in slideshow.css
  const FONTS = [
    { id: "anton", label: "Anton", css: '"SS Anton", Impact, sans-serif', upper: true },
    { id: "archivo", label: "Archivo Black", css: '"SS Archivo Black", "Arial Black", sans-serif' },
    { id: "alfa", label: "Alfa Slab One", css: '"SS Alfa Slab One", Rockwell, serif' },
    { id: "bungee", label: "Bungee", css: '"SS Bungee", "Arial Black", sans-serif', upper: true },
    { id: "lilita", label: "Lilita One", css: '"SS Lilita One", "Arial Black", sans-serif' },
    { id: "titan", label: "Titan One", css: '"SS Titan One", "Arial Black", sans-serif' },
    { id: "rubik", label: "Rubik Black", css: '"SS Rubik", "Arial Black", sans-serif', weight: 900 },
    { id: "montserrat", label: "Montserrat Black", css: '"SS Montserrat", "Arial Black", sans-serif', weight: 900 },
    { id: "impact", label: "Impact (system)", css: 'Impact, "Anton", "Arial Narrow Bold", sans-serif' },
  ];

  const BLEND_MODES = [
    "normal", "difference", "exclusion", "overlay", "screen", "multiply", "soft-light",
    "hard-light", "color-dodge", "color-burn", "lighten", "darken", "luminosity",
  ];

  const CAPTION_SOURCES = [
    ["none", "None"],
    ["title", "Title (or file name)"],
    ["performers", "Performers"],
    ["tags", "Tags"],
    ["gallery", "Gallery"],
    ["studio", "Studio"],
    ["date", "Date"],
    ["filename", "File name"],
    ["custom", "Custom text"],
  ];

  const POSITIONS = [
    "top-left", "top-center", "top-right",
    "middle-left", "middle-center", "middle-right",
    "bottom-left", "bottom-center", "bottom-right",
  ];

  // the parallax service's render.js has the same fonts, blend modes and positions (its captions look the same)
  window.SlideshowCaptions = { FONTS, BLEND_MODES, POSITIONS };

  const DEFAULTS = {
    includeTags: [],
    excludeTags: [],
    tagMode: "INCLUDES",
    subTags: true,
    orientation: "any",
    order: "random",
    galleryOrder: "gallery",
    interval: 7,
    transition: "fade",
    transitionTime: 1.2,
    movement: "kenburns",
    intensity: 2,
    caption: true,
    line1: "title",
    line2: "performers",
    customText: "",
    font: "anton",
    captionSize: 6,
    captionColor: "#ffffff",
    blend: "normal",
    captionStyle: "shadow",
    position: "bottom-left",
    uppercase: true,
    captionMotion: "rise",
  };

  function loadSettings() {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
    } catch (e) {
      return { ...DEFAULTS };
    }
  }

  function saveSettings(s) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch (e) {
      // private mode / blocked storage: settings just won't persist
    }
  }

  async function gql(query, variables) {
    const res = await fetch(new URL("graphql", document.baseURI), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json();
    if (body.errors) throw new Error(body.errors.map((e) => e.message).join("; "));
    return body.data;
  }

  const IMAGES_QUERY = `query SlideshowImages($filter: FindFilterType, $image_filter: ImageFilterType) {
    findImages(filter: $filter, image_filter: $image_filter) {
      count
      images {
        id title date
        paths { image }
        galleries { title files { path } folder { path } }
        studio { name }
        performers { name }
        tags { name }
        visual_files {
          __typename
          ... on ImageFile { path width height }
          ... on VideoFile { path width height }
        }
      }
    }
  }`;

  const TAGS_QUERY = `{ findTags(filter: { per_page: -1, sort: "name", direction: ASC }) {
    tags { id name image_count gallery_count }
  } }`;

  function screenOrientation() {
    return window.innerWidth >= window.innerHeight ? "LANDSCAPE" : "PORTRAIT";
  }

  // A tag matches when it is on the image or on one of its galleries. Stash
  // allows one AND/OR/NOT per filter level, so the conditions are chained:
  //   orientation AND NOT (image has excluded OR gallery has excluded OR NOT included)
  // where included = gallery has tags OR image has tags.
  // Stash's image-level INCLUDES_ALL returns nothing inside an OR, so "all tags on
  // the image" is a chain of single-tag ANDs instead.
  // scope = { kind: "gallery" | "performer", id } replaces the tag and orientation
  // filters. A performer matches when on the image or on one of its galleries.
  function imageFilter(s, screen, scope) {
    if (scope && scope.kind === "gallery") return { galleries: { value: [scope.id], modifier: "INCLUDES" } };
    if (scope && scope.kind === "performer") {
      const p = { value: [scope.id], modifier: "INCLUDES" };
      return { performers: p, OR: { galleries_filter: { performers: p } } };
    }
    const f = {};
    const depth = s.subTags ? -1 : 0;
    let imageHas = null;
    if (s.tagMode === "INCLUDES_ALL") {
      s.includeTags
        .slice()
        .reverse()
        .forEach((id) => {
          const level = { tags: { value: [id], modifier: "INCLUDES", depth } };
          if (imageHas) level.AND = imageHas;
          imageHas = level;
        });
    } else if (s.includeTags.length) {
      imageHas = { tags: { value: s.includeTags, modifier: "INCLUDES", depth } };
    }
    const included = imageHas
      ? { galleries_filter: { tags: { value: s.includeTags, modifier: s.tagMode, depth } }, OR: imageHas }
      : null;
    if (s.excludeTags.length) {
      const excl = { value: s.excludeTags, modifier: "INCLUDES", depth };
      const galleryExcl = { galleries_filter: { tags: excl } };
      if (included) galleryExcl.OR = { NOT: included };
      f.NOT = { tags: excl, OR: galleryExcl };
    } else if (included) {
      f.AND = included;
    }
    if (s.orientation === "screen") f.orientation = { value: [screen, "SQUARE"] };
    else if (s.orientation !== "any") f.orientation = { value: [s.orientation] };
    return f;
  }

  // "gallery" is Stash's own order for gallery images (by file path)
  function findFilter(order, page, seed) {
    const sort = {
      random: `random_${seed}`, gallery: "path", newest: "created_at", oldest: "created_at", title: "title", date: "date",
    }[order];
    const direction = order === "newest" || order === "date" ? "DESC" : "ASC";
    return { page, per_page: PAGE_SIZE, sort, direction };
  }

  function basename(p) {
    return (p || "").split(/[\\/]/).pop();
  }

  function fileName(img) {
    return basename(img.visual_files[0]?.path).replace(/\.[^.]+$/, "");
  }

  function captionText(img, source, custom) {
    switch (source) {
      case "title":
        return img.title || fileName(img);
      case "filename":
        return fileName(img);
      case "performers":
        return img.performers.map((p) => p.name).join(" & ");
      case "tags":
        return img.tags.map((t) => t.name).join(" · ");
      case "gallery": {
        const g = img.galleries[0];
        if (!g) return "";
        return g.title || basename(g.files[0]?.path || g.folder?.path).replace(/\.[^.]+$/, "");
      }
      case "studio":
        return img.studio?.name || "";
      case "date":
        if (!img.date) return "";
        return new Date(img.date + "T00:00:00").toLocaleDateString(undefined, {
          year: "numeric", month: "long", day: "numeric",
        });
      case "custom":
        return custom;
      default:
        return "";
    }
  }

  // ---------------------------------------------------------------- movement

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }

  function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  // Start/end transforms for one slide's movement. Translations are in % of the
  // image box, so they never pan past the zoomed-in margin.
  function movementKeyframes(kind, intensity) {
    const z = 0.06 * intensity; // extra zoom
    const t = (z / 2) * 100 * 0.9; // max pan (%) that stays within the zoom margin
    const tf = (s, x, y, r) => `scale(${s}) translate(${x}%, ${y}%) rotate(${r || 0}deg)`;
    switch (kind) {
      case "zoom-in":
        return [tf(1, 0, 0), tf(1 + z, rand(-t, t) / 2, rand(-t, t) / 2)];
      case "zoom-out":
        return [tf(1 + z, rand(-t, t) / 2, rand(-t, t) / 2), tf(1, 0, 0)];
      case "pan": {
        const horizontal = Math.random() < 0.5;
        const d = pick([-1, 1]) * t;
        return horizontal
          ? [tf(1 + z, -d, 0), tf(1 + z, d, 0)]
          : [tf(1 + z, 0, -d), tf(1 + z, 0, d)];
      }
      case "drift": {
        const r = pick([-1, 1]) * 0.6 * intensity;
        return [tf(1 + z / 2, rand(-t, t) / 3, rand(-t, t) / 3, -r / 2), tf(1 + z, rand(-t, t) / 3, rand(-t, t) / 3, r / 2)];
      }
      case "kenburns": {
        const a = tf(1 + rand(0, z / 3), rand(-t, t) / 3, rand(-t, t) / 3);
        const b = tf(1 + z, rand(-t, t), rand(-t, t));
        return Math.random() < 0.5 ? [a, b] : [b, a];
      }
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------- slide

  // always cropped to fill the screen (object-fit: cover in slideshow.css)
  function Media({ img, className }) {
    const vf = img.visual_files[0];
    const props = { className, src: img.paths.image, draggable: false };
    if (vf && vf.__typename === "VideoFile") {
      return h("video", { ...props, autoPlay: true, muted: true, loop: true, playsInline: true });
    }
    return h("img", { ...props, alt: "" });
  }

  function Slide({ slide, settings, playing, onAnimations }) {
    const moveRef = React.useRef(null);
    const enterRef = React.useRef(null);
    const anims = React.useRef([]);

    React.useEffect(() => {
      const list = [];
      const t = settings.transitionTime * 1000;
      if (enterRef.current && slide.enter && settings.transition !== "none") {
        const dir = slide.direction;
        const frames = {
          fade: [{ opacity: 0 }, { opacity: 1 }],
          slide: [{ transform: `translateX(${dir * 100}%)` }, { transform: "translateX(0)" }],
          zoom: [{ opacity: 0, transform: "scale(1.25)" }, { opacity: 1, transform: "scale(1)" }],
          blur: [{ opacity: 0, filter: "blur(30px)" }, { opacity: 1, filter: "blur(0)" }],
        }[settings.transition];
        if (frames) list.push(enterRef.current.animate(frames, { duration: t, easing: "ease-in-out", fill: "both" }));
      }
      const kf = movementKeyframes(settings.movement, settings.intensity);
      if (moveRef.current && kf) {
        list.push(
          moveRef.current.animate([{ transform: kf[0] }, { transform: kf[1] }], {
            duration: settings.interval * 1000 + t * 2,
            easing: "ease-in-out",
            fill: "both",
          })
        );
      }
      anims.current = list;
      onAnimations && onAnimations(slide.key, list);
      return () => list.forEach((a) => a.cancel());
      // settings are fixed for the lifetime of a slide
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [slide.key]);

    React.useEffect(() => {
      anims.current.forEach((a) => (playing ? a.play() : a.pause()));
    }, [playing]);

    return h(
      "div",
      { className: "ss-slide", ref: enterRef },
      h("div", { className: "ss-move", ref: moveRef }, h(Media, { img: slide.img, className: "ss-media" }))
    );
  }

  function Caption({ img, s, slideKey }) {
    if (!s.caption) return null;
    const l1 = captionText(img, s.line1, s.customText);
    const l2 = captionText(img, s.line2, s.customText);
    if (!l1 && !l2) return null;
    const font = FONTS.find((f) => f.id === s.font) || FONTS[0];
    const [v, hz] = s.position.split("-");
    return h(
      "div",
      {
        className: `ss-caption-wrap ss-v-${v} ss-h-${hz}`,
        style: { mixBlendMode: s.blend },
      },
      h(
        "div",
        {
          key: slideKey,
          className: `ss-caption ss-style-${s.captionStyle} ss-motion-${s.captionMotion}`,
          style: {
            fontFamily: font.css,
            fontWeight: font.weight || 400,
            color: s.captionColor,
            fontSize: `${s.captionSize}vmin`,
            textTransform: s.uppercase ? "uppercase" : "none",
            textAlign: hz === "center" ? "center" : hz,
            animationDuration: `${Math.max(0.4, s.transitionTime)}s`,
          },
        },
        l1 && h("div", { className: "ss-line1" }, l1),
        l2 && h("div", { className: "ss-line2" }, l2)
      )
    );
  }

  // ---------------------------------------------------------------- settings panel

  function Field({ label, children }) {
    return h("label", { className: "ss-field" }, h("span", { className: "ss-label" }, label), children);
  }

  function Select({ value, onChange, options }) {
    return h(
      "select",
      { className: "ss-input", value, onChange: (e) => onChange(e.target.value) },
      options.map(([v, l]) => h("option", { key: v, value: v }, l))
    );
  }

  function Range({ value, onChange, min, max, step, unit }) {
    return h(
      "span",
      { className: "ss-range" },
      h("input", {
        type: "range", min, max, step, value,
        onChange: (e) => onChange(Number(e.target.value)),
      }),
      h("span", { className: "ss-range-value" }, `${value}${unit || ""}`)
    );
  }

  // Tag chips cycle: off -> include -> exclude -> off.
  function TagPicker({ s, set }) {
    const [tags, setTags] = React.useState(null);
    const [q, setQ] = React.useState("");
    React.useEffect(() => {
      gql(TAGS_QUERY).then(
        (d) => setTags(d.findTags.tags.filter((t) => t.image_count > 0 || t.gallery_count > 0)),
        () => setTags([])
      );
    }, []);

    function cycle(id) {
      const inc = s.includeTags.includes(id);
      const exc = s.excludeTags.includes(id);
      if (!inc && !exc) set({ includeTags: [...s.includeTags, id] });
      else if (inc) set({ includeTags: s.includeTags.filter((x) => x !== id), excludeTags: [...s.excludeTags, id] });
      else set({ excludeTags: s.excludeTags.filter((x) => x !== id) });
    }

    if (!tags) return h("div", { className: "ss-muted" }, "Loading tags…");
    if (!tags.length) return h("div", { className: "ss-muted" }, "No tagged images or galleries yet.");
    const needle = q.trim().toLowerCase();
    const shown = tags.filter(
      (t) => !needle || t.name.toLowerCase().includes(needle) || s.includeTags.includes(t.id) || s.excludeTags.includes(t.id)
    );
    return h(
      "div",
      null,
      h(
        "div",
        { className: "ss-row" },
        h("input", { className: "ss-input", placeholder: "Search tags…", value: q, onChange: (e) => setQ(e.target.value) }),
        (s.includeTags.length > 0 || s.excludeTags.length > 0) &&
          h("button", { className: "ss-link", onClick: () => set({ includeTags: [], excludeTags: [] }) }, "Clear")
      ),
      h(
        "div",
        { className: "ss-chips" },
        shown.map((t) => {
          const state = s.includeTags.includes(t.id) ? "include" : s.excludeTags.includes(t.id) ? "exclude" : "off";
          return h(
            "button",
            {
              key: t.id,
              className: `ss-chip ss-chip-${state}`,
              onClick: () => cycle(t.id),
              title: "Click: include → exclude → off",
            },
            state === "include" ? "+ " : state === "exclude" ? "− " : "",
            t.name,
            h(
              "span",
              { className: "ss-chip-count", title: `${t.image_count} images, ${t.gallery_count} galleries` },
              t.image_count ? t.image_count : `${t.gallery_count}g`
            )
          );
        })
      ),
      h(
        "div",
        { className: "ss-row ss-small" },
        h(Select, {
          value: s.tagMode,
          onChange: (v) => set({ tagMode: v }),
          options: [["INCLUDES", "Match any included tag"], ["INCLUDES_ALL", "Match all (on image or on gallery)"]],
        }),
        h(
          "label",
          { className: "ss-check" },
          h("input", { type: "checkbox", checked: s.subTags, onChange: (e) => set({ subTags: e.target.checked }) }),
          " Include sub-tags"
        )
      )
    );
  }

  function SettingsPanel({ s, set, count, scope, onClose }) {
    const gallery = scope && scope.kind === "gallery";
    return h(
      "div",
      { className: "ss-panel", onClick: (e) => e.stopPropagation() },
      h(
        "div",
        { className: "ss-panel-head" },
        h("h2", null, "Slideshow"),
        h("span", { className: "ss-muted" }, count == null ? "" : `${count} image${count === 1 ? "" : "s"}`),
        h("button", { className: "ss-close", onClick: onClose, title: "Close settings (S)" }, "×")
      ),

      h("h3", null, "Images"),
      scope
        ? h(
            "div",
            { className: "ss-field" },
            h(
              "div",
              null,
              gallery ? "Gallery: " : "Performer: ",
              h(Link, { to: `/${gallery ? "galleries" : "performers"}/${scope.id}` }, scope.name || `#${scope.id}`)
            ),
            h(Link, { to: "/slideshow", className: "ss-link" }, "Play all images instead")
          )
        : h(React.Fragment, null, h(TagPicker, { s, set }), h(Field, { label: "Orientation" },
        h(Select, {
          value: s.orientation,
          onChange: (v) => set({ orientation: v }),
          options: [
            ["any", "Any"],
            ["screen", "Match screen (" + screenOrientation().toLowerCase() + ")"],
            ["LANDSCAPE", "Landscape"],
            ["PORTRAIT", "Portrait"],
            ["SQUARE", "Square"],
          ],
        }))),
      h(Field, { label: "Order" },
        h(Select, {
          value: gallery ? s.galleryOrder : s.order,
          onChange: (v) => set(gallery ? { galleryOrder: v } : { order: v }),
          options: [["gallery", gallery ? "Gallery order" : "By gallery"]].concat([
            ["random", "Shuffle"], ["newest", "Newest added"], ["oldest", "Oldest added"], ["date", "Date"], ["title", "Title"],
          ]),
        })),

      h("h3", null, "Movement"),
      h(Field, { label: "Seconds per image" }, h(Range, { value: s.interval, onChange: (v) => set({ interval: v }), min: 2, max: 30, step: 1, unit: "s" })),
      h(Field, { label: "Movement" },
        h(Select, {
          value: s.movement,
          onChange: (v) => set({ movement: v }),
          options: [["kenburns", "Ken Burns (zoom + pan)"], ["zoom-in", "Zoom in"], ["zoom-out", "Zoom out"], ["pan", "Pan"], ["drift", "Drift (with tilt)"], ["none", "None"]],
        })),
      h(Field, { label: "Intensity" }, h(Range, { value: s.intensity, onChange: (v) => set({ intensity: v }), min: 1, max: 5, step: 1 })),
      h(Field, { label: "Transition" },
        h(Select, {
          value: s.transition,
          onChange: (v) => set({ transition: v }),
          options: [["fade", "Crossfade"], ["slide", "Slide"], ["zoom", "Zoom"], ["blur", "Blur"], ["none", "Cut"]],
        })),
      h(Field, { label: "Transition time" }, h(Range, { value: s.transitionTime, onChange: (v) => set({ transitionTime: v }), min: 0.2, max: 4, step: 0.1, unit: "s" })),

      h("h3", null,
        h("label", { className: "ss-check" },
          h("input", { type: "checkbox", checked: s.caption, onChange: (e) => set({ caption: e.target.checked }) }),
          " Captions")),
      s.caption &&
        h(
          React.Fragment,
          null,
          h(Field, { label: "Line 1" }, h(Select, { value: s.line1, onChange: (v) => set({ line1: v }), options: CAPTION_SOURCES })),
          h(Field, { label: "Line 2" }, h(Select, { value: s.line2, onChange: (v) => set({ line2: v }), options: CAPTION_SOURCES })),
          (s.line1 === "custom" || s.line2 === "custom") &&
            h(Field, { label: "Custom text" },
              h("input", { className: "ss-input", value: s.customText, onChange: (e) => set({ customText: e.target.value }) })),
          h(Field, { label: "Font" },
            h(
              "div",
              { className: "ss-fonts" },
              FONTS.map((f) =>
                h(
                  "button",
                  {
                    key: f.id,
                    className: "ss-font" + (s.font === f.id ? " active" : ""),
                    style: { fontFamily: f.css, fontWeight: f.weight || 400 },
                    onClick: () => set({ font: f.id }),
                  },
                  f.label
                )
              )
            )),
          h(Field, { label: "Size" }, h(Range, { value: s.captionSize, onChange: (v) => set({ captionSize: v }), min: 2, max: 20, step: 0.5 })),
          h(Field, { label: "Colour" },
            h("span", { className: "ss-row" },
              h("input", { type: "color", value: s.captionColor, onChange: (e) => set({ captionColor: e.target.value }) }),
              ["#ffffff", "#000000", "#ffd400", "#ff2d6f", "#00e5ff"].map((c) =>
                h("button", { key: c, className: "ss-swatch", style: { background: c }, onClick: () => set({ captionColor: c }), title: c })
              ))),
          h(Field, { label: "Blend mode" },
            h(Select, { value: s.blend, onChange: (v) => set({ blend: v }), options: BLEND_MODES.map((b) => [b, b]) })),
          h(Field, { label: "Style" },
            h(Select, {
              value: s.captionStyle,
              onChange: (v) => set({ captionStyle: v }),
              options: [["shadow", "Drop shadow"], ["outline", "Outline"], ["box", "Solid box"], ["plain", "Plain"]],
            })),
          h(Field, { label: "Position" },
            h(
              "div",
              { className: "ss-positions" },
              POSITIONS.map((p) =>
                h("button", {
                  key: p,
                  className: "ss-pos" + (s.position === p ? " active" : ""),
                  onClick: () => set({ position: p }),
                  title: p.replace("-", " "),
                })
              )
            )),
          h(Field, { label: "Animation" },
            h(Select, {
              value: s.captionMotion,
              onChange: (v) => set({ captionMotion: v }),
              options: [["rise", "Rise"], ["fade", "Fade"], ["slide", "Slide in"], ["pop", "Pop"], ["none", "None"]],
            })),
          h("label", { className: "ss-check ss-field" },
            h("input", { type: "checkbox", checked: s.uppercase, onChange: (e) => set({ uppercase: e.target.checked }) }),
            " Uppercase")
        ),
      h("div", { className: "ss-panel-foot ss-muted" },
        "Keys: Space pause · ←/→ previous/next · F full screen · S settings · Esc close"),
      h("button", { className: "ss-link", onClick: () => set({ ...DEFAULTS }) }, "Reset to defaults")
    );
  }

  // ---------------------------------------------------------------- slideshow

  function useImages(s, scope) {
    const [screen, setScreen] = React.useState(screenOrientation());
    const [state, setState] = React.useState({ images: [], count: null, error: null, done: false });
    const seed = React.useRef(Math.floor(Math.random() * 1e8));
    const page = React.useRef(0);
    const loading = React.useRef(false);
    const request = React.useRef(0); // responses for an older filter are dropped
    const order = scope && scope.kind === "gallery" ? s.galleryOrder : s.order;
    const filterKey = JSON.stringify([imageFilter(s, screen, scope), order]);

    React.useEffect(() => {
      if (s.orientation !== "screen") return;
      const onResize = () => setScreen(screenOrientation());
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }, [s.orientation]);

    const loadMore = React.useCallback(
      (reset) => {
        if (loading.current && !reset) return;
        loading.current = true;
        if (reset) request.current++;
        const id = request.current;
        const next = reset ? 1 : page.current + 1;
        gql(IMAGES_QUERY, { filter: findFilter(order, next, seed.current), image_filter: imageFilter(s, screen, scope) }).then(
          (d) => {
            if (id !== request.current) return;
            page.current = next;
            loading.current = false;
            const got = d.findImages.images;
            setState((prev) => {
              const images = reset ? got : prev.images.concat(got);
              return { images, count: d.findImages.count, error: null, done: images.length >= d.findImages.count };
            });
          },
          (e) => {
            if (id !== request.current) return;
            loading.current = false;
            setState((prev) => ({ ...prev, error: e.message }));
          }
        );
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [filterKey]
    );

    React.useEffect(() => {
      seed.current = Math.floor(Math.random() * 1e8);
      setState({ images: [], count: null, error: null, done: false });
      loadMore(true);
    }, [loadMore]);

    return { ...state, loadMore };
  }

  function Slideshow() {
    const history = useHistory();
    const [s, setS] = React.useState(loadSettings);
    const set = React.useCallback((patch) => setS((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    }), []);
    const params = new URLSearchParams(useLocation().search);
    const scopeKind = params.has("gallery") ? "gallery" : params.has("performer") ? "performer" : null;
    const scopeId = scopeKind && params.get(scopeKind);
    // memoised so the image loader only refetches when the scope really changes
    const scope = React.useMemo(() => scopeKind && { kind: scopeKind, id: scopeId }, [scopeKind, scopeId]);
    const [scopeName, setScopeName] = React.useState(null);
    React.useEffect(() => {
      setScopeName(null);
      if (scopeKind === "gallery")
        gql("query($id: ID!) { findGallery(id: $id) { title folder { path } files { path } } }", { id: scopeId }).then(
          (d) => {
            const g = d.findGallery;
            if (g) setScopeName(g.title || basename(g.files[0]?.path || g.folder?.path));
          },
          () => {}
        );
      else if (scopeKind === "performer")
        gql("query($id: ID!) { findPerformer(id: $id) { name } }", { id: scopeId }).then(
          (d) => d.findPerformer && setScopeName(d.findPerformer.name),
          () => {}
        );
    }, [scopeKind, scopeId]);
    const { images, count, error, done, loadMore } = useImages(s, scope);
    const [index, setIndex] = React.useState(0);
    const [playing, setPlaying] = React.useState(true);
    const [panel, setPanel] = React.useState(false);
    const [idle, setIdle] = React.useState(false);
    const [slides, setSlides] = React.useState([]);
    const keyCounter = React.useRef(0);
    const stageRef = React.useRef(null);

    // restart from the first image whenever the filter changes
    React.useEffect(() => setIndex(0), [images.length === 0]);

    const go = React.useCallback(
      (delta) => {
        if (!images.length) return;
        setIndex((i) => {
          let n = i + delta;
          if (n >= images.length) n = done ? 0 : images.length - 1;
          if (n < 0) n = done ? images.length - 1 : 0;
          return n;
        });
      },
      [images.length, done]
    );
    const direction = React.useRef(1);
    const step = React.useCallback((d) => { direction.current = d; go(d); }, [go]);

    // fetch the next page before we run out
    React.useEffect(() => {
      if (!done && images.length && index >= images.length - 5) loadMore(false);
    }, [index, images.length, done, loadMore]);

    // push a new slide layer whenever the current image changes
    const current = images[index];
    const shownId = React.useRef(null);
    React.useEffect(() => {
      if (!current) {
        shownId.current = null;
        setSlides([]);
        return;
      }
      if (shownId.current === current.id) return;
      shownId.current = current.id;
      const key = ++keyCounter.current;
      setSlides((prev) => [...prev.slice(-1), { key, img: current, enter: prev.length > 0, direction: direction.current }]);
      const t = setTimeout(
        () => setSlides((prev) => prev.filter((sl) => sl.key >= key)),
        s.transitionTime * 1000 + 50
      );
      // preload the next image
      const nxt = images[index + 1];
      if (nxt && nxt.visual_files[0]?.__typename !== "VideoFile") new Image().src = nxt.paths.image;
      return () => clearTimeout(t);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [current && current.id, index]);

    // advance timer
    React.useEffect(() => {
      if (!playing || images.length < 2) return;
      const t = setTimeout(() => step(1), s.interval * 1000);
      return () => clearTimeout(t);
    }, [playing, index, images.length, s.interval, step]);

    // hide cursor and controls when the mouse rests
    React.useEffect(() => {
      let t;
      const wake = () => {
        setIdle(false);
        clearTimeout(t);
        t = setTimeout(() => setIdle(true), 2500);
      };
      wake();
      window.addEventListener("mousemove", wake);
      window.addEventListener("touchstart", wake);
      return () => {
        clearTimeout(t);
        window.removeEventListener("mousemove", wake);
        window.removeEventListener("touchstart", wake);
      };
    }, []);

    function toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else stageRef.current && stageRef.current.requestFullscreen && stageRef.current.requestFullscreen();
    }

    function close() {
      if (document.fullscreenElement) document.exitFullscreen();
      if (history.length > 1) history.goBack();
      else history.push("/images");
    }

    React.useEffect(() => {
      function onKey(e) {
        if (e.target.matches && e.target.matches("input, select, textarea")) return;
        if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); }
        else if (e.key === "ArrowRight") step(1);
        else if (e.key === "ArrowLeft") step(-1);
        else if (e.key === "f" || e.key === "F") toggleFullscreen();
        else if (e.key === "s" || e.key === "S") setPanel((p) => !p);
        else if (e.key === "Escape") {
          if (panel) setPanel(false);
          else if (!document.fullscreenElement) close();
        } else return;
        e.stopPropagation();
      }
      window.addEventListener("keydown", onKey, true);
      return () => window.removeEventListener("keydown", onKey, true);
    });

    // touch swipe
    const touch = React.useRef(null);

    let message = null;
    if (error) message = `Couldn't load images: ${error}`;
    else if (count === 0) message = "No images match these filters.";
    else if (count == null) message = "Loading…";

    return h(
      "div",
      {
        className: "ss-root" + (idle && !panel ? " ss-idle" : ""),
        ref: stageRef,
        onTouchStart: (e) => (touch.current = e.touches[0].clientX),
        onTouchEnd: (e) => {
          if (touch.current == null) return;
          const dx = e.changedTouches[0].clientX - touch.current;
          if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
          touch.current = null;
        },
      },
      h(
        "div",
        { className: "ss-stage" },
        slides.map((sl) => h(Slide, { key: sl.key, slide: sl, settings: s, playing })),
        current && h(Caption, { img: current, s, slideKey: current.id + ":" + index })
      ),
      message && h("div", { className: "ss-message" }, message),
      h(
        "div",
        { className: "ss-controls" },
        h("button", { onClick: close, title: "Close (Esc)" }, "✕"),
        h("span", { className: "ss-spacer" }),
        h("button", { onClick: () => step(-1), title: "Previous (←)" }, "⏮︎"),
        h("button", { onClick: () => setPlaying((p) => !p), title: "Play/pause (Space)" }, playing ? "⏸︎" : "▶︎"),
        h("button", { onClick: () => step(1), title: "Next (→)" }, "⏭︎"),
        h("span", { className: "ss-counter" }, count ? `${index + 1} / ${count}` : ""),
        h("span", { className: "ss-spacer" }),
        current && h(Link, { to: `/images/${current.id}`, title: "Open image page", className: "ss-open" }, "↗︎"),
        h("button", { onClick: toggleFullscreen, title: "Full screen (F)" }, "⛶︎"),
        h("button", { onClick: () => setPanel((p) => !p), title: "Settings (S)" }, "⚙︎")
      ),
      panel && h("div", { className: "ss-panel-backdrop", onClick: () => setPanel(false) },
        h(SettingsPanel, { s, set, count, scope: scope && { ...scope, name: scopeName }, onClose: () => setPanel(false) }))
    );
  }

  window.PluginApi.register.route("/slideshow", Slideshow);

  let routerHistory = null;
  function HistoryGrabber() {
    routerHistory = useHistory();
    return null;
  }

  // add "Slideshow" to the main navbar, after the built-in items
  window.PluginApi.patch.before("MainNavBar.MenuItems", function (props) {
    const item = h(
      Nav.Link,
      { key: "slideshow", eventKey: "/slideshow", as: "div", className: "col-4 col-sm-3 col-md-2 col-lg-auto" },
      h(
        Link,
        { to: "/slideshow" },
        h(
          Button,
          {
            className:
              "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center",
          },
          h(FontAwesomeIcon, { icon: faImages, className: "nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0 mr-xl-1" }),
          h("span", null, "Slideshow")
        )
      )
    );
    return [{ ...props, children: h(React.Fragment, null, props.children, item, h(HistoryGrabber, { key: "slideshow-history" })) }];
  });

  // "Slideshow" buttons on gallery pages (toolbar) and performer pages (next to
  // the favourite icon); both render asynchronously, so watch the DOM for them
  const PLAY_ICON =
    '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 9l5 3-5 3z" fill="currentColor"/></svg>';

  const PAGE_BUTTONS = [
    {
      kind: "gallery",
      path: /\/galleries\/(\d+)(?:\/|$)/,
      title: "Play this gallery as a slideshow",
      mount(wrapper) {
        const groups = document.querySelectorAll(".gallery-toolbar .gallery-toolbar-group");
        const group = groups[groups.length - 1];
        if (!group) return false;
        group.insertBefore(wrapper, group.firstChild);
        return true;
      },
    },
    {
      kind: "performer",
      path: /\/performers\/(\d+)(?:\/|$)/,
      title: "Play this performer's images as a slideshow",
      mount(wrapper) {
        const icons = document.querySelector(".performer-head .name-icons");
        if (!icons) return false;
        icons.appendChild(wrapper);
        return true;
      },
    },
  ];

  function ensureButtons() {
    for (const b of PAGE_BUTTONS) {
      const id = `slideshow-${b.kind}-button`;
      const m = b.path.exec(window.location.pathname);
      const existing = document.getElementById(id);
      if (existing && (!m || existing.dataset.target !== m[1])) existing.parentNode.remove();
      else if (existing) continue;
      if (!m) continue;

      const wrapper = document.createElement("span");
      const button = document.createElement("button");
      button.id = id;
      button.type = "button";
      button.dataset.target = m[1];
      button.className = "minimal btn btn-secondary";
      button.title = b.title;
      button.innerHTML = PLAY_ICON;
      button.addEventListener("click", () => {
        const to = `/slideshow?${b.kind}=${m[1]}`;
        if (routerHistory) routerHistory.push(to);
        else window.location.href = new URL(to.slice(1), document.baseURI).href;
      });
      wrapper.appendChild(button);
      b.mount(wrapper);
    }
  }

  new MutationObserver(ensureButtons).observe(document.body, { childList: true, subtree: true });
  ensureButtons();
})();
