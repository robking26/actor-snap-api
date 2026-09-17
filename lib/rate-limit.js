// Sliding-window request counters.
//
// Deliberately in-memory: adding Redis would mean another account, another set of
// credentials and another thing to go wrong, for a hobby app whose realistic threats are
// a runaway client loop and a casually extracted app key. The cost of that choice is that
// each serverless instance counts separately, so the true ceiling is the configured limit
// multiplied by however many instances are warm. It bounds abuse rather than eliminating
// it; the AWS budget alarm is the hard backstop.
//
// The store is injectable so a shared one can replace this without touching the handler.

export function createLimiter({ now = () => Date.now(), maxKeys = 10_000 } = {}) {
  const hits = new Map(); // key -> timestamps, ascending

  function sweep(cutoff) {
    for (const [k, times] of hits) {
      const kept = times.filter(t => t > cutoff);
      if (kept.length) hits.set(k, kept); else hits.delete(k);
    }
  }

  return {
    /** Records a hit and says whether it is within `limit` over `windowMs`. */
    take(key, limit, windowMs) {
      const t = now();
      const cutoff = t - windowMs;
      const times = (hits.get(key) ?? []).filter(x => x > cutoff);
      times.push(t);
      hits.set(key, times);
      if (hits.size > maxKeys) sweep(cutoff);
      return {
        allowed: times.length <= limit,
        // seconds until the oldest hit in the window falls out of it
        retryAfter: Math.max(1, Math.ceil((times[0] + windowMs - t) / 1000)),
      };
    },
  };
}

/** Vercel puts the client address first in x-forwarded-for. */
export function clientAddress(req) {
  const fwd = req.headers?.["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  if (Array.isArray(fwd) && fwd.length) return String(fwd[0]).split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export const DEFAULT_LIMITS = {
  // One caller. Generous for a person scanning their television.
  perAddress: { limit: 30, windowMs: HOUR },
  // Every caller together. The app key is shared by every install, so this is the only
  // figure that bounds a day's Rekognition spend.
  global: { limit: 500, windowMs: DAY },
};
