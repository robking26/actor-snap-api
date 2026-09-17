// A way to get a real v2 response without Rekognition.
//
// The app's mock needs a fixture with real TMDB data in it — a real biography, real
// credits, and above all real image paths, since a poster path cannot be guessed and
// the app renders empty frames without them. Every other route to that data is shut:
// TMDB's API needs the key that lives in this service's environment, and /identify
// cannot be reached without Rekognition, which is the part that is down.
//
// So this takes a person instead of a face and builds the response through
// buildResponse, exactly as /identify does. What comes out is byte-identical to a real
// identification of that person, bar the match block — see below.
//
// Say who with ?name=, ?imdb= or ?id=. A name goes through resolvePerson, the same exact
// normalised match /identify falls back to, so a name that identifies a person here
// identifies the same person there. Ask by name unless you already know the id: TMDB ids
// are not guessable and guessing one returns a real person who is not the one you meant.
//
// It is OFF unless HOOZAT_FIXTURE_TOKEN is set, and returns 404 when it is not, so it
// does not exist in a normal deployment. Set the variable while capturing a fixture and
// delete it afterwards. It is deliberately not the app key: this is a throwaway, it
// travels in a query string where the app key never should, and revoking it is a matter
// of deleting one environment variable.

import { ApiError, buildResponse, keysMatch, confidenceLevel, resolvePerson } from "./hoozat.js";
import { createLimiter, DEFAULT_LIMITS, HOUR, DAY } from "./rate-limit.js";

/// The match block is invented, because no face was recognised — there was no image.
/// Everything under person, totals, filters, notableCredits and credits is real.
const SYNTHETIC_CONFIDENCE = 0.9921;

/// `req.query` is populated by most serverless runtimes and by none of them reliably.
/// Falling back to the raw URL costs nothing and removes a whole class of failure.
function queryValue(req, key) {
  const fromQuery = req?.query?.[key];
  if (typeof fromQuery === "string") return fromQuery.trim();
  if (typeof fromQuery === "number") return String(fromQuery);
  // An array means the parameter was given twice; take neither, since which one was
  // meant is anyone's guess.
  if (Array.isArray(fromQuery)) return "";
  try {
    const url = new URL(req?.url ?? "", "http://localhost");
    return (url.searchParams.get(key) ?? "").trim();
  } catch {
    return "";
  }
}

export function createFixtureHandler({
  token, tmdbGet, log = console,
  limiter = createLimiter(),
  limits = { perAddress: { limit: DEFAULT_LIMITS.perAddress.limit, windowMs: HOUR },
             global: { limit: DEFAULT_LIMITS.global.limit, windowMs: DAY } },
  clientAddress = (req) => String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "unknown",
}) {
  return async function handler(req, res) {
    try {
      const expected = token();
      // Not configured is not an error to explain. Without the variable this route is
      // simply not part of the API.
      if (!expected) throw new ApiError(404, "not_found", "Not found");

      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        throw new ApiError(405, "method_not_allowed", "Use GET");
      }

      // Two things go wrong here often enough to be worth handling rather than
      // debugging twice. A value pasted into a dashboard field arrives with a trailing
      // newline surprisingly often, and req.query is not guaranteed on every runtime —
      // so the URL is parsed as a fallback rather than trusted to be pre-parsed.
      const provided = queryValue(req, "token");
      if (!provided) {
        throw new ApiError(401, "unauthorised", "No token in the query string", { reason: "missing" });
      }
      if (!keysMatch(provided, String(expected).trim())) {
        // Says that the token arrived and did not match, which is the difference between
        // "the URL is wrong" and "the value is wrong". Neither the token nor any part of
        // it is echoed.
        throw new ApiError(401, "unauthorised", "Token did not match", { reason: "mismatch" });
      }

      const { allowed, retryAfter } = limiter.take(
        `fixture:${clientAddress(req)}`, limits.perAddress.limit, limits.perAddress.windowMs
      );
      if (!allowed) {
        res.setHeader("Retry-After", String(retryAfter));
        throw new ApiError(429, "rate_limited", "Too many requests, try again later", { retryAfter });
      }

      const rawId = Number(queryValue(req, "id"));
      const name = queryValue(req, "name");
      const imdbId = queryValue(req, "imdb");

      let id = Number.isInteger(rawId) && rawId > 0 ? rawId : null;
      // The method reported in the response is how the person was actually found, so a
      // fixture says truthfully which route produced it.
      let method = "imdb";

      try {
        if (!id && (name || imdbId)) {
          const resolved = await resolvePerson(tmdbGet, { imdbId: imdbId || null, name });
          if (!resolved) {
            throw new ApiError(404, "person_not_found", "No exact TMDB match", { name: name || null });
          }
          id = resolved.id;
          method = resolved.method;
        }
      } catch (e) {
        if (e instanceof ApiError) throw e;
        log.error("tmdb", e?.response?.status, e?.response?.data ?? e?.message);
        throw new ApiError(502, "profile_unavailable", "Profile service unavailable");
      }

      if (!id) {
        throw new ApiError(400, "invalid_id", "Say who: ?name=, ?imdb= or ?id=");
      }

      let details;
      try {
        details = await tmdbGet(`/person/${id}`, {
          append_to_response: "combined_credits,external_ids",
          language: "en-US",
        });
      } catch (e) {
        if (e?.response?.status === 404) {
          throw new ApiError(404, "person_not_found", "No TMDB person with that id", { name: null });
        }
        log.error("tmdb", e?.response?.status, e?.response?.data ?? e?.message);
        throw new ApiError(502, "profile_unavailable", "Profile service unavailable");
      }

      const face = {
        name: details?.name ?? "",
        confidence: SYNTHETIC_CONFIDENCE,
        confidenceLevel: confidenceLevel(SYNTHETIC_CONFIDENCE),
        faceCount: 1,
        boundingBox: { left: 0.35, top: 0.2, width: 0.3, height: 0.4 },
        imdbId: details?.external_ids?.imdb_id ?? null,
      };

      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(buildResponse(face, method, details));
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(500, "server_error", "Server error");
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
    }
  };
}
