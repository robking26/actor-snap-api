import assert from "node:assert/strict";
import { createFixtureHandler } from "../lib/fixture.js";
import { createLimiter, HOUR, DAY } from "../lib/rate-limit.js";

const TOKEN = "fixture-token-123";

const person = {
  id: 69, name: "Ralph Ineson", gender: 2, biography: "  Ralph Michael Ineson is an English actor.  ",
  birthday: "1969-12-15", place_of_birth: "Leeds", known_for_department: "Acting", profile_path: "/p.jpg",
  external_ids: { imdb_id: "nm0408506" },
  combined_credits: { cast: [
    { media_type: "tv", id: 87108, name: "Chernobyl", first_air_date: "2019-05-06", character: "Nikolai Tarakanov", episode_count: 3, poster_path: "/c.jpg", vote_count: 6000, popularity: 50, genre_ids: [18] },
    { media_type: "movie", id: 617126, title: "The Fantastic Four: First Steps", release_date: "2025-07-23", character: "Galactus", order: 4, poster_path: "/f.jpg", vote_count: 3000, popularity: 200, genre_ids: [878] },
  ] },
};

const makeRes = () => {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

async function run({ token = () => TOKEN, query = { id: "69", token: TOKEN }, method = "GET", tmdbGet, limiter } = {}) {
  const calls = [];
  const handler = createFixtureHandler({
    token,
    limiter: limiter ?? createLimiter(),
    limits: { perAddress: { limit: 30, windowMs: HOUR }, global: { limit: 500, windowMs: DAY } },
    log: { error() {} },
    tmdbGet: async (path, params) => {
      calls.push(path);
      if (tmdbGet) return tmdbGet(path, params);
      return person;
    },
  });
  const res = makeRes();
  await handler({ method, query, headers: {} }, res);
  return { res, calls };
}

const code = (res) => res.body?.error?.code;
let failures = 0;
async function t(name, fn) {
  try { await fn(); console.log("  ok  " + name); }
  catch (e) { failures++; console.log("FAIL  " + name + "\n      " + e.message); }
}

await t("404 when the token is not configured — the route does not exist", async () => {
  const { res, calls } = await run({ token: () => undefined });
  assert.equal(res.statusCode, 404);
  assert.equal(code(res), "not_found");
  assert.deepEqual(calls, [], "must not reach TMDB");
});

await t("401 on a wrong token", async () => {
  const { res, calls } = await run({ query: { id: "69", token: "nope" } });
  assert.equal(res.statusCode, 401);
  assert.equal(code(res), "unauthorised");
  assert.deepEqual(calls, [], "must not reach TMDB");
});

await t("401 on a missing token", async () => {
  const { res } = await run({ query: { id: "69" } });
  assert.equal(code(res), "unauthorised");
});

await t("405 on anything but GET", async () => {
  const { res } = await run({ method: "POST" });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, "GET");
});

await t("400 on a missing or nonsense id", async () => {
  for (const id of [undefined, "", "abc", "-1", "0", "1.5"]) {
    const { res } = await run({ query: { id, token: TOKEN } });
    assert.equal(code(res), "invalid_id", `id=${String(id)}`);
  }
});

await t("404 when TMDB has no such person", async () => {
  const { res } = await run({ tmdbGet: async () => { throw Object.assign(new Error("404"), { response: { status: 404 } }); } });
  assert.equal(res.statusCode, 404);
  assert.equal(code(res), "person_not_found");
});

await t("502 when TMDB fails for any other reason", async () => {
  const { res } = await run({ tmdbGet: async () => { throw Object.assign(new Error("401"), { response: { status: 401 } }); } });
  assert.equal(res.statusCode, 502);
  assert.equal(code(res), "profile_unavailable");
});

await t("429 once the address has had its share", async () => {
  const limiter = createLimiter();
  for (let i = 0; i < 30; i++) await run({ limiter });
  const { res } = await run({ limiter });
  assert.equal(res.statusCode, 429);
  assert.equal(code(res), "rate_limited");
  assert.ok(res.headers["retry-after"]);
});

await t("200 returns the v2 shape, built the same way identify builds it", async () => {
  const { res, calls } = await run();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ["/person/69"]);
  assert.equal(res.headers["cache-control"], "no-store");

  const b = res.body;
  assert.equal(b.version, 2);
  assert.equal(b.person.name, "Ralph Ineson");
  assert.equal(b.person.tmdbId, 69);
  assert.equal(b.person.imdbId, "nm0408506");
  assert.equal(b.person.biography, "Ralph Michael Ineson is an English actor.");
  assert.equal(b.person.profileUrl, "https://image.tmdb.org/t/p/original/p.jpg");
  assert.equal(b.person.pronouns.possessive, "his");
  assert.equal(b.totals.credits, 2);
  assert.equal(b.credits[0].title, "The Fantastic Four: First Steps");
  assert.equal(b.credits[0].posterUrl, "https://image.tmdb.org/t/p/w500/f.jpg");
  assert.equal(b.credits[1].episodeCount, 3);
  assert.ok(b.attribution.includes("TMDB"));
});

await t("the match block is synthetic, and says high so a fixture is usable", async () => {
  const { res } = await run();
  assert.equal(res.body.match.method, "imdb");
  assert.equal(res.body.match.faceCount, 1);
  assert.equal(res.body.match.confidenceLevel, "high");
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
