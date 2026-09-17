import { Readable } from "node:stream";
import assert from "node:assert/strict";
import { createHandler, MAX_IMAGE_BYTES } from "../lib/hoozat.js";
import { createLimiter, DEFAULT_LIMITS } from "../lib/rate-limit.js";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
const PNG = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(50)]);
const KEY = "test-key-123";

const ineson = {
  Name: "Ralph Ineson", MatchConfidence: 99.2, Urls: ["www.wikidata.org/wiki/Q123", "www.imdb.com/name/nm0408506"],
  Face: { BoundingBox: { Width: 0.3, Height: 0.4, Left: 0.35, Top: 0.2 } },
};
const person = {
  id: 69, name: "Ralph Ineson", gender: 2, biography: "  Ralph Michael Ineson is an English actor.  ",
  birthday: "1969-12-15", place_of_birth: "Leeds", known_for_department: "Acting", profile_path: "/p.jpg",
  external_ids: { imdb_id: "nm0408506" },
  combined_credits: { cast: [
    { media_type: "tv", id: 87108, name: "Chernobyl", first_air_date: "2019-05-06", character: "Nikolai Tarakanov", episode_count: 2, poster_path: "/c.jpg", vote_count: 6000, popularity: 50, genre_ids: [18] },
    { media_type: "tv", id: 87108, name: "Chernobyl", first_air_date: "2019-05-06", character: "General Tarakanov", episode_count: 1, poster_path: "/c.jpg", vote_count: 6000, popularity: 50, genre_ids: [18] },
    { media_type: "movie", id: 207703, title: "Kingsman: The Secret Service", release_date: "2014-12-13", character: "Richard", order: 20, poster_path: "/k.jpg", vote_count: 16000, popularity: 60, genre_ids: [28] },
    { media_type: "movie", id: 617126, title: "The Fantastic Four: First Steps", release_date: "2025-07-23", character: "Galactus", order: 4, poster_path: "/f.jpg", vote_count: 3000, popularity: 200, genre_ids: [878] },
    { media_type: "tv", id: 1, name: "The Graham Norton Show", first_air_date: "2007-02-22", character: "Self", episode_count: 3, poster_path: "/g.jpg", vote_count: 900, popularity: 90, genre_ids: [10767] },
    { media_type: "movie", id: 2, title: "Some Doc", release_date: "2020-01-01", character: "Himself", order: 1, poster_path: "/d.jpg", vote_count: 50000, popularity: 10, genre_ids: [99] },
    { media_type: "movie", id: 3, title: "Announced Film", release_date: "", character: "TBC", poster_path: null, vote_count: 0, popularity: 5, genre_ids: [] },
    { media_type: "tv", id: 207703, name: "ID collision show", first_air_date: "2025-01-01", character: "Bob", episode_count: 8, poster_path: "/x.jpg", vote_count: 10, popularity: 1, genre_ids: [18] },
  ] },
};

function makeReq({ method = "POST", key = KEY, body = JPEG, address } = {}) {
  const r = Readable.from(body.length ? [body] : []);
  r.method = method; r.headers = key == null ? {} : { "x-hoozat-key": key };
  if (address) r.headers["x-forwarded-for"] = address;
  return r;
}
function makeRes() {
  const res = { statusCode: null, headers: {}, body: null };
  res.setHeader = (k, v) => (res.headers[k] = v);
  res.status = (s) => ((res.statusCode = s), res);
  res.json = (b) => ((res.body = b), res);
  return res;
}
const silent = { error: () => {} };
function handlerWith(o = {}) {
  const calls = [];
  const h = createHandler({
    appKey: () => ("appKey" in o ? o.appKey : KEY),
    recognise: o.recognise ?? (async () => ({ CelebrityFaces: [ineson], UnrecognizedFaces: [] })),
    tmdbGet: async (path, params) => { calls.push(path); return (o.tmdbGet ?? defaultTmdb)(path, params); },
    log: silent,
    ...(o.limiter ? { limiter: o.limiter } : {}),
    ...(o.limits ? { limits: o.limits } : {}),
  });
  return { h, calls };
}
async function defaultTmdb(path) {
  if (path.startsWith("/find/")) return { person_results: [{ id: 69 }] };
  if (path === "/person/69") return person;
  throw Object.assign(new Error("404"), { response: { status: 404 } });
}
async function run(o, reqOpts) { const { h, calls } = handlerWith(o); const res = makeRes(); await h(makeReq(reqOpts), res); return { res, calls }; }
const code = (res) => res.body?.error?.code;

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };

await t("405 on GET", async () => { const { res } = await run({}, { method: "GET" }); assert.equal(res.statusCode, 405); assert.equal(code(res), "method_not_allowed"); });
await t("500 when app key env missing (fail closed)", async () => { const { res } = await run({ appKey: undefined }); assert.equal(res.statusCode, 500); assert.equal(code(res), "server_misconfigured"); });
await t("401 missing key", async () => { const { res } = await run({}, { key: null }); assert.equal(res.statusCode, 401); });
await t("401 wrong key", async () => { const { res } = await run({}, { key: "nope" }); assert.equal(res.statusCode, 401); });
await t("400 empty body", async () => { const { res } = await run({}, { body: Buffer.alloc(0) }); assert.equal(code(res), "no_image"); });
await t("415 non-image", async () => { const { res } = await run({}, { body: Buffer.from("hello world") }); assert.equal(res.statusCode, 415); });
await t("413 oversize", async () => { const big = Buffer.concat([JPEG, Buffer.alloc(MAX_IMAGE_BYTES)]); const { res } = await run({}, { body: big }); assert.equal(res.statusCode, 413); });
await t("PNG accepted", async () => { const { res } = await run({}, { body: PNG }); assert.equal(res.statusCode, 200); });
await t("422 no face", async () => { const { res } = await run({ recognise: async () => ({ CelebrityFaces: [], UnrecognizedFaces: [] }) }); assert.equal(res.statusCode, 422); assert.equal(code(res), "no_face"); });
await t("404 not_recognised when largest face unknown", async () => {
  const { res, calls } = await run({ recognise: async () => ({ CelebrityFaces: [{ ...ineson, Face: { BoundingBox: { Width: 0.05, Height: 0.05 } } }], UnrecognizedFaces: [{ BoundingBox: { Width: 0.4, Height: 0.5 } }] }) });
  assert.equal(code(res), "not_recognised"); assert.equal(res.body.error.details.faceCount, 2); assert.equal(calls.length, 0);
});
await t("largest celebrity chosen among several", async () => {
  const small = { ...ineson, Name: "Someone Else", Urls: [], Face: { BoundingBox: { Width: 0.1, Height: 0.1 } } };
  const { res } = await run({ recognise: async () => ({ CelebrityFaces: [small, ineson], UnrecognizedFaces: [] }) });
  assert.equal(res.body.person.name, "Ralph Ineson"); assert.equal(res.body.match.faceCount, 2);
});
await t("415 mapped from Rekognition InvalidImageFormatException", async () => { const { res } = await run({ recognise: async () => { throw Object.assign(new Error("x"), { name: "InvalidImageFormatException" }); } }); assert.equal(res.statusCode, 415); });
await t("503 on Rekognition throttling", async () => { const { res } = await run({ recognise: async () => { throw Object.assign(new Error("x"), { name: "ThrottlingException" }); } }); assert.equal(res.statusCode, 503); });
await t("502 carries the AWS error name so it can be diagnosed without server logs", async () => {
  const { res } = await run({ recognise: async () => { throw Object.assign(new Error("no"), { name: "UnrecognizedClientException" }); } });
  assert.equal(res.statusCode, 502);
  assert.equal(code(res), "recognition_unavailable");
  assert.equal(res.body.error.details.reason, "UnrecognizedClientException");
});
await t("502 on Rekognition unknown error", async () => { const { res } = await run({ recognise: async () => { throw new Error("boom"); } }); assert.equal(code(res), "recognition_unavailable"); });
await t("502 on TMDB auth failure", async () => { const { res } = await run({ tmdbGet: async () => { throw Object.assign(new Error("401"), { response: { status: 401, data: {} } }); } }); assert.equal(code(res), "profile_unavailable"); });

await t("200 via IMDb ID — no name search", async () => {
  const { res, calls } = await run({});
  assert.equal(res.statusCode, 200); assert.deepEqual(calls, ["/find/nm0408506", "/person/69"]);
  const b = res.body;
  assert.equal(b.match.method, "imdb"); assert.equal(b.match.confidence, 0.992); assert.equal(b.match.confidenceLevel, "high");
  assert.equal(b.person.firstName, "Ralph"); assert.equal(b.person.pronouns.possessive, "his");
  assert.equal(b.person.biography, "Ralph Michael Ineson is an English actor.");
  assert.equal(b.person.profileUrl, "https://image.tmdb.org/t/p/original/p.jpg");
  assert.equal(res.headers["Cache-Control"], "no-store");
  assert.equal(b.attribution.includes("TMDB"), true);
});
await t("credits deduped, merged, sorted, internals stripped", async () => {
  const b = (await run({})).res.body;
  const cherno = b.credits.filter((c) => c.key === "tv:87108");
  assert.equal(cherno.length, 1); assert.deepEqual(cherno[0].characters, ["Nikolai Tarakanov", "General Tarakanov"]); assert.equal(cherno[0].episodeCount, 3);
  assert.ok(b.credits.find((c) => c.key === "movie:207703") && b.credits.find((c) => c.key === "tv:207703"), "movie/tv id collision kept apart");
  assert.equal(b.totals.credits, 7); assert.equal(b.totals.movie, 4); assert.equal(b.totals.tv, 3);
  const years = b.credits.map((c) => c.year);
  assert.deepEqual(years, [2025, 2025, 2020, 2019, 2014, 2007, null]);
  assert.deepEqual(b.filters.years, [2025, 2020, 2019, 2014, 2007]);
  for (const c of b.credits) for (const k of Object.keys(c)) assert.ok(!k.startsWith("_"), `leaked ${k}`);
  assert.equal(b.credits.find((c) => c.title === "Announced Film").posterUrl, null);
});
await t("notable excludes talk shows, playing self, posterless", async () => {
  const b = (await run({})).res.body;
  const titles = b.notableCredits.map((c) => c.title);
  assert.ok(!titles.includes("The Graham Norton Show")); assert.ok(!titles.includes("Some Doc")); assert.ok(!titles.includes("Announced Film"));
  assert.ok(b.credits.find((c) => c.title === "The Graham Norton Show").isAppearance);
  assert.ok(titles.includes("Chernobyl") && titles.includes("Kingsman: The Secret Service"));
  console.log("   notable order:", titles.join(" | "));
});
await t("name fallback: exact match only, prefers acting + popularity", async () => {
  const tmdbGet = async (path, params) => {
    if (path.startsWith("/find/")) return { person_results: [] };
    if (path === "/search/person") return { results: [
      { id: 5, name: "Ralph Inesón", known_for_department: "Writing", popularity: 99 },
      { id: 69, name: "Ralph Ineson", known_for_department: "Acting", popularity: 10 },
      { id: 7, name: "Ralph Inesonson", known_for_department: "Acting", popularity: 500 },
    ] };
    if (path === "/person/69") return person;
  };
  const { res } = await run({ tmdbGet }); assert.equal(res.statusCode, 200); assert.equal(res.body.match.method, "name"); assert.equal(res.body.person.tmdbId, 69);
});
await t("404 person_not_found when no exact name", async () => {
  const { res } = await run({ recognise: async () => ({ CelebrityFaces: [{ ...ineson, Urls: [] }] }), tmdbGet: async () => ({ results: [{ id: 1, name: "Ralph Inesonson" }] }) });
  assert.equal(code(res), "person_not_found"); assert.equal(res.body.error.details.name, "Ralph Ineson");
});
await t("unknown gender → they/their, empty bio → null, medium confidence", async () => {
  const { res } = await run({ recognise: async () => ({ CelebrityFaces: [{ ...ineson, MatchConfidence: 90 }] }), tmdbGet: async (p) => p.startsWith("/find") ? { person_results: [{ id: 69 }] } : { ...person, gender: 0, biography: "  " } });
  assert.equal(res.body.person.pronouns.possessive, "their"); assert.equal(res.body.person.biography, null); assert.equal(res.body.match.confidenceLevel, "medium");
});
// ---- rate limiting ----
await t("under the per-address limit, requests pass", async () => {
  const limits = { perAddress: { limit: 3, windowMs: 1000 }, global: DEFAULT_LIMITS.global };
  const { h } = handlerWith({ limiter: createLimiter(), limits });
  for (let i = 0; i < 3; i++) {
    const res = makeRes();
    await h(makeReq({ address: "1.2.3.4" }), res);
    assert.equal(res.statusCode, 200);
  }
});

await t("429 rate_limited once the per-address limit is passed", async () => {
  const limits = { perAddress: { limit: 2, windowMs: 1000 }, global: DEFAULT_LIMITS.global };
  const { h } = handlerWith({ limiter: createLimiter(), limits });
  for (let i = 0; i < 2; i++) await h(makeReq({ address: "1.2.3.4" }), makeRes());
  const res = makeRes();
  await h(makeReq({ address: "1.2.3.4" }), res);
  assert.equal(res.statusCode, 429);
  assert.equal(code(res), "rate_limited");
  assert.ok(Number(res.headers["Retry-After"]) >= 1, "Retry-After is set");
});

await t("a throttled request never reaches Rekognition", async () => {
  let recognitions = 0;
  const limits = { perAddress: { limit: 1, windowMs: 1000 }, global: DEFAULT_LIMITS.global };
  const { h } = handlerWith({
    limiter: createLimiter(), limits,
    recognise: async () => { recognitions++; return { CelebrityFaces: [ineson], UnrecognizedFaces: [] }; },
  });
  await h(makeReq({ address: "5.6.7.8" }), makeRes());
  await h(makeReq({ address: "5.6.7.8" }), makeRes());
  assert.equal(recognitions, 1, "the second, throttled request must not call Rekognition");
});

await t("addresses are counted separately", async () => {
  const limits = { perAddress: { limit: 1, windowMs: 1000 }, global: DEFAULT_LIMITS.global };
  const { h } = handlerWith({ limiter: createLimiter(), limits });
  await h(makeReq({ address: "1.1.1.1" }), makeRes());
  const res = makeRes();
  await h(makeReq({ address: "2.2.2.2" }), res);
  assert.equal(res.statusCode, 200, "a different address has its own allowance");
});

await t("the global ceiling applies across addresses", async () => {
  const limits = { perAddress: { limit: 99, windowMs: 1000 }, global: { limit: 2, windowMs: 1000 } };
  const { h } = handlerWith({ limiter: createLimiter(), limits });
  await h(makeReq({ address: "1.1.1.1" }), makeRes());
  await h(makeReq({ address: "2.2.2.2" }), makeRes());
  const res = makeRes();
  await h(makeReq({ address: "3.3.3.3" }), res);
  assert.equal(res.statusCode, 429, "the global ceiling ignores which address asked");
});

await t("an unauthorised request does not consume quota", async () => {
  const limits = { perAddress: { limit: 1, windowMs: 1000 }, global: DEFAULT_LIMITS.global };
  const { h } = handlerWith({ limiter: createLimiter(), limits });
  await h(makeReq({ address: "9.9.9.9", key: "wrong" }), makeRes());
  const res = makeRes();
  await h(makeReq({ address: "9.9.9.9" }), res);
  assert.equal(res.statusCode, 200, "the rejected request must not have used the allowance");
});

console.log(`\n${n} tests passed`);
