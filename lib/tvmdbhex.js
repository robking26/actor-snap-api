// The six colours a film or show is drawn in, from tvmdbhex.
//
// Hoozat's cards have no poster on them: each one is drawn in its title's own colours —
// the card filled with its `base`, a gradient down to its `identity1`, and five soft
// lights in the rest. Those colours come from tvmdbhex, which is keyed by TMDB id and
// media type — exactly what `buildCredits` already produces.
//
// **It was three colours and it is six**, because tvmdbhex replaced its palette algorithm.
// The old one ranked three by how much of the poster they covered and attached no job to
// any of them; the new one gives each a role, under `palette` on every result. The old
// `colors` field is still returned beside it, derived from the new roles — and it is
// deliberately *not* what this reads: three colours cannot fill a six-colour picture, and
// deriving the missing three here would be this file inventing design.
//
// **It is here rather than in the app for one reason: the key.** tvmdbhex authenticates
// with `X-API-Key`, and a key shipped inside an iOS binary is not a secret — `strings` on
// an extracted IPA finds it. So the phone never talks to tvmdbhex at all; this does, and
// the colours arrive on each credit in the identify response. That is the same rule Hoozat
// already keeps about TMDB and AWS: their credentials live here and nowhere else.
//
// **One request per scan, not three hundred.** The batch endpoint takes up to 500 titles,
// and a long filmography is nearer three hundred — so the whole of an actor's work is one
// POST. The app's first attempt at this asked per title from the device, which would have
// been a request per row against a free plan.
//
// **It never fails a scan.** Every failure here — no key, a bad status, a body that will
// not parse, a title the service has never seen — returns whatever colours it did get, and
// a credit with none draws Hoozat's brand palette instead. That is a designed state rather
// than a fallback, and it is the same call `fetchEpisodeTotals` makes beside it: an
// identification is not worth losing over an enrichment.

export const TVMDBHEX_BASE = "https://tvmdbhex.vercel.app";

// The service's own ceiling, stated in its documentation.
export const LOOKUP_BATCH = 500;

// Long enough for a batch of five hundred, short enough that it cannot be what makes a
// scan feel slow. It runs beside the TMDB run-length fetch rather than after it, so this
// is a ceiling on the damage rather than time anybody normally waits.
const TIMEOUT_MS = 6000;

const HEX = /^#[0-9a-fA-F]{6}$/;

// The six roles, in the order the artwork uses them. Exported so a test names the same
// list this does rather than a copy of it.
export const COLOUR_ROLES = [
  "base",
  "identity1",
  "identity2",
  "highlight1",
  "highlight2",
  "accent",
];

// `mediaType:id`, which is `Credit.key` — the contract's own identity, and the one thing
// that does not collide when a film and a show share a TMDB id.
export const colourKey = (mediaType, tmdbId) => `${mediaType}:${tmdbId}`;

/**
 * The six hex strings off one result, or null.
 *
 * `palette` is null for a title the service holds but has nothing for yet — no poster, or
 * still pending — which its documentation names as a case to expect rather than an error.
 * It is also null for a title it coloured under the **old** algorithm and has not
 * re-coloured: those rows carry `colors` and no `palette`, which is the state a fresh
 * deployment spends its first day in. Null is what a credit gets in all three, and the app
 * draws its brand palette.
 *
 * **Flat strings, not swatches.** The old `colors` nested a `hex` and a `ratio` under each
 * name; `palette` is six plain `#RRGGBB` strings, and the coverage share the old one
 * carried has no consumer — the artwork decides how much of itself each colour gets.
 *
 * **Strict on the shape, deliberately.** Anything that is not six `#RRGGBB` strings
 * returns null rather than a colour that is quietly wrong, for the same reason Hoozat's own
 * hex parser refuses `#RGB`: a service that changes shape should be met by a change here.
 * All six or none — the app has no picture to draw with five.
 */
export function coloursFrom(result) {
  const p = result?.palette;
  if (!p) return null;

  const colours = {};
  for (const role of COLOUR_ROLES) {
    const hex = p[role];
    if (!HEX.test(hex ?? "")) return null;
    colours[role] = hex;
  }
  return colours;
}

/**
 * Which credit a batch result belongs to.
 *
 * **This is the one part of the request not stated anywhere readable from here**, so it
 * accepts the two spellings a result plausibly carries and returns null otherwise — and
 * `createColourLookup` logs that rather than dropping it quietly, because a rename here
 * means every card falls back to the brand palette and nothing else says so.
 */
export function resultKey(result) {
  const mediaType = result?.media_type ?? result?.mediaType;
  const tmdbId = result?.tmdb_id ?? result?.tmdbId ?? result?.id;
  if ((mediaType !== "movie" && mediaType !== "tv") || !Number.isFinite(Number(tmdbId))) {
    return null;
  }
  return colourKey(mediaType, Number(tmdbId));
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * A `lookupColours(credits)` that answers a `Map` of `Credit.key` to its three colours.
 *
 * `apiKey` is a function rather than a value, as `createHandler`'s `appKey` is: the
 * environment is read when a request arrives rather than when the module loads, so a key
 * set in the Vercel dashboard takes effect on the next request rather than the next deploy.
 */
export function createColourLookup({
  apiKey,
  request = globalThis.fetch,
  base = TVMDBHEX_BASE,
  log = console,
} = {}) {
  // Everything goes through one line, so the report below cannot be filtered out of a
  // dashboard that only shows errors. `console.info` where there is one, `console.error`
  // otherwise — the tests' silent logger carries only the second.
  const say = (...parts) => (log.info ?? log.error)?.("tvmdbhex", ...parts);

  return async function lookupColours(credits) {
    const colours = new Map();
    const key = apiKey?.();

    // Not configured. A deployment with no TVMDBHEX_API_KEY draws every card in the brand
    // palette, which is a complete picture rather than a broken one — so this is a line in
    // the log and nothing else.
    if (!key) {
      log.error?.("tvmdbhex", "no TVMDBHEX_API_KEY — every title draws the brand palette");
      return colours;
    }
    if (!credits?.length) return colours;

    const batches = chunk(
      credits.map((c) => ({ media_type: c.mediaType, tmdb_id: c.id })),
      LOOKUP_BATCH
    );

    // What the run did, counted as it goes. **The summary at the end always prints**, and
    // that is the whole point of it: the first version of this file logged only the
    // failures it had thought of, so a response whose envelope is not `results`, a result
    // whose `colors` will not parse, and a flawless run were all *silent* — three
    // different states with one symptom, every card in the brand palette and not a line
    // in the log to tell them apart. A fallback that hides a fault needs a line saying
    // which it took, and "nothing happened" has to be one of the things it can say.
    let asked = 0, returned = 0, coloured = 0, unkeyed = 0, unparsed = 0, failed = 0;
    // Titles still on the old three-colour algorithm — see the branch that counts it.
    let legacy = 0;
    const envelopes = new Set();

    await Promise.all(
      batches.map(async (items) => {
        asked += items.length;
        let payload;
        try {
          payload = await post(`${base}/v1/lookup`, { items }, key, request);
        } catch (e) {
          failed += 1;
          log.error?.("tvmdbhex", e?.message ?? e);
          return;
        }

        const results = payload?.results;
        if (!Array.isArray(results)) {
          // The envelope is not what this expects. Its own keys are the fix, so they go
          // in the line rather than a count — the batch shape is the one part of this API
          // that could not be read from its documentation.
          for (const k of Object.keys(payload ?? {})) envelopes.add(k);
          log.error?.(
            "tvmdbhex",
            `no \`results\` array in the answer — its keys are [${Object.keys(payload ?? {}).join(", ")}]`
          );
          return;
        }

        returned += results.length;
        for (const result of results) {
          const k = resultKey(result);
          if (!k) {
            unkeyed += 1;
            if (unkeyed === 1) {
              log.error?.("tvmdbhex", "a result carried no media_type and tmdb_id", Object.keys(result ?? {}));
            }
            continue;
          }
          const c = coloursFrom(result);
          if (c) {
            colours.set(k, c);
            coloured += 1;
          } else if (result?.palette) {
            // Held, but not as six `#RRGGBB` strings. `palette: null` is a documented
            // answer and is not this; this is a shape that moved.
            unparsed += 1;
            if (unparsed === 1) {
              log.error?.("tvmdbhex", "a result's palette did not parse", JSON.stringify(result.palette)?.slice(0, 200));
            }
          } else if (result?.colors) {
            // **Not a fault: a title the service has not re-coloured yet.** It holds three
            // colours from the old algorithm and no six-role palette, which is what every
            // row looks like until tvmdbhex has run against them again. Counted separately
            // from `unparsed` precisely because the two want opposite responses — this one
            // wants waiting, that one wants somebody to look.
            legacy += 1;
          }
        }
      })
    );

    // **One probe when a batch failed, and only then.** A 500 from `/v1/lookup` says the
    // service threw, and nothing in it says whether the fault is the batch endpoint, the
    // key, or the whole service — three different people's problem. The single-title
    // endpoint answers that in one request: a 200 or a 404 means the key works and the
    // service is up, so `/v1/lookup` is the broken part; a 401 means the key; a 500 means
    // all of it.
    //
    // A probe rather than a fallback. Falling back would be a request per title, which is
    // the three hundred this file exists to avoid — and a scan drawing brand cards is a
    // complete picture, so there is nothing here worth that.
    if (failed && credits[0]) {
      await probe(base, credits[0], key, request, log);
    }

    say(
      `asked ${asked} in ${batches.length} batch(es), ${returned} returned, ` +
      `${coloured} coloured` +
      (legacy ? `, ${legacy} not re-coloured yet (old 3-colour rows)` : "") +
      (unkeyed ? `, ${unkeyed} unkeyed` : "") +
      (unparsed ? `, ${unparsed} unparseable` : "") +
      (failed ? `, ${failed} batch(es) failed` : "") +
      (envelopes.size ? `, envelope keys [${[...envelopes].join(", ")}]` : "")
    );

    return colours;
  };
}

/// Ask the single-title endpoint about one credit, purely to say which side is broken.
/// It never contributes a colour — the answer goes in the log and nowhere else.
async function probe(base, credit, key, request, log) {
  const url = `${base}/v1/${credit.mediaType}/${credit.id}`;
  try {
    const res = await request(url, { method: "GET", headers: { "X-API-Key": key } });
    log.error?.(
      "tvmdbhex",
      `probe ${url} → HTTP ${res.status} — ` +
        (res.status === 401
          ? "the key is wrong or not set on tvmdbhex"
          : res.ok || res.status === 404
            ? "the key works and the service is up, so /v1/lookup is the broken part"
            : "the service is erroring on single titles too")
    );
  } catch (e) {
    log.error?.("tvmdbhex", `probe ${url} could not be made: ${e?.message ?? e}`);
  }
}

async function post(url, body, key, request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await request(url, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      // The body, not just the status. A 401 and a 400 both leave every card brand, and
      // the difference is the whole of what a deployment needs to know.
      throw new Error(`HTTP ${res.status} from ${url}: ${(await safeText(res)).slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const safeText = async (res) => {
  try {
    return await res.text();
  } catch {
    return "<unreadable>";
  }
};
