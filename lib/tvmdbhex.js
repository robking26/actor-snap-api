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

// The service's own ceiling, stated in its documentation. **It is not what this sends** —
// see `BATCH_SIZE`.
export const LOOKUP_BATCH = 500;

// How many titles go in one request.
//
// **This was 50 and it made the first scan worse, on a diagnosis that was simply wrong.**
// The note here used to read: "the first time anybody asks about those titles the service
// has to *produce* the palettes rather than look them up, so one request carried three
// hundred titles' worth of work on a single serverless invocation". That is not what
// `/v1/lookup` does. Reading `tvmdbhex/api.py` settles it: the endpoint is a `SELECT`
// against a `titles` table and nothing else, returning the rows it has and naming the rest
// as `missing`. `GET /v1/{media_type}/{tmdb_id}` is the same read and 404s on a miss.
// **Nothing on the request path computes a palette** — palettes get in through the
// ingester, offline. So asking twice cannot change the answer, and "it produces the first
// time" was a story that fitted the symptom rather than a fact about the service.
//
// **The symptom is a cold start, and chunking multiplied it.** tvmdbhex is
// `@vercel/python`: the first request on an instance pays FastAPI's import, a Postgres
// connect and an `ensure_schema` — the file's own comment anticipates "a concurrent cold
// start created it", which says as much. A serverless function takes one request at a
// time, so **six chunks in parallel is up to six instances, each paying that boot.** The
// budget expired against the boot, every card drew the brand palette, and the second scan
// was instant because the instance was warm. That is the same evidence read the right way
// round.
//
// So it goes back to the service's own ceiling: one POST is one `SELECT … IN (…)` per
// media type, which is the cheapest possible shape for a pure read, and one instance
// rather than six. The real fix is `warmColours` below, which pays the boot during the
// seconds the scan is already spending on Rekognition and TMDB.
//
// **The chunking machinery stays**, and not out of sentiment: it is what keeps a partial
// answer when the budget expires, and it is the guard that stops a filmography larger than
// the ceiling being sent as one illegal request.
export const BATCH_SIZE = LOOKUP_BATCH;

// **Six seconds was a ceiling on the damage and the damage was the point.** The argument
// for it was that this runs beside the TMDB run-length fetch rather than after it, so it
// costs whichever of the two is slower — true, and it quietly conceded that a sick
// tvmdbhex makes every scan six seconds longer than a healthy one. It has been sick: a
// 500 on `/v1/lookup` with every card falling back to the brand palette, which is a
// complete picture, so nothing on screen said the scan was paying for it.
//
// Two seconds instead, and the reason it can be that low is what the batch actually is.
// One POST carrying three hundred `{media_type, tmdb_id}` pairs against a service that
// holds the colours already — a lookup, not a render. Anything slower than two seconds is
// not a lookup having a slow day, it is the service computing or failing, and neither is
// worth a scan waiting for.
//
// **`createHandler` holds the same figure as a budget on the whole call**, because this
// one only bounds a single request: a batch that answers at 1.9 seconds followed by a
// probe would still have run long. Two guards, and they are the same number on purpose.
export const BUDGET_MS = 2000;

// The probe's own ceiling, and it is short because the probe buys a log line and nothing
// else. See `probe`.
const PROBE_MS = 1000;

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
 * Pays tvmdbhex's cold start while the scan is busy doing something else.
 *
 * **This is the fix for "the colours do not load first time", and it is about a boot
 * rather than about the work.** `/v1/lookup` is a `SELECT` — see `BATCH_SIZE` — so a warm
 * instance answers a whole filmography in milliseconds and a cold one answers nothing for
 * seconds: FastAPI's import, a Postgres connect and an `ensure_schema`, on
 * `@vercel/python`. The colour lookup cannot start until TMDB has said what the credits
 * are, so it has always arrived at the very moment the instance is most likely to be
 * cold, and the budget expired against the boot.
 *
 * **An empty `items` list is the whole trick.** FastAPI resolves the `conn` dependency
 * before the handler body runs, so this pays the import, the connect and the schema check
 * — the entire cold-start cost — and then the endpoint's own loop finds no ids and
 * executes no query at all. It is the real endpoint with the real key, which is what makes
 * it warm the path the lookup actually takes rather than some neighbouring one. `/health`
 * would have been the obvious choice and is the wrong one: it returns a literal and never
 * touches the database, so the connect would still be waiting for the lookup to pay.
 *
 * **Fired and forgotten, never awaited.** The scan must not wait for it and must not fail
 * on it: a rejection lands in the `.catch` here rather than as an unhandled one, and it is
 * logged rather than raised, because a warm-up that fails costs exactly what not having
 * one costs. It carries `BUDGET_MS` like everything else here, so a hanging service cannot
 * leave a request open behind a response that has already gone.
 */
export function createColourWarmUp({
  apiKey,
  request = globalThis.fetch,
  base = TVMDBHEX_BASE,
  log = console,
} = {}) {
  return function warmColours() {
    const key = apiKey?.();
    // No key is already reported once per scan by `lookupColours`; saying it twice for the
    // same deployment is noise.
    if (!key) return;
    post(`${base}/v1/lookup`, { items: [] }, key, request).catch((e) => {
      // `info`, not `error`. A cold start that is still cold when the lookup arrives is
      // the ordinary bad day this exists to improve, not a fault in the scan — and the
      // lookup's own summary line is what says whether it mattered.
      (log.info ?? log.error)?.("tvmdbhex", `warm-up did not land: ${e?.message ?? e}`);
    });
  };
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

  /// `into` is the caller's accumulator, and passing one is what makes a partial answer
  /// worth having: `createHandler` bounds this call, and a map filled in place still
  /// holds whatever landed when the budget expired. It is returned as well, so a caller
  /// that ignores the argument gets the old behaviour.
  return async function lookupColours(credits, into) {
    const colours = into ?? new Map();
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
      BATCH_SIZE
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
///
/// **It is bounded and it happens once, and both of those were missing.** A diagnostic
/// that buys a log line and nothing else was being made on every scan, after the batch
/// rather than beside it, with no timeout of its own — so a tvmdbhex that hangs on single
/// titles held a finished identification open for as long as the platform would let it.
/// The batch had an `AbortController` and this had nothing.
///
/// Once per process rather than once per scan: the line says which side is broken, and
/// the second time it says it about the same deployment it is noise. A cold start asks
/// again, which is the right cadence for something whose whole job is to be read later.
async function probe(base, credit, key, request, log) {
  if (probed) return;
  probed = true;

  const url = `${base}/v1/${credit.mediaType}/${credit.id}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_MS);
  timer.unref?.();

  try {
    const res = await request(url, {
      method: "GET",
      headers: { "X-API-Key": key },
      signal: controller.signal,
    });
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
  } finally {
    clearTimeout(timer);
  }
}

// Module scope, so it is per warm instance rather than per request. Exported as a reset
// rather than as the flag itself: a test needs to make the probe happen again, and
// nothing else has any business reading it.
let probed = false;
export const resetProbe = () => { probed = false; };

async function post(url, body, key, request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUDGET_MS);
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
