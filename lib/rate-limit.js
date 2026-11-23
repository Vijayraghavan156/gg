'use strict';

// A small fixed-window request limiter kept in memory, per key (for example a
// client IP). The app has no shared limiter: sign-in counts failures in the
// login_failures table (routes/auth.js), which suits a per-account lockout
// but would turn a read-only public page into a database write. This one
// writes nothing, so a GET that uses it stays free of side effects. It
// limits one app process; behind several processes each counts on its own.

function createFixedWindowLimiter({ windowMs, max, maxKeys = 10000, now = () => Date.now() }) {
  const hits = new Map(); // key -> { count, resetAt }
  const limiter = {
    windowMs,
    max,
    // Counts one request for key. Returns { allowed, remaining, retryAfterSeconds }.
    hit(key) {
      const t = now();
      const k = String(key || 'unknown');
      let entry = hits.get(k);
      if (!entry || entry.resetAt <= t) {
        if (!entry && hits.size >= maxKeys) prune(t);
        entry = { count: 0, resetAt: t + limiter.windowMs };
        hits.set(k, entry);
      }
      entry.count += 1;
      const allowed = entry.count <= limiter.max;
      return {
        allowed,
        remaining: Math.max(0, limiter.max - entry.count),
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((entry.resetAt - t) / 1000)),
      };
    },
    reset() { hits.clear(); },
    size() { return hits.size; },
  };
  function prune(t) {
    for (const [k, entry] of hits) if (entry.resetAt <= t) hits.delete(k);
    // Still full: forget the oldest windows rather than grow without bound.
    while (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
  }
  return limiter;
}

module.exports = { createFixedWindowLimiter };
