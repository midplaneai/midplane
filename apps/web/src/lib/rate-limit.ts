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

// Shared budgets + key builders — the ONLY definitions of these
// invariants. Three surfaces share the ping budget (new-connection
// test, add-database test, saved-db test): one key per customer, so
// switching surfaces doesn't reset the window. The dry-run budget is
// per (customer, connection): the cost cap still holds per connection
// per tenant, and a foreign tenant probing someone else's connection
// id can't burn the owner's budget (review finding — the key must
// never be the unauthenticated path param alone).

export const PING_TEST_RATE_LIMIT = { limit: 10, windowMs: 60_000 } as const;

export function pingTestKey(customerId: string): string {
  return `test-dsn:${customerId}`;
}

export const DRY_RUN_RATE_LIMIT = { limit: 6, windowMs: 60_000 } as const;

export function dryRunKey(customerId: string, connectionId: string): string {
  return `dry-run:${customerId}:${connectionId}`;
}

export interface RateLimitOptions {
  /** Max requests per window. */
  limit: number;
  windowMs: number;
  /** Injectable clock for tests. */
  now?: number;
  /** Injectable sweep threshold for tests. */
  maxBuckets?: number;
}

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterS: number };

export function checkRateLimit(
  key: string,
  { limit, windowMs, now = Date.now(), maxBuckets = MAX_BUCKETS }: RateLimitOptions,
): RateLimitResult {
  // Opportunistic sweep so abandoned keys can't grow unbounded.
  if (buckets.size > maxBuckets) {
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
