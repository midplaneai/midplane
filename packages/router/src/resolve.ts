import { asc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "@midplane-cloud/db/schema";
import {
  connectionDatabases,
  connections,
  mcpTokens,
  parseToken,
  validateChecksum,
  type Connection,
  type ConnectionDatabase,
} from "@midplane-cloud/db";
import { hashToken } from "@midplane-cloud/kms/pepper";
import type { Region } from "@midplane-cloud/kms";

export type Db = PostgresJsDatabase<typeof schema>;

/** Result of resolving a token: the matched token id, plus the parent
 *  connection and its child databases. PR2 adds the token id so the
 *  proxy can inject `X-Midplane-Token-Id` upstream and the indexer (via
 *  the OSS engine) can stamp it on every audit row from this session. */
export interface ResolvedConnection {
  tokenId: string;
  connection: Connection;
  databases: ConnectionDatabase[];
}

/** Discriminated outcome of {@link resolveByToken}.
 *
 *  `{ ok: false, reason }` lets the two token-auth callers (the MCP proxy
 *  and the /mcp/<token>/health probe) map a paused connection to a distinct
 *  403 ("connection paused by owner") instead of a token-not-found 404 —
 *  without each having to remember the check. Centralizing the gate here,
 *  next to the `status='active'` filter, means no future caller can forget
 *  it. `not_found` keeps the existing leakage-avoidance contract: malformed
 *  input, bad CRC, unknown/revoked/expired token, and wrong-region all
 *  collapse to the same opaque outcome. */
export type ResolveResult =
  | ({ ok: true } & ResolvedConnection)
  | { ok: false; reason: "not_found" | "paused" };

/** Resolve a plaintext MCP token to the (token_id, connection, databases)
 *  triple the proxy needs to forward a request.
 *
 *  Pipeline (PR2 — mcp_url_auth_security):
 *    1. Format-validate plaintext (prefix + 32 hex + 6-char Crockford CRC).
 *       Malformed tokens cost zero DB hits.
 *    2. HMAC-SHA256(pepper, plaintext) under each pepper kid in the
 *       caller's map; lookup by hash on `mcp_tokens` filtered to
 *       `status='active'` AND `(expires_at IS NULL OR expires_at > NOW())`.
 *       `NOW()` is the DB clock — clock skew can't sneak a token past
 *       its expiry on the runtime path.
 *    3. Load the parent connection + child databases for the matched
 *       connection_id, ordered by name (stable spawn-time YAML order).
 *
 *  Returns `{ ok: false, reason: "not_found" }` for every non-matching
 *  shape: malformed input, bad CRC, unknown hash, revoked/expired row,
 *  wrong-region request (the pepper is per-region; an EU token presented to
 *  the US regional DB yields no match). The caller turns not_found into a
 *  404 — never a 401, to avoid leaking existence of valid tokens via timing.
 *
 *  Returns `{ ok: false, reason: "paused" }` when the token is valid but its
 *  parent connection is paused — the caller turns this into a distinct 403.
 *  The token still exists and resolves; only the connection is gated, so
 *  this is deliberately NOT folded into not_found.
 *
 *  Note on the `peppers` shape: V1 has exactly one pepper per region
 *  (`v1-eu` / `v1-us`); rotation introduces additional kids and the
 *  lookup tries each blind against `token_hash`. */
export async function resolveByToken(
  db: Db,
  plaintext: string,
  region: Region,
  peppers: Map<string, Buffer>,
): Promise<ResolveResult> {
  // Format gate before anything else — keeps malformed inputs from ever
  // touching Postgres or the HMAC path, and keeps the timing surface
  // smaller (parser + CRC are O(token length), constant-time).
  const parsed = parseToken(plaintext);
  if (!parsed) return { ok: false, reason: "not_found" };
  if (!validateChecksum(parsed)) return { ok: false, reason: "not_found" };

  // Hash lookup against mcp_tokens. We try each pepper kid in the map;
  // V1 always has exactly one, but pepper rotation introduces a window
  // where rows hashed under v1 and v2 coexist and the lookup must walk
  // both. status + expires_at filtered in the WHERE so revoked/expired
  // rows never resolve at the runtime boundary.
  let tokenId: string | null = null;
  let connectionId: string | null = null;
  for (const pepper of peppers.values()) {
    const hash = hashToken(pepper, plaintext);
    const rows = await db
      .select({ id: mcpTokens.id, connectionId: mcpTokens.connectionId })
      .from(mcpTokens)
      .where(
        sql`${mcpTokens.tokenHash} = ${hash}
            AND ${mcpTokens.kind} = 'url'
            AND ${mcpTokens.status} = 'active'
            AND (${mcpTokens.expiresAt} IS NULL
                 OR ${mcpTokens.expiresAt} > NOW())`,
      )
      .limit(1);
    if (rows.length > 0) {
      tokenId = rows[0]!.id;
      connectionId = rows[0]!.connectionId;
      break;
    }
  }
  if (!tokenId || !connectionId) return { ok: false, reason: "not_found" };

  // Region passed in is the regional process's bootRegion(); a cross-
  // region presentation would already have missed at the hash step
  // because the pepper is per-region. We keep the parameter for symmetry
  // with lookupByPlaintext + future per-region routing tests; consumed
  // by reference, not used directly here.
  void region;

  const connRows = await db
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);
  const connection = connRows[0];
  if (!connection) {
    // mcp_tokens FK ON DELETE CASCADE means this is unreachable under
    // normal operation — a token can't outlive its connection. Bail
    // defensively in case a partial write or future migration leaves a
    // torn pair.
    return { ok: false, reason: "not_found" };
  }
  // Pause gate — the reversible kill switch. A valid token resolved, but the
  // owner has paused the connection: reject before spawning/forwarding so no
  // agent request reaches the engine. Distinct from not_found so the caller
  // can return a 403 ("paused by owner") rather than a token-not-found 404.
  if (connection.pausedAt) return { ok: false, reason: "paused" };
  const dbRows = await db
    .select()
    .from(connectionDatabases)
    .where(eq(connectionDatabases.connectionId, connection.id))
    .orderBy(asc(connectionDatabases.name));
  return { ok: true, tokenId, connection, databases: dbRows };
}

/** Outcome of {@link resolveConnectionForCustomer}: the same connection +
 *  databases triple as a token resolve, minus the token id (the OAuth path
 *  mints/looks up its own attribution token separately). Shares the not_found /
 *  paused discrimination so the proxy maps the same statuses. */
export type ConnectionResolveResult =
  | { ok: true; connection: Connection; databases: ConnectionDatabase[] }
  | { ok: false; reason: "not_found" | "paused" };

/** Resolve a connection by id for the MCP-OAuth proxy path, ownership-gated on
 *  the customer the OAuth bearer mapped to.
 *
 *  The OAuth flow authenticates the agent's USER (and OAuth client); the URL
 *  path selects which connection. This loads that connection ONLY if it belongs
 *  to the resolved customer — an unowned or unknown id collapses to `not_found`
 *  (same leakage-avoidance shape as resolveByToken; the caller returns 404,
 *  never a 403/401 that would confirm the id exists). A paused connection
 *  resolves to `{ ok: false, reason: "paused" }` so the caller returns the
 *  distinct 403, exactly as the token path does.
 *
 *  No HMAC, no pepper: the bearer was already validated by withMcpAuth. */
export async function resolveConnectionForCustomer(
  db: Db,
  connectionId: string,
  customerId: string,
): Promise<ConnectionResolveResult> {
  const connRows = await db
    .select()
    .from(connections)
    .where(
      sql`${connections.id} = ${connectionId}
          AND ${connections.customerId} = ${customerId}`,
    )
    .limit(1);
  const connection = connRows[0];
  if (!connection) return { ok: false, reason: "not_found" };
  if (connection.pausedAt) return { ok: false, reason: "paused" };
  const dbRows = await db
    .select()
    .from(connectionDatabases)
    .where(eq(connectionDatabases.connectionId, connection.id))
    .orderBy(asc(connectionDatabases.name));
  return { ok: true, connection, databases: dbRows };
}

/** Truncate length-bound user-agent. The mcp_tokens.last_used_ua column
 *  is unbounded text; defending against a hostile agent string at the
 *  app boundary keeps a single bad request from bloating the row. */
const MAX_UA_LEN = 1024;

/** Conditional UPDATE of `mcp_tokens.last_used_*` with a 5-minute
 *  debounce. Bumped at the proxy boundary after a successful resolve.
 *
 *  Fire-and-forget: the caller does NOT await this — a slow Postgres
 *  must not block the forwarded MCP request, and a failed write must
 *  not fail the request. Errors land on the caller-supplied onError
 *  hook (typically a console.error in the proxy). The debounce predicate
 *  lives in SQL so two concurrent requests in the same window collapse
 *  to a single write at the row level. */
export async function bumpLastUsed(
  db: Db,
  tokenId: string,
  ip: string | null,
  ua: string | null,
): Promise<void> {
  const truncatedUa =
    ua === null ? null : ua.length > MAX_UA_LEN ? ua.slice(0, MAX_UA_LEN) : ua;
  // 5-min predicate: bump only when last_used_at is NULL or older than
  // 5 minutes. Dashboard "last used" is the surface; per-request bump
  // would burn write throughput on a chatty agent for no UX gain.
  //
  // The IP cast is parameterized: the driver binds `ip` as text and
  // Postgres casts to inet inside the row. A malformed string would
  // raise at execution time (caller's onError); the format validator
  // is the upstream gate.
  await db.execute(sql`
    UPDATE mcp_tokens
       SET last_used_at = NOW(),
           last_used_ip = ${ip}::inet,
           last_used_ua = ${truncatedUa}
     WHERE id = ${tokenId}
       AND status = 'active'
       AND (last_used_at IS NULL
            OR last_used_at < NOW() - interval '5 minutes')
  `);
}
