// Token lifetimes for the MCP OAuth grant (lib/auth.ts, the `mcp()` plugin's
// oidcConfig). Named constants rather than inline literals so the values are
// importable by the regression test — the failure they guard against is a
// SILENT one: drop either line and Better Auth's own defaults take over with no
// error, no log, and no test failure.
//
// Better Auth 1.6.x defaults (better-auth/dist/plugins/mcp/index.mjs):
// accessTokenExpiresIn 3600, refreshTokenExpiresIn 604800.

/** 1 hour. Same as the plugin default; pinned so the pair reads as one decision.
 *
 *  Short is right for the access token: it's a bearer, and lib/proxy.ts re-reads
 *  the agent's attribution row on every request anyway, so an hour bounds a
 *  leaked token without the user ever noticing the rotation. */
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 3600;

/** 90 days IDLE — not 90 days absolute. The plugin rotates the refresh token on
 *  every use and re-stamps the expiry from `now`, so an agent in regular use
 *  never ages out; the clock only runs while the client is quiet.
 *
 *  The plugin default of 7 days is wrong for this product. These are interactive
 *  IDE agents a user connects once and expects to stay connected (unlimited
 *  interactive agents is the pitch — they're meant to accumulate). At 7 days, a
 *  laptop closed over a holiday comes back to a refresh that fails
 *  `invalid_grant`; the client invalidates its stored credentials and reports
 *  `needsAuth`, which reads as "Midplane is broken" rather than "sign in again".
 *  Cursor in particular surfaces it as a dead server with no tools.
 *
 *  Idle expiry is not the revocation control: revoking an agent flips its
 *  attribution row and lib/proxy.ts denies the NEXT call fail-closed, whatever
 *  life the token has left.
 *
 *  It IS, however, the replay window for a stolen refresh token — which is why
 *  this number is only safe alongside lib/mcp-refresh-rotation.ts. Better Auth
 *  rotates the refresh token without invalidating its predecessor, so on the
 *  stock plugin a copied token stays replayable for this entire window (and each
 *  replay mints another one). The /mcp/token after-hook expires the predecessor
 *  on every successful rotation, cutting the exposure to a 60-second grace.
 *  Do not raise this number back up without that hook in place. */
export const MCP_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90;
