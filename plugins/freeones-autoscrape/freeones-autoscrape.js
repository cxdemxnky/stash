// FreeOnes auto-scrape (embedded JS plugin, runs inside Stash).
// Each scraped performer gets the custom field "freeones_scraped" (the date, or
// "not found: <date>") so the "unscraped" task can skip them next time.
var SCRAPER = "builtin_freeones";
var MARK = "freeones_scraped";
var BULK_DELAY_MS = 1500; // be polite to freeones.com during bulk runs

var GENDERS = {
  male: "MALE",
  female: "FEMALE",
  "transgender male": "TRANSGENDER_MALE",
  "trans male": "TRANSGENDER_MALE",
  "transgender female": "TRANSGENDER_FEMALE",
  "trans female": "TRANSGENDER_FEMALE",
  transgender: "TRANSGENDER_FEMALE",
  intersex: "INTERSEX",
  "non-binary": "NON_BINARY",
  "non binary": "NON_BINARY",
};

var PERFORMER_FIELDS =
  "id name disambiguation alias_list urls gender birthdate ethnicity country eye_color height_cm " +
  "measurements fake_tits career_start career_end tattoos piercings hair_color weight details image_path custom_fields";

function main() {
  var mode = input.Args.mode;
  try {
    if (mode === "hook") {
      var id = input.Args.hookContext && input.Args.hookContext.id;
      if (id) scrapePerformer(String(id));
    } else if (mode === "unscraped") {
      bulk({ custom_fields: [{ field: MARK, modifier: "IS_NULL" }] });
    } else if (mode === "noimage") {
      bulk({ is_missing: "image" });
    }
  } catch (err) {
    log.Error("FreeOnes auto-scrape: " + err);
    return { Error: String(err) };
  }
  return { Output: "ok" };
}

function settings() {
  var res = gql.Do('query { configuration { plugins(include: ["freeones-autoscrape"]) } }');
  return (res.configuration.plugins && res.configuration.plugins["freeones-autoscrape"]) || {};
}

function bulk(filter) {
  var ids = [];
  var page = 1;
  for (;;) {
    var res = gql.Do(
      "query($f: FindFilterType, $pf: PerformerFilterType) { findPerformers(filter: $f, performer_filter: $pf) { count performers { id } } }",
      { f: { page: page, per_page: 200, sort: "id" }, pf: filter }
    ).findPerformers;
    for (var i = 0; i < res.performers.length; i++) ids.push(res.performers[i].id);
    if (ids.length >= res.count || res.performers.length === 0) break;
    page++;
  }
  log.Info("FreeOnes: scraping " + ids.length + " performer(s)");
  var found = 0;
  for (var j = 0; j < ids.length; j++) {
    log.Progress(j / ids.length);
    try {
      if (scrapePerformer(ids[j])) found++;
    } catch (err) {
      log.Warn("FreeOnes: performer " + ids[j] + ": " + err);
    }
    if (j < ids.length - 1) util.Sleep(BULK_DELAY_MS);
  }
  log.Progress(1);
  log.Info("FreeOnes: done, matched " + found + " of " + ids.length);
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^\s+|\s+$/g, "");
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function isEmpty(v) {
  return v === null || v === undefined || v === "" || (v.length !== undefined && v.length === 0);
}

// returns true when the performer was found on FreeOnes
function scrapePerformer(id) {
  var p = gql.Do("query($id: ID!) { findPerformer(id: $id) { " + PERFORMER_FIELDS + " } }", { id: id }).findPerformer;
  if (!p) return false;

  var url = findFreeonesUrl(p);
  if (!url) {
    log.Info("FreeOnes: no match for " + p.name);
    mark(p.id, "not found: " + today());
    return false;
  }

  var s = gql.Do(
    "query($u: String!) { scrapePerformerURL(url: $u) { name gender urls birthdate ethnicity country eye_color height measurements fake_tits career_start career_end tattoos piercings aliases hair_color weight details images } }",
    { u: url }
  ).scrapePerformerURL;
  if (!s) {
    mark(p.id, "not found: " + today());
    return false;
  }

  var overwrite = !!settings().overwrite;
  var upd = { id: p.id };
  function fill(field, value) {
    if (isEmpty(value)) return;
    if (overwrite || isEmpty(p[field])) upd[field] = value;
  }

  var gender = GENDERS[normalize(s.gender)];
  fill("gender", gender);
  fill("birthdate", s.birthdate);
  fill("ethnicity", s.ethnicity);
  fill("country", s.country);
  fill("eye_color", s.eye_color);
  fill("hair_color", s.hair_color);
  fill("measurements", s.measurements);
  fill("fake_tits", s.fake_tits);
  fill("career_start", s.career_start);
  fill("career_end", s.career_end);
  fill("tattoos", s.tattoos);
  fill("piercings", s.piercings);
  fill("details", s.details);
  var h = parseInt(s.height, 10);
  if (h > 0) fill("height_cm", h);
  var w = parseInt(s.weight, 10);
  if (w > 0) fill("weight", w);

  if (s.aliases) {
    var aliases = (p.alias_list || []).slice();
    var parts = String(s.aliases).split(/\s*[,;]\s*/);
    for (var i = 0; i < parts.length; i++) {
      var a = parts[i];
      if (a && normalize(a) !== normalize(p.name) && aliases.indexOf(a) < 0) aliases.push(a);
    }
    if (aliases.length !== (p.alias_list || []).length) upd.alias_list = aliases;
  }

  var urls = (p.urls || []).slice();
  var more = (s.urls || []).concat([url]);
  for (var k = 0; k < more.length; k++) if (more[k] && urls.indexOf(more[k]) < 0) urls.push(more[k]);
  if (urls.length !== (p.urls || []).length) upd.urls = urls;

  // Stash serves a placeholder ("?default=true") when a performer has no image
  var hasImage = p.image_path && p.image_path.indexOf("default=true") < 0;
  if (s.images && s.images.length && (overwrite || !hasImage)) upd.image = s.images[0];

  upd.custom_fields = { partial: {} };
  upd.custom_fields.partial[MARK] = today();
  gql.Do("mutation($i: PerformerUpdateInput!) { performerUpdate(input: $i) { id } }", { i: upd });
  log.Info("FreeOnes: updated " + p.name + " (" + (Object.keys(upd).length - 2) + " field(s))");
  return true;
}

// search FreeOnes by name, then aliases; only accept an exact (normalized) name match
function findFreeonesUrl(p) {
  var existing = (p.urls || []).filter(function (u) {
    return /freeones\.(com|xxx)\//.test(u);
  });
  if (existing.length) return existing[0];

  var names = [p.name].concat(p.alias_list || []);
  for (var i = 0; i < names.length; i++) {
    var results = gql.Do(
      "query($q: String!) { scrapeSinglePerformer(source: {scraper_id: \"" + SCRAPER + "\"}, input: {query: $q}) { name urls } }",
      { q: names[i] }
    ).scrapeSinglePerformer;
    for (var j = 0; j < results.length; j++) {
      var r = results[j];
      if (normalize(r.name) === normalize(names[i]) && r.urls && r.urls.length) return r.urls[0];
    }
  }
  return null;
}

function mark(id, value) {
  var cf = { partial: {} };
  cf.partial[MARK] = value;
  gql.Do("mutation($i: PerformerUpdateInput!) { performerUpdate(input: $i) { id } }", {
    i: { id: id, custom_fields: cf },
  });
}

main();
