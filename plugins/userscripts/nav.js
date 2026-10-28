// Adds a "Userscripts" icon to the navbar's utility area linking to the scripts page.
(function () {
  const { React, libraries } = window.PluginApi;
  const { FontAwesomeIcon } = libraries.ReactFontAwesome;
  const { faCode } = libraries.FontAwesomeSolid;
  const { Button } = libraries.Bootstrap;
  const h = React.createElement;

  window.PluginApi.patch.before("MainNavBar.UtilityItems", function (props) {
    const link = h(
      "a",
      { key: "userscripts", href: "plugin/userscripts/assets/", title: "Downloader userscripts" },
      h(Button, { className: "minimal d-flex align-items-center h-100" }, h(FontAwesomeIcon, { icon: faCode }))
    );
    return [{ ...props, children: h(React.Fragment, null, link, props.children) }];
  });
})();
