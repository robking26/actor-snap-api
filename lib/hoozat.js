// Hoozat identify v2 — pure logic, no network. The handler in api/v2/identify.js injects AWS + TMDB.
import crypto from "node:crypto";
import { createLimiter, clientAddress, DEFAULT_LIMITS } from "./rate-limit.js";

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // Vercel rejects request bodies over 4.5 MB
export const CONFIDENCE_LEVELS = { high: 0.95, medium: 0.85 }; // below medium = "low"
export const NOTABLE_LIMIT = 10;
export const TMDB_ATTRIBUTION = "This product uses the TMDB API but is not endorsed or certified by TMDB.";

const IMAGE_BASE = "https://image.tmdb.org/t/p/";
const APPEARANCE_GENRES = new Set([10763, 10764, 10767]); // TMDB TV genres: News, Reality, Talk
const SELF_ROLE = /^\s*(self|himself|herself|themselves|themself)\b/i;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------- request

export function keysMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, "image_too_large", `Image must be under ${Math.floor(limit / 1024 / 1024)} MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function detectImageType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  return null;
}

// ---------------------------------------------------------------- recognition

export function mapRecognitionError(e) {
  switch (e?.name) {
    case "InvalidImageFormatException":
      return new ApiError(415, "unsupported_image", "Send a JPEG or PNG image");
    case "ImageTooLargeException":
      return new ApiError(413, "image_too_large", "Image is too large to process");
    case "InvalidParameterException":
      return new ApiError(422, "invalid_image", "Image couldn't be processed");
    case "ThrottlingException":
    case "ProvisionedThroughputExceededException":
      return new ApiError(503, "busy", "Too many requests, try again shortly");
    default:
      return new ApiError(502, "recognition_unavailable", "Recognition service unavailable");
  }
}

const boxArea = (b) => (b?.Width ?? 0) * (b?.Height ?? 0);

// The main subject is the largest face in frame. If that face isn't a known celebrity we say so,
// rather than silently returning a smaller background face that happens to be recognised.
export function selectFace(result) {
  const faces = [
    ...(result?.CelebrityFaces ?? []).map((c) => ({ celeb: c, box: c.Face?.BoundingBox })),
    ...(result?.UnrecognizedFaces ?? []).map((f) => ({ celeb: null, box: f.BoundingBox })),
  ];
  if (faces.length === 0) throw new ApiError(422, "no_face", "No face found in the image");

  faces.sort((a, b) => boxArea(b.box) - boxArea(a.box));
  const primary = faces[0];
  if (!primary.celeb) {
    throw new ApiError(404, "not_recognised", "The main face wasn't recognised", { faceCount: faces.length });
  }

  const c = primary.celeb;
  const confidence = round((c.MatchConfidence ?? 0) / 100, 4);
  const imdbUrl = (c.Urls ?? []).find((u) => /imdb\.com\/name\/nm\d+/i.test(u));
  const box = primary.box ?? {};
  return {
    name: c.Name,
    imdbId: imdbUrl ? imdbUrl.match(/(nm\d+)/i)[1].toLowerCase() : null,
    confidence,
    confidenceLevel: confidenceLevel(confidence),
    faceCount: faces.length,
    boundingBox: { left: box.Left ?? 0, top: box.Top ?? 0, width: box.Width ?? 0, height: box.Height ?? 0 },
  };
}

export function confidenceLevel(c) {
  if (c >= CONFIDENCE_LEVELS.high) return "high";
  if (c >= CONFIDENCE_LEVELS.medium) return "medium";
  return "low";
}

// ---------------------------------------------------------------- TMDB

export function normaliseName(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// IMDb ID first (exact). Name search only as fallback, and only on an exact normalised name match.
export async function resolvePerson(tmdbGet, face) {
  if (face.imdbId) {
    const found = await tmdbGet(`/find/${face.imdbId}`, { external_source: "imdb_id" });
    const p = found?.person_results?.[0];
    if (p?.id) return { id: p.id, method: "imdb" };
  }
  const target = normaliseName(face.name);
  const search = await tmdbGet("/search/person", { query: face.name, include_adult: false });
  const exact = (search?.results ?? []).filter((p) => normaliseName(p.name) === target);
  if (exact.length === 0) return null;
  exact.sort(
    (a, b) =>
      Number(b.known_for_department === "Acting") - Number(a.known_for_department === "Acting") ||
      (b.popularity ?? 0) - (a.popularity ?? 0)
  );
  return { id: exact[0].id, method: "name" };
}

export function imageUrl(path, size) {
  return path ? `${IMAGE_BASE}${size}${path}` : null;
}

// One entry per title. TMDB lists the same show once per character; merge them.
export function buildCredits(cast) {
  const byKey = new Map();
  for (const c of cast ?? []) {
    if (c.media_type !== "movie" && c.media_type !== "tv") continue;
    if (c.adult) continue;
    const isTv = c.media_type === "tv";
    const key = `${c.media_type}:${c.id}`;
    const date = (isTv ? c.first_air_date : c.release_date) || null;
    let e = byKey.get(key);
    if (!e) {
      const year = date ? Number(date.slice(0, 4)) : null;
      e = {
        key,
        id: c.id,
        mediaType: c.media_type,
        title: (isTv ? c.name ?? c.original_name : c.title ?? c.original_title) ?? "",
        date,
        year: Number.isFinite(year) ? year : null,
        characters: [],
        episodeCount: isTv ? 0 : null,
        posterPath: c.poster_path ?? null,
        voteCount: c.vote_count ?? 0,
        _popularity: c.popularity ?? 0,
        _genres: c.genre_ids ?? [],
        _order: null,
      };
      byKey.set(key, e);
    }
    const character = String(c.character ?? "").trim();
    if (character && !e.characters.includes(character)) e.characters.push(character);
    if (isTv) e.episodeCount += c.episode_count ?? 0;
    if (Number.isFinite(c.order)) e._order = e._order == null ? c.order : Math.min(e._order, c.order);
    if (!e.posterPath && c.poster_path) e.posterPath = c.poster_path;
  }

  const credits = [...byKey.values()].map((e) => {
    e.isAppearance =
      e._genres.some((g) => APPEARANCE_GENRES.has(g)) ||
      (e.characters.length > 0 && e.characters.every((ch) => SELF_ROLE.test(ch)));
    e.posterUrl = imageUrl(e.posterPath, "w500");
    return e;
  });

  // Newest first. Undated credits last. Same year: latest date, then most popular.
  credits.sort(
    (a, b) =>
      (b.year ?? -Infinity) - (a.year ?? -Infinity) ||
      String(b.date ?? "").localeCompare(String(a.date ?? "")) ||
      b._popularity - a._popularity
  );
  return credits;
}

function roleWeight(c) {
  if (c.mediaType === "tv") return c.episodeCount >= 5 ? 1 : c.episodeCount >= 2 ? 0.8 : 0.5;
  if (c._order == null) return 0.8;
  return c._order <= 5 ? 1 : c._order <= 15 ? 0.8 : 0.5;
}

// "You may know him from": widely seen titles where the role is substantial. Excludes talk/news/reality
// and playing themselves; needs a poster to render a card.
export function pickNotable(credits, limit = NOTABLE_LIMIT) {
  return credits
    .filter((c) => !c.isAppearance && c.posterPath)
    .map((c) => ({ c, score: Math.log10(c.voteCount + 1) * roleWeight(c) }))
    .sort((a, b) => b.score - a.score || b.c._popularity - a.c._popularity)
    .slice(0, limit)
    .map((x) => x.c);
}

const GENDERS = { 1: "female", 2: "male", 3: "non_binary" };
const PRONOUNS = {
  female: { subject: "she", object: "her", possessive: "her" },
  male: { subject: "he", object: "him", possessive: "his" },
  non_binary: { subject: "they", object: "them", possessive: "their" },
  unknown: { subject: "they", object: "them", possessive: "their" },
};

const publicCredit = ({ _popularity, _genres, _order, ...rest }) => rest;

export function buildResponse(face, method, details) {
  const name = details?.name ?? face.name;
  const gender = GENDERS[details?.gender] ?? "unknown";
  const credits = buildCredits(details?.combined_credits?.cast);
  const notable = pickNotable(credits);
  const years = [...new Set(credits.map((c) => c.year).filter((y) => y != null))];

  return {
    version: 2,
    match: {
      confidence: face.confidence,
      confidenceLevel: face.confidenceLevel,
      method,
      faceCount: face.faceCount,
      boundingBox: face.boundingBox,
    },
    person: {
      tmdbId: details.id,
      imdbId: details?.external_ids?.imdb_id ?? face.imdbId ?? null,
      name,
      firstName: name.split(/\s+/)[0],
      gender,
      pronouns: PRONOUNS[gender],
      biography: details?.biography?.trim() || null,
      birthday: details?.birthday ?? null,
      placeOfBirth: details?.place_of_birth ?? null,
      knownForDepartment: details?.known_for_department ?? null,
      profilePath: details?.profile_path ?? null,
      profileUrl: imageUrl(details?.profile_path, "original"),
    },
    totals: {
      credits: credits.length,
      movie: credits.filter((c) => c.mediaType === "movie").length,
      tv: credits.filter((c) => c.mediaType === "tv").length,
    },
    filters: { years },
    notableCredits: notable.map(publicCredit),
    credits: credits.map(publicCredit),
    attribution: TMDB_ATTRIBUTION,
  };
}

const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;

// ---------------------------------------------------------------- handler

export function createHandler({
  appKey, recognise, tmdbGet, log = console,
  limiter = createLimiter(), limits = DEFAULT_LIMITS,
}) {
  return async function handler(req, res) {
    try {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        throw new ApiError(405, "method_not_allowed", "Use POST");
      }

      const expected = appKey();
      if (!expected) throw new ApiError(500, "server_misconfigured", "Server is missing HOOZAT_APP_KEY");
      if (!keysMatch(req.headers["x-hoozat-key"], expected)) {
        throw new ApiError(401, "unauthorised", "Missing or invalid app key");
      }

      // After auth so an unauthenticated flood cannot consume a legitimate caller's
      // quota, and before the body is read so a throttled request never reaches
      // Rekognition, which is the part that costs money.
      for (const [key, rule] of [
        [`ip:${clientAddress(req)}`, limits.perAddress],
        ["global", limits.global],
      ]) {
        const { allowed, retryAfter } = limiter.take(key, rule.limit, rule.windowMs);
        if (!allowed) {
          res.setHeader("Retry-After", String(retryAfter));
          throw new ApiError(429, "rate_limited", "Too many requests, try again later", { retryAfter });
        }
      }

      const bytes = await readBody(req, MAX_IMAGE_BYTES);
      if (bytes.length === 0) throw new ApiError(400, "no_image", "No image data received");
      if (!detectImageType(bytes)) throw new ApiError(415, "unsupported_image", "Send a JPEG or PNG image");

      let recognition;
      try {
        recognition = await recognise(bytes);
      } catch (e) {
        const mapped = mapRecognitionError(e);
        if (mapped.status >= 500) log.error("rekognition", e?.name, e?.message);
        throw mapped;
      }

      const face = selectFace(recognition);

      let resolved, details;
      try {
        resolved = await resolvePerson(tmdbGet, face);
        if (resolved) details = await tmdbGet(`/person/${resolved.id}`, {
          append_to_response: "combined_credits,external_ids",
          language: "en-US",
        });
      } catch (e) {
        if (e?.response?.status === 404) resolved = null;
        else {
          log.error("tmdb", e?.response?.status, e?.response?.data ?? e?.message);
          throw new ApiError(502, "profile_unavailable", "Profile service unavailable");
        }
      }
      if (!resolved || !details) {
        throw new ApiError(404, "person_not_found", "Recognised, but no matching TMDB profile", { name: face.name });
      }

      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(buildResponse(face, resolved.method, details));
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(500, "server_error", "Server error");
      if (!(e instanceof ApiError)) log.error("unhandled", e?.stack ?? e);
      const body = { error: { code: err.code, message: err.message } };
      if (err.details) body.error.details = err.details;
      return res.status(err.status).json(body);
    }
  };
}
