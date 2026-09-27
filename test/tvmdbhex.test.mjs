import assert from "node:assert/strict";
import {
  chunk, colourKey, coloursFrom, createColourLookup, resultKey, LOOKUP_BATCH,
} from "../lib/tvmdbhex.js";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };
const silent = { error: () => {} };

const hexes = { primary: { hex: "#ED2FB9" }, secondary: { hex: "#36C2FB" }, tertiary: { hex: "#DAEDFF" } };
const barbie = { media_type: "movie", tmdb_id: 346698, colors: hexes };

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
  { key: "movie:346698", id: 346698, mediaType: "movie" },
  { key: "tv:1399", id: 1399, mediaType: "tv" },
];

// ------------------------------------------------------------------ reading a result

await t("three nested hex strings become three plain ones", () => {
  assert.deepEqual(coloursFrom(barbie), { primary: "#ED2FB9", secondary: "#36C2FB", tertiary: "#DAEDFF" });
});

await t("colors: null is a real answer, not a fault", () => {
  assert.equal(coloursFrom({ colors: null }), null, "pending, or no poster — the app draws its brand palette");
  assert.equal(coloursFrom({}), null);
  assert.equal(coloursFrom(undefined), null);
});

await t("anything that is not #RRGGBB falls back whole rather than part way", () => {
  assert.equal(coloursFrom({ colors: { ...hexes, tertiary: { hex: "#FFF" } } }), null, "#RGB is not accepted");
  assert.equal(coloursFrom({ colors: { ...hexes, primary: { hex: "red" } } }), null);
  assert.equal(coloursFrom({ colors: { ...hexes, secondary: "#36C2FB" } }), null, "a bare string is a shape change");
  assert.equal(coloursFrom({ colors: { primary: { hex: "#ED2FB9" } } }), null, "two missing of three");
});

// ------------------------------------------------------------------ keying a result

await t("a result is keyed the way the contract keys a credit", () => {
  assert.equal(colourKey("tv", 87108), "tv:87108");
  assert.equal(resultKey(barbie), "movie:346698");
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
  const { calls, request } = recorder(ok({ results: [barbie], missing: [] }));
  const lookup = createColourLookup({ apiKey: () => "k", request, log: silent });
  const colours = await lookup(credits);

  assert.equal(calls.length, 1, "a whole filmography is one request, not one per title");
  assert.equal(calls[0].url, "https://tvmdbhex.vercel.app/v1/lookup");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["X-API-Key"], "k");
  assert.deepEqual(calls[0].body, { items: [
    { media_type: "movie", tmdb_id: 346698 },
    { media_type: "tv", tmdb_id: 1399 },
  ]});
  assert.deepEqual(colours.get("movie:346698"), { primary: "#ED2FB9", secondary: "#36C2FB", tertiary: "#DAEDFF" });
});

await t("a title the service does not hold is simply absent", async () => {
  const { request } = recorder(ok({ results: [barbie], missing: [{ media_type: "tv", tmdb_id: 1399 }] }));
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
  const { calls, request } = recorder(ok({ results: [barbie] }));
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
    call === 1 ? bad(500) : ok({ results: [{ media_type: "movie", tmdb_id: 500, colors: hexes }] })
  );
  const colours = await createColourLookup({ apiKey: () => "k", request, log: silent })(many);
  assert.equal(colours.size, 1, "the batch that answered still counts");
});

await t("a body that is not the expected shape is logged, not dropped quietly", async () => {
  const logged = [];
  const { request } = recorder(ok({ results: [{ colors: hexes }] }));
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
  const { request } = recorder(ok({ results: [barbie], missing: [] }));
  await createColourLookup({ apiKey: () => "k", request, log })(credits);

  assert.equal(log.error_.length, 0, "nothing went wrong");
  assert.match(log.info_.join(" "), /asked 2 .* 1 returned, 1 coloured/,
    "and the run reports what it did, so 'no lines at all' can only mean 'not deployed'");
});

await t("an envelope that is not `results` names its own keys", async () => {
  const log = loud();
  const { request } = recorder(ok({ data: [barbie], count: 1 }));
  const colours = await createColourLookup({ apiKey: () => "k", request, log })(credits);

  assert.equal(colours.size, 0);
  assert.match(log.error_.join(" "), /no `results` array/);
  assert.match(log.error_.join(" "), /\[data, count\]/, "the fix is in the keys, so they are in the line");
  assert.match(log.info_.join(" "), /envelope keys \[data, count\]/);
});

await t("colors present but in another shape is not the same as colors: null", async () => {
  const log = loud();
  const { request } = recorder(ok({ results: [
    { ...barbie, colors: { primary: "#ED2FB9", secondary: "#36C2FB", tertiary: "#DAEDFF" } },
    { media_type: "tv", tmdb_id: 1399, colors: null },
  ]}));
  const colours = await createColourLookup({ apiKey: () => "k", request, log })(credits);

  assert.equal(colours.size, 0);
  assert.match(log.error_.join(" "), /colors did not parse/);
  assert.match(log.error_.join(" "), /#ED2FB9/, "the shape that arrived is what makes it fixable");
  assert.match(log.info_.join(" "), /1 unparseable/, "and colors: null is not counted as one");
});

await t("the noisy cases are reported once, not once per title", async () => {
  const log = loud();
  const many = Array.from({ length: 50 }, (_, i) => ({ media_type: "movie", tmdb_id: i, colors: { primary: "x" } }));
  const { request } = recorder(ok({ results: many }));
  await createColourLookup({ apiKey: () => "k", request, log })(credits);

  assert.equal(log.error_.length, 1, "three hundred rows must not be three hundred lines");
  assert.match(log.info_.join(" "), /50 unparseable/, "the count carries the rest");
});

// ------------------------------------------------- telling whose fault a 500 is

await t("a failed batch probes one title, and names which side is broken", async () => {
  const log = loud();
  const { calls, request } = recorder((call) => (call === 1 ? bad(500, "Internal Server Error") : ok(barbie)));
  await createColourLookup({ apiKey: () => "k", request, log })(credits);

  assert.equal(calls.length, 2, "one probe, not one request per title");
  assert.equal(calls[1].url, "https://tvmdbhex.vercel.app/v1/movie/346698");
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

await t("a probe that cannot be made is not a second failure to chase", async () => {
  const log = loud();
  let n = 0;
  const request = async () => { n += 1; if (n === 1) return bad(500); throw new Error("ECONNRESET"); };
  const colours = await createColourLookup({ apiKey: () => "k", request, log })(credits);
  assert.equal(colours.size, 0);
  assert.match(log.error_.join(" "), /probe .* could not be made/);
});

await t("a run that works never probes", async () => {
  const { calls, request } = recorder(ok({ results: [barbie] }));
  await createColourLookup({ apiKey: () => "k", request, log: silent })(credits);
  assert.equal(calls.length, 1, "the probe costs nothing when there is nothing wrong");
});

console.log(`\n${n} tests passed`);
