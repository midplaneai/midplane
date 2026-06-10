// Fixed-window in-memory rate limiter for the ping/test surfaces.
// Per-process state — the web app runs as one long-lived instance per
// region today, the same assumption packages/router's inflightPushes
// map already bakes in. If the app ever scales horizontally, this
// moves to Postgres or Redis; the call sites won't change.

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

export interface RateLimitOptions {
  /** Max requests per window. */
  limit: number;
  windowMs: number;
  /** Injectable clock for tests. */
  now?: number;
}

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterS: number };

export function checkRateLimit(
  key: string,
  { limit, windowMs, now = Date.now() }: RateLimitOptions,
): RateLimitResult {
  // Opportunistic sweep so abandoned keys can't grow unbounded.
  if (buckets.size > MAX_BUCKETS) {
    for (const [k, b] of buckets) {
      if (now >= b.resetAt) buckets.delete(k);
    }
  }

  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }
  if (bucket.count < limit) {
    bucket.count += 1;
    return { ok: true };
  }
  return { ok: false, retryAfterS: Math.ceil((bucket.resetAt - now) / 1000) };
}

/** Test helper — clears all windows. */
export function resetRateLimits(): void {
  buckets.clear();
}
