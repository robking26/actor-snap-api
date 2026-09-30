import assert from "node:assert/strict";
import {
  chunk, colourKey, coloursFrom, createColourLookup, resetProbe, resultKey, LOOKUP_BATCH, COLOUR_ROLES,
} from "../lib/tvmdbhex.js";

let n = 0;
// The probe happens once per process, so every test that wants one has to say so. That is
// the behaviour under test rather than an inconvenience of it: a diagnostic repeated on
// every scan is noise, and a test that did not have to reset would be a test proving the
// old behaviour.
const t = async (name, fn) => { resetProbe(); await fn(); n++; console.log("✓", name); };
const silent = { error: () => {} };

// Toy Story's six, which is the palette the app's artwork was drawn against.
const palette = {
  base: "#0086C7",
  identity1: "#F10000",
  identity2: "#FFE734",
  highlight1: "#7A4531",
  highlight2: "#A9A78A",
  accent: "#662C7A",
};
const toyStory = { media_type: "movie", tmdb_id: 862, palette };

// The old three-colour shape, kept as a fixture rather than deleted: a row tvmdbhex has
// not re-coloured still answers exactly this, and the tests below are what say it is
// treated as "not yet" rather than as a fault.
const legacyColors = {
  primary: { hex: "#ED2FB9" },
  secondary: { hex: "#36C2FB" },
  tertiary: { hex: "#DAEDFF" },
};

// A fetch that records what it was asked and answers with whatever is handed in.
function recorder(reply) {
  const calls = [];
  const request = async (url, init) => {
    // `body` only where there is one: the probe is a GET, and `JSON.parse(undefined)`
    // throws — which silently cost this helper a recorded call once.
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return typeof reply === "function" ? reply(calls.length) : reply;
  };
  return { calls, request };
}
const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
const bad = (status, text = "") => ({ ok: false, status, text: async () => text });

const credits = [
  { key: "movie:862", id: 862, mediaType: "movie" },
  { key: "tv:1399", id: 1399, mediaType: "tv" },
];

// ------------------------------------------------------------------ reading a result

await t("the six roles come off `palette` as six plain strings", () => {
  assert.deepEqual(coloursFrom(toyStory), palette);
  assert.deepEqual(Object.keys(coloursFrom(toyStory)), COLOUR_ROLES, "and in the artwork's own order");
});

await t("palette: null is a real answer, not a fault", () => {
  assert.equal(coloursFrom({ palette: null }), null, "pending, or no poster — the app draws its brand palette");
  assert.equal(coloursFrom({}), null);
  assert.equal(coloursFrom(undefined), null);
});

await t("the legacy `colors` field is never read, even when `palette` is missing", () => {
  // Three colours cannot fill a six-colour picture, and deriving the other three here
  // would be this file inventing design. The app draws its brand palette instead.
  assert.equal(coloursFrom({ colors: legacyColors }), null);
  assert.equal(coloursFrom({ colors: legacyColors, palette: null }), null);
});

await t("anything that is not #RRGGBB falls back whole rather than part way", () => {
  assert.equal(coloursFrom({ palette: { ...palette, accent: "#FFF" } }), null, "#RGB is not accepted");
  assert.equal(coloursFrom({ palette: { ...palette, base: "red" } }), null);
  assert.equal(
    coloursFrom({ palette: { ...palette, identity1: { hex: "#F10000" } } }),
    null,
    "a nested swatch is the old shape, so it is a shape change"
  );
  for (const role of COLOUR_ROLES) {
    const short = { ...palette };
    delete short[role];
    assert.equal(coloursFrom({ palette: short }), null, `five of six is not a picture (missing ${role})`);
  }
});

// ------------------------------------------------------------------ keying a result

await t("a result is keyed the way the contract keys a credit", () => {
  assert.equal(colourKey("tv", 87108), "tv:87108");
  assert.equal(resultKey(toyStory), "movie:862");
  assert.equal(resultKey({ mediaType: "tv", tmdbId: 1399 }), "tv:1399", "the other spelling is accepted");
  assert.equal(resultKey({ media_type: "tv", id: 1399 }), "tv:1399");
});

await t("a result it cannot key is refused rather than guessed at", () => {
  assert.equal(resultKey({ tmdb_id: 1 }), null, "no media type");
  assert.equal(resultKey({ media_type: "movie" }), null, "no id");
  assert.equal(resultKey({ media_type: "person", tmdb_id: 1 }), null, "not a title");
  assert.equal(resultKey(null), null);
});

// ------------------------------------------------------------------ the request

await t("one POST, with the key in X-API-Key and the pairs in the body", async () => {
  const { calls, request } = recorder(ok({ results: [toyStory], missing: [] }));
  const lookup = createColourLookup({ apiKey: () => "k", request, log: silent });
  const colours = await lookup(credits);

  assert.equal(calls.length, 1, "a whole filmography is one request, not one per title");
  assert.equal(calls[0].url, "https://tvmdbhex.vercel.app/v1/lookup");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["X-API-Key"], "k");
  assert.deepEqual(calls[0].body, { items: [
    { media_type: "movie", tmdb_id: 862 },
    { media_type: "tv", tmdb_id: 1399 },
  ]});
  assert.deepEqual(colours.get("movie:862"), palette, "all six roles, as the artwork wants them");
});

await t("a title the service does not hold is simply absent", async () => {
  const { request } = recorder(ok({ results: [toyStory], missing: [{ media_type: "tv", tmdb_id: 1399 }] }));
  const colours = await createColourLookup({ apiKey: () => "k", request, log: silent })(credits);
  assert.equal(colours.size, 1);
  assert.equal(colours.has("tv:1399"), false, "buildResponse turns a miss into null");
});

await t("more than the service's ceiling is split, and every batch lands", async () => {
  const many = Array.from({ length: LOOKUP_BATCH + 1 }, (_, i) => ({ key: `movie:${i}`, id: i, mediaType: "movie" }));
  const { calls, request } = recorder(() => ok({ results: [] }));
  await createColourLookup({ apiKey: () => "k", request, log: silent })(many);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.items.length, LOOKUP_BATCH);
  assert.equal(calls[1].body.items.length, 1);
  assert.equal(chunk([1, 2, 3], 2).length, 2);
});

// ------------------------------------------------------------------ every way it fails

await t("no key is a logged line and nothing else", async () => {
  const logged = [];
  const { calls, request } = recorder(ok({ results: [toyStory] }));
  const colours = await createColourLookup({
    apiKey: () => undefined, request, log: { error: (...a) => logged.push(a) },
  })(credits);

  assert.equal(colours.size, 0);
  assert.equal(calls.length, 0, "nothing is sent without a key");
  assert.match(logged[0].join(" "), /TVMDBHEX_API_KEY/, "and it says which key is missing");
});

await t("a 401 keeps its body, because that is the whole of what a deployment needs", async () => {
  const logged = [];
  const { request } = recorder(bad(401, '{"error":"invalid key"}'));
  const colours = await createColourLookup({
    apiKey: () => "wrong", request, log: { error: (...a) => logged.push(a) },
  })(credits);

  assert.equal(colours.size, 0);
  assert.match(logged[0].join(" "), /401/);
  assert.match(logged[0].join(" "), /invalid key/, "a 401 and a 400 both leave every card brand");
});

await t("a request that throws returns what it has rather than throwing on", async () => {
  const request = async () => { throw new Error("ECONNRESET"); };
  const colours = await createColourLookup({ apiKey: () => "k", request, log: silent })(credits);
  assert.equal(colours.size, 0);
});

await t("one batch failing does not take the others with it", async () => {
  const many = Array.from({ length: LOOKUP_BATCH + 1 }, (_, i) => ({ key: `movie:${i}`, id: i, mediaType: "movie" }));
  const { request } = recorder((call) =>
    call === 1 ? bad(500) : ok({ results: [{ media_type: "movie", tmdb_id: 500, palette }] })
  );
  const colours = await createColourLookup({ apiKey: () => "k", request, log: silent })(many);
  assert.equal(colours.size, 1, "the batch that answered still counts");
});

await t("a body that is not the expected shape is logged, not dropped quietly", async () => {
  const logged = [];
  const { request } = recorder(ok({ results: [{ palette }] }));
  const colours = await createColourLookup({
    apiKey: () => "k", request, log: { error: (...a) => logged.push(a) },
  })(credits);

  assert.equal(colours.size, 0);
  assert.match(logged[0].join(" "), /no media_type and tmdb_id/,
    "a renamed identifier leaves every card brand and nothing else would say so");
});

await t("no credits is no request", async () => {
  const { calls, request } = recorder(ok({ results: [] }));
  assert.equal((await createColourLookup({ apiKey: () => "k", request, log: silent })([])).size, 0);
  assert.equal(calls.length, 0);
});

// ------------------------------------------------- the three silences, which are the bug

// A logger that keeps both levels apart, because the summary goes to `info` so a
// dashboard filtered to errors cannot lose it.
function loud() {
  const info = [], error = [];
  return { info: (...a) => info.push(a.join(" ")), error: (...a) => error.push(a.join(" ")), info_: info, error_: error };
}

await t("a flawless run still says so — silence is not an answer", async () => {
  const log = loud();
  const { request } = recorder(ok({ results: [toyStory], missing: [] }));
  await createColourLookup({ apiKey: () => "k", request, log })(credits);

  assert.equal(log.error_.length, 0, "nothing went wrong");
  assert.match(log.info_.join(" "), /asked 2 .* 1 returned, 1 coloured/,
    "and the run reports what it did, so 'no lines at all' can only mean 'not deployed'");
});

await t("an envelope that is not `results` names its own keys", async () => {
  const log = loud();
  const { request } = recorder(ok({ data: [toyStory], count: 1 }));
  const colours = await createColourLookup({ apiKey: () => "k", request, log })(credits);

  assert.equal(colours.size, 0);
  assert.match(log.error_.join(" "), /no `results` array/);
  assert.match(log.error_.join(" "), /\[data, count\]/, "the fix is in the keys, so they are in the line");
  assert.match(log.info_.join(" "), /envelope keys \[data, count\]/);
});

await t("a palette in another shape is not the same as palette: null", async () => {
  const log = loud();
  const { request } = recorder(ok({ results: [
    { media_type: "movie", tmdb_id: 862, palette: { ...palette, base: { hex: "#0086C7" } } },
    { media_type: "tv", tmdb_id: 1399, palette: null },
  ]}));
  const colours = await createColourLookup({ apiKey: () => "k", request, log })(credits);

  assert.equal(colours.size, 0);
  assert.match(log.error_.join(" "), /palette did not parse/);
  assert.match(log.error_.join(" "), /#0086C7/, "the shape that arrived is what makes it fixable");
  assert.match(log.info_.join(" "), /1 unparseable/, "and palette: null is not counted as one");
});

await t("a title still on the old three colours is counted apart from a broken one", async () => {
  // The state every row is in until tvmdbhex has run its new algorithm against it. It
  // wants waiting, where an unparseable palette wants somebody to look — so it is neither
  // an error line nor an `unparseable`, and the summary says which it was.
  const log = loud();
  const { request } = recorder(ok({ results: [
    { media_type: "movie", tmdb_id: 862, colors: legacyColors },
    { media_type: "tv", tmdb_id: 1399, colors: legacyColors, palette: null },
  ]}));
  const colours = await createColourLookup({ apiKey: () => "k", request, log })(credits);

  assert.equal(colours.size, 0, "three colours cannot fill a six-colour picture");
  assert.deepEqual(log.error_, [], "not a fault, so not an error line");
  assert.match(log.info_.join(" "), /2 not re-coloured yet/);
  assert.doesNotMatch(log.info_.join(" "), /unparseable/);
});

await t("the noisy cases are reported once, not once per title", async () => {
  const log = loud();
  const many = Array.from({ length: 50 }, (_, i) => ({ media_type: "movie", tmdb_id: i, palette: { base: "x" } }));
  const { request } = recorder(ok({ results: many }));
  await createColourLookup({ apiKey: () => "k", request, log })(credits);

  assert.equal(log.error_.length, 1, "three hundred rows must not be three hundred lines");
  assert.match(log.info_.join(" "), /50 unparseable/, "the count carries the rest");
});

// ------------------------------------------------- telling whose fault a 500 is

await t("a failed batch probes one title, and names which side is broken", async () => {
  const log = loud();
  const { calls, request } = recorder((call) => (call === 1 ? bad(500, "Internal Server Error") : ok(toyStory)));
  await createColourLookup({ apiKey: () => "k", request, log })(credits);

  assert.equal(calls.length, 2, "one probe, not one request per title");
  assert.equal(calls[1].url, "https://tvmdbhex.vercel.app/v1/movie/862");
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[1].init.headers["X-API-Key"], "k");
  assert.match(log.error_.join(" "), /\/v1\/lookup is the broken part/);
});

await t("a 401 on the probe says it is the key", async () => {
  const log = loud();
  const { request } = recorder((call) => (call === 1 ? bad(500) : bad(401)));
  await createColourLookup({ apiKey: () => "bad", request, log })(credits);
  assert.match(log.error_.join(" "), /the key is wrong or not set on tvmdbhex/);
});

await t("a 404 on the probe still means the service is up", async () => {
  const log = loud();
  const { request } = recorder((call) => (call === 1 ? bad(500) : bad(404)));
  await createColourLookup({ apiKey: () => "k", request, log })(credits);
  assert.match(log.error_.join(" "), /the key works and the service is up/);
});

await t("the probe happens once per process, not once per scan", async () => {
  // A line saying which side is broken is worth having; the same line on every scan of
  // the same deployment is noise, and it used to be made with no timeout of its own.
  const log = loud();
  const { calls, request } = recorder(() => bad(500, "Internal Server Error"));
  const lookup = createColourLookup({ apiKey: () => "k", request, log });

  await lookup(credits);
  await lookup(credits);
  await lookup(credits);

  assert.equal(calls.filter((c) => c.init.method === "GET").length, 1, "one probe across three scans");
});

await t("the probe carries an abort signal of its own", async () => {
  // It buys a log line and nothing else, so it must never be the thing holding a
  // finished identification open. The batch had an AbortController and this had none.
  const { calls, request } = recorder((call) => (call === 1 ? bad(500) : ok(toyStory)));
  await createColourLookup({ apiKey: () => "k", request, log: silent })(credits);

  const probeCall = calls.find((c) => c.init.method === "GET");
  assert.ok(probeCall.init.signal, "the probe is bounded");
});

await t("a probe that cannot be made is not a second failure to chase", async () => {
  const log = loud();
  let n = 0;
  const request = async () => { n += 1; if (n === 1) return bad(500); throw new Error("ECONNRESET"); };
  const colours = await createColourLookup({ apiKey: () => "k", request, log })(credits);
  assert.equal(colours.size, 0);
  assert.match(log.error_.join(" "), /probe .* could not be made/);
});

await t("a run that works never probes", async () => {
  const { calls, request } = recorder(ok({ results: [toyStory] }));
  await createColourLookup({ apiKey: () => "k", request, log: silent })(credits);
  assert.equal(calls.length, 1, "the probe costs nothing when there is nothing wrong");
});

console.log(`\n${n} tests passed`);
