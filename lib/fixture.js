// A way to get a real v2 response without Rekognition.
//
// The app's mock needs a fixture with real TMDB data in it — a real biography, real
// credits, and above all real image paths, since a poster path cannot be guessed and
// the app renders empty frames without them. Every other route to that data is shut:
// TMDB's API needs the key that lives in this service's environment, and /identify
// cannot be reached without Rekognition, which is the part that is down.
//
// So this takes a TMDB person id instead of a face and builds the response through
// buildResponse, exactly as /identify does. What comes out is byte-identical to a real
// identification of that person, bar the match block — see below.
//
// It is OFF unless HOOZAT_FIXTURE_TOKEN is set, and returns 404 when it is not, so it
// does not exist in a normal deployment. Set the variable while capturing a fixture and
// delete it afterwards. It is deliberately not the app key: this is a throwaway, it
// travels in a query string where the app key never should, and revoking it is a matter
// of deleting one environment variable.

import { ApiError, buildResponse, keysMatch, confidenceLevel } from "./hoozat.js";
import { createLimiter, DEFAULT_LIMITS, HOUR, DAY } from "./rate-limit.js";

/// The match block is invented, because no face was recognised — there was no image.
/// Everything under person, totals, filters, notableCredits and credits is real.
const SYNTHETIC_CONFIDENCE = 0.9921;

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

      if (!keysMatch(req.query?.token, expected)) {
        throw new ApiError(401, "unauthorised", "Missing or invalid fixture token");
      }

      const { allowed, retryAfter } = limiter.take(
        `fixture:${clientAddress(req)}`, limits.perAddress.limit, limits.perAddress.windowMs
      );
      if (!allowed) {
        res.setHeader("Retry-After", String(retryAfter));
        throw new ApiError(429, "rate_limited", "Too many requests, try again later", { retryAfter });
      }

      const id = Number(req.query?.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw new ApiError(400, "invalid_id", "Pass a TMDB person id as ?id=");
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
      return res.status(200).json(buildResponse(face, "imdb", details));
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(500, "server_error", "Server error");
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
    }
  };
}
