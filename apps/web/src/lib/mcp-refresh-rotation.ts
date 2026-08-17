// Predecessor invalidation for MCP OAuth refresh-token rotation.
//
// Better Auth ROTATES but does not INVALIDATE. Its refresh_token grant looks the
// presented token up, then `adapter.create()`s a brand-new oauthAccessToken row
// with a fresh access + refresh pair — and never touches the old row
// (better-auth/dist/plugins/oidc-provider/index.mjs, the `grant_type ===
// "refresh_token"` branch). The predecessor stays findable by the very same
// `findOne({ field: "refreshToken" })` the grant uses, and stays valid until its
// own `refreshTokenExpiresAt`.
//
// So the refresh token is really a bearer credential good for the WHOLE idle
// window, no matter how many times the legitimate client rotates on top of it. A
// copy lifted off disk (these sit in plaintext client config on most MCP hosts)
// can be replayed for that entire window, and each replay mints another 90-day
// token — the theft becomes self-renewing. At the plugin's 7-day default that
// window was already wrong; raising the idle window to 90 days
// (lib/mcp-token-lifetimes.ts) makes it indefensible. OAuth 2.1 / RFC 9700 §4.14
// is explicit that a public client's refresh tokens must be sender-constrained
// or rotated with the predecessor invalidated.
//
// The fix expires the predecessor instead of deleting it, which buys back the
// one thing naive rotation breaks: if the refresh RESPONSE is lost in flight
// (dropped connection after the server committed), the client still holds only
// the old token and its retry must work, or a laptop waking on flaky wifi gets
// signed out — the exact failure this whole change set exists to remove. A short
// grace covers the retry; after it, the old token is dead.
//
// Expiring rather than deleting also means no new enforcement path: the plugin
// already rejects `token.refreshTokenExpiresAt < new Date()` with
// `invalid_grant`. We move a timestamp; its existing check does the work.
//
// NOT covered: reuse DETECTION. RFC 9700 also suggests that replay of an
// already-rotated token should revoke the whole token family, since a replay
// proves a leak. That needs lineage on the row (the schema has no family
// column), so it stays a follow-up. What's here shrinks the replay window from
// the full idle window to `ROTATION_GRACE_SECONDS`; revocation remains the
// blunt instrument, and it is enforced per request against the attribution row
// in lib/proxy.ts regardless of token lifetime.

/** How long a rotated refresh token keeps working after its successor is issued.
 *
 *  Sized for one lost response and its retry, not for offline use: long enough
 *  that a dropped HTTP response doesn't sign the user out, short enough that a
 *  stolen token is worthless almost immediately. */
export const ROTATION_GRACE_SECONDS = 60;

/** The two adapter calls this needs — structurally satisfied by Better Auth's
 *  Adapter, so the hook passes `ctx.context.adapter` straight through and tests
 *  can pass the same instance. */
interface AccessTokenStore {
  findOne<T>(args: {
    model: string;
    where: { field: string; value: string }[];
  }): Promise<T | null>;
  update<T>(args: {
    model: string;
    where: { field: string; value: string }[];
    update: Record<string, unknown>;
  }): Promise<T | null>;
}

/** Token-hook entry point: after a SUCCESSFUL refresh exchange, pull the
 *  presented (now superseded) refresh token's expiry in to `now + grace`.
 *
 *  Returns whether a row was actually re-stamped, which the tests assert on.
 *  No-ops when the token is absent, unknown, or already expiring inside the
 *  grace window — the last case keeps a retry storm from repeatedly EXTENDING a
 *  token that is about to die on its own. */
export async function expirePredecessorRefreshToken(
  refreshToken: string | undefined,
  adapter: AccessTokenStore,
  now: Date = new Date(),
): Promise<boolean> {
  if (!refreshToken) return false;

  const row = await adapter.findOne<{ refreshTokenExpiresAt?: Date | string }>({
    model: "oauthAccessToken",
    where: [{ field: "refreshToken", value: refreshToken }],
  });
  if (!row) return false;

  const graceUntil = new Date(now.getTime() + ROTATION_GRACE_SECONDS * 1000);
  const current = row.refreshTokenExpiresAt
    ? new Date(row.refreshTokenExpiresAt)
    : null;
  // Only ever pull the expiry IN. A row already inside the window is left alone
  // so this can never push one further out.
  if (current && current.getTime() <= graceUntil.getTime()) return false;

  await adapter.update({
    model: "oauthAccessToken",
    where: [{ field: "refreshToken", value: refreshToken }],
    update: { refreshTokenExpiresAt: graceUntil },
  });
  return true;
}
