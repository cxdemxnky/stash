// Parallax Studio (/parallax): /parallax lists projects, /parallax/new?image=<id>
// or ?scene=<id>&t=<seconds>[&span=<seconds>&ai=<n>] starts one, /parallax/<id>
// is the studio. The studio itself is the parallax service's (ui/render.js,
// studio.js and parallax.css in /media/matt/WD/tmp/parallax, also used by its own
// web app on port 10143), fetched through the downloader (Stash's CSP only allows
// that port) and given a Stash host here. The downloader (parallax_service.py)
// relays the studio's API calls, names Stash stills by their files, and scans
// each export into Stash when the service calls back. Caption fonts come from the
// Slideshow plugin's stylesheet (the same families as the service's fonts.css).
(function () {
  const { React, libraries } = window.PluginApi;
  const { Link, useHistory, useLocation } = libraries.ReactRouterDOM;
  const h = React.createElement;

  // ---------------------------------------------------------------- backend

  let backendPromise = null;
  function backend() {
    if (!backendPromise) {
      backendPromise = fetch(new URL("graphql", document.baseURI), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ configuration { plugins } }" }),
      })
        .then((r) => r.json())
        .then((body) => {
          // the downloader address and token are the Downloads plugin's settings
          const cfg = (body.data && body.data.configuration.plugins && body.data.configuration.plugins.downloads) || {};
          const base = (cfg.downloader_url || `${location.protocol}//${location.hostname}:10141`).replace(/\/$/, "");
          return { base, token: cfg.token || "" };
        });
    }
    return backendPromise;
  }

  async function api(path, body, raw) {
    const { base, token } = await backend();
    const opts = body === undefined ? {} : {
      method: "POST",
      headers: raw ? { "X-Token": token } : { "Content-Type": "application/json", "X-Token": token },
      body: raw ? body : JSON.stringify(body),
    };
    const res = await fetch(`${base}/parallax/${path}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  // a link from the service ("{host}": this host) as a route in Stash when it's one
  function route(href) {
    const u = new URL(href.replace("{host}", location.hostname), location.href);
    return u.origin === location.origin ? u.pathname + u.search : u.href;
  }

  let routerHistory = null;

  const host = {
    api,
    fileUrl: async (rel) => `${(await backend()).base}/parallax/file/${rel}`,
    link: (href, props, ...children) => (href.startsWith("/")
      ? h(Link, { to: href, ...props }, ...children)
      : h("a", { href, target: "_blank", rel: "noreferrer", ...props }, ...children)),
    navigate: (href, replace) => (routerHistory ? routerHistory[replace ? "replace" : "push"](href) : (location.href = href)),
    href: {
      list: "/parallax",
      project: (id, job) => `/parallax/${id}${job ? `?job=${job}` : ""}`,
    },
    sourceLink: (p) => {
      const l = p.meta && p.meta.link;
      return l && l.href ? [route(l.href), l.text || "Source"] : null;
    },
    exportLink: (exp) => (exp && exp.link && exp.link.href ? [route(exp.link.href), exp.link.text || "Open scene"] : null),
    startHint: "Start a project from an image page or a paused scene with the Parallax button.",
    texts: {
      unreachable: "The downloader or the parallax service is unreachable",
      segmentMissing: "Needs the MobileSAM models in the parallax service's models folder",
    },
  };

  // ---------------------------------------------------------------- the shared studio

  let studioPromise = null;
  function loadStudio() {
    if (!studioPromise) {
      studioPromise = backend().then(async ({ base }) => {
        const get = async (name) => {
          const res = await fetch(`${base}/parallax/ui/${name}`);
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
          return res.text();
        };
        const [render, studio, css] = await Promise.all([get("render.js"), get("studio.js"), get("parallax.css")]);
        let style = document.getElementById("parallax-studio-css");
        if (!style) {
          style = document.createElement("style");
          style.id = "parallax-studio-css";
          document.head.appendChild(style);
        }
        style.textContent = css;
        for (const code of [render, studio]) {
          const script = document.createElement("script");
          script.textContent = code;
          document.head.appendChild(script);
        }
        return window.ParallaxStudio.create(React, host);
      });
      studioPromise.catch(() => { studioPromise = null; }); // try again next time
    }
    return studioPromise;
  }

  function ParallaxRoute() {
    routerHistory = useHistory();
    const loc = useLocation();
    const [mod, setMod] = React.useState(null);
    const [error, setError] = React.useState(null);
    React.useEffect(() => { loadStudio().then(setMod, (e) => setError(e.message)); }, []);
    if (error) return h("div", { className: "pxs-list" }, h("h1", null, "Parallax Studio"),
      h("div", { className: "pxs-warning" }, `The studio comes from the parallax service, which didn't answer: ${error}`));
    if (!mod) return h("div", { className: "pxs-list" }, "Loading…");
    const q = new URLSearchParams(loc.search);
    const m = /^\/parallax\/([a-f0-9]{12})/.exec(loc.pathname);
    if (m) return h(mod.Studio, { pid: m[1], job: q.get("job"), key: m[1] });
    if (/^\/parallax\/new/.test(loc.pathname)) {
      // a Stash still; the downloader turns it into the file's path
      const source = q.get("image")
        ? { kind: "image", id: Number(q.get("image")) }
        : { kind: "scene", id: Number(q.get("scene")), time: Number(q.get("t") || 0), ...(q.get("span") ? { span: Number(q.get("span")) } : {}) };
      return h(mod.NewProject, { source, ai: Number(q.get("ai") || 1), key: loc.search });
    }
    return h(mod.ProjectList);
  }

  window.PluginApi.register.route("/parallax", ParallaxRoute);
})();
