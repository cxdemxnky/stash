// "Shows" section: /shows lists groups tagged "Show"; /shows/<groupId> lists the
// group's scenes by season and episode. The downloader stores episodes as group
// scenes with scene_index = season * 1000 + episode and code "S01E02".
(function () {
  const { React, GQL, libraries } = window.PluginApi;
  const { Link, useLocation } = libraries.ReactRouterDOM;
  const { FontAwesomeIcon } = libraries.ReactFontAwesome;
  const { faTv, faEye } = libraries.FontAwesomeSolid;
  const { Nav, Button } = libraries.Bootstrap;
  const h = React.createElement;

  const SHOW_TAG = "Show";

  function useShowTagId() {
    const { data, loading } = GQL.useFindTagsQuery({
      variables: {
        filter: { per_page: 1 },
        tag_filter: { name: { value: SHOW_TAG, modifier: "EQUALS" } },
      },
    });
    return { loading, id: data?.findTags.tags[0]?.id };
  }

  function category(group) {
    const t = (group.tags || []).find((t) => t.name !== SHOW_TAG);
    return t ? t.name : "";
  }

  function episodeInfo(scene, groupId) {
    const g = scene.groups.find((g) => g.group.id === groupId);
    const idx = g?.scene_index ?? 0;
    const season = Math.floor(idx / 1000);
    const episode = idx % 1000;
    return { idx, season, episode };
  }

  function formatDuration(secs) {
    const m = Math.round((secs || 0) / 60);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
  }

  function ShowCard({ group }) {
    return h(
      Link,
      { to: `/shows/${group.id}`, className: "shows-card" },
      h("div", {
        className: "shows-card-image",
        style: { backgroundImage: `url("${group.front_image_path}")` },
      }),
      h(
        "div",
        { className: "shows-card-caption" },
        category(group) && h("div", { className: "shows-category" }, category(group)),
        h("div", { className: "shows-card-title" }, group.name)
      )
    );
  }

  function ShowList() {
    const tag = useShowTagId();
    const [sort, setSort] = React.useState("created_at");
    const [q, setQ] = React.useState("");
    const { data, loading } = GQL.useFindGroupsQuery({
      skip: !tag.id,
      variables: {
        filter: { per_page: -1, sort, direction: sort === "name" ? "ASC" : "DESC", q },
        group_filter: { tags: { value: [tag.id], modifier: "INCLUDES" } },
      },
    });
    const groups = data?.findGroups.groups ?? [];

    return h(
      "div",
      { className: "shows-page" },
      h("h1", { className: "shows-heading" }, "Shows"),
      h(
        "div",
        { className: "shows-toolbar" },
        h("span", null, loading || tag.loading ? "Loading…" : `${groups.length} Results Found`),
        h(
          "span",
          null,
          h("input", {
            className: "shows-search",
            placeholder: "Search...",
            value: q,
            onChange: (e) => setQ(e.target.value),
          }),
          h(
            "select",
            { className: "shows-sort", value: sort, onChange: (e) => setSort(e.target.value) },
            h("option", { value: "created_at" }, "Most Recent"),
            h("option", { value: "name" }, "A–Z"),
            h("option", { value: "scenes_count" }, "Most Episodes")
          )
        )
      ),
      !tag.loading && !tag.id
        ? h("p", { className: "shows-empty" }, `No shows yet. Shows are groups tagged "${SHOW_TAG}".`)
        : h("div", { className: "shows-grid" }, groups.map((g) => h(ShowCard, { key: g.id, group: g })))
    );
  }

  function formatDate(d) {
    if (!d) return "";
    const dt = new Date(d + "T00:00:00");
    return isNaN(dt) ? d : dt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  }

  function seasonEpisode(e) {
    if (e.season) return `Season ${e.season}, Episode ${e.episode}`;
    return e.episode ? `Episode ${e.episode}` : "";
  }

  // Mirrors a PlayboyTV episode page: full-width hero for the season's first
  // episode with season links underneath, then a 3-column episode grid.
  function ShowDetail({ id }) {
    const groupRes = GQL.useFindGroupQuery({ variables: { id } });
    const scenesRes = GQL.useFindScenesQuery({
      variables: {
        filter: { per_page: -1 },
        scene_filter: { groups: { value: [id], modifier: "INCLUDES" } },
      },
    });
    const [season, setSeason] = React.useState(null);

    const group = groupRes.data?.findGroup;
    if (groupRes.loading) return h("div", { className: "shows-page" }, "Loading…");
    if (!group) return h("div", { className: "shows-page" }, "Show not found.");

    const episodes = (scenesRes.data?.findScenes.scenes ?? [])
      .map((s) => ({ scene: s, ...episodeInfo(s, id) }))
      .sort((a, b) => a.idx - b.idx);
    const seasons = [...new Set(episodes.map((e) => e.season))];
    const current = season ?? seasons[0];
    const shown = seasons.length > 1 ? episodes.filter((e) => e.season === current) : episodes;
    const lead = shown[0];
    const cat = category(group);

    return h(
      "div",
      { className: "shows-detail" },
      h(
        "div",
        { className: "shows-hero" },
        h("img", {
          className: "shows-hero-img",
          src: lead ? lead.scene.paths.screenshot : group.front_image_path,
          alt: "",
        }),
        h(
          "div",
          { className: "shows-hero-content" },
          cat && h("div", { className: "shows-hero-category" }, cat),
          h("h1", { className: "shows-hero-title" }, group.name),
          lead && h("div", { className: "shows-hero-sub" }, seasonEpisode(lead)),
          lead &&
            h(
              Link,
              { to: `/scenes/${lead.scene.id}`, className: "shows-watch" },
              h("span", { className: "shows-watch-icon" }, "\u25B6\uFE0E"),
              "Watch video"
            ),
          lead && lead.scene.date && h("div", { className: "shows-hero-meta" }, `Added on ${formatDate(lead.scene.date)}`),
          lead &&
            h(
              "div",
              { className: "shows-hero-meta shows-hero-stats" },
              h(FontAwesomeIcon, { icon: faEye }),
              ` ${lead.scene.play_count ?? 0}`
            ),
          group.synopsis && h("p", { className: "shows-synopsis" }, group.synopsis)
        ),
        seasons.length > 1 &&
          h(
            "div",
            { className: "shows-seasons" },
            seasons.map((s) =>
              h(
                "a",
                {
                  key: s,
                  href: "#",
                  className: "shows-season" + (s === current ? " active" : ""),
                  onClick: (ev) => {
                    ev.preventDefault();
                    setSeason(s);
                  },
                },
                s ? `Season ${s}` : "Extras"
              )
            )
          )
      ),
      h(
        "div",
        { className: "shows-episode-grid" },
        shown.map((e) =>
          h(
            Link,
            { key: e.scene.id, to: `/scenes/${e.scene.id}`, className: "shows-episode" },
            h("img", { className: "shows-episode-img", src: e.scene.paths.screenshot, alt: "", loading: "lazy" }),
            h(
              "div",
              { className: "shows-episode-caption" },
              cat && h("div", { className: "shows-episode-category" }, cat),
              h("h2", { className: "shows-episode-title" }, group.name),
              h("div", { className: "shows-episode-sub" }, seasonEpisode(e)),
              h(
                "div",
                { className: "shows-episode-stats" },
                h(FontAwesomeIcon, { icon: faEye }),
                ` ${e.scene.play_count ?? 0}`,
                e.scene.files[0] ? `  ·  ${formatDuration(e.scene.files[0].duration)}` : ""
              )
            )
          )
        )
      ),
      h("div", { className: "shows-detail-footer" }, h(Link, { to: "/shows", className: "shows-back" }, "\u2190 All shows"))
    );
  }

  function ShowsRoute() {
    const location = useLocation();
    const m = /^\/shows\/(\d+)/.exec(location.pathname);
    return m ? h(ShowDetail, { id: m[1], key: m[1] }) : h(ShowList);
  }

  window.PluginApi.register.route("/shows", ShowsRoute);

  // add "Shows" to the main navbar, after the built-in items
  window.PluginApi.patch.before("MainNavBar.MenuItems", function (props) {
    const item = h(
      Nav.Link,
      { key: "shows", eventKey: "/shows", as: "div", className: "col-4 col-sm-3 col-md-2 col-lg-auto" },
      h(
        Link,
        { to: "/shows" },
        h(
          Button,
          {
            className:
              "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center",
          },
          h(FontAwesomeIcon, { icon: faTv, className: "nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0 mr-xl-1" }),
          h("span", null, "Shows")
        )
      )
    );
    return [{ ...props, children: h(React.Fragment, null, props.children, item) }];
  });
})();
