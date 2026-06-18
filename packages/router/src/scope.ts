// Per-agent DB scope resolution — the proxy half of P6.1 least-privilege.
//
// A credential's grant lives in `mcp_scope_grants` (migration 0028), keyed by
// connection_database_id with a polymorphic subject: an OAuth (client_id,
// user_id) grant written at consent, or a headless-PAT (mcp_token_id) grant
// written at token creation. The proxy resolves the grant set for the presented
// credential, intersects it with the connection's databases, and forwards it to
// the engine as the `X-Midplane-Scope` header (db NAME → access). The engine
// then narrows that session to the granted subset and clamps writes where the
// grant is read-only (see engine scope.ts / table_access).
//
// This is the READ side (proxy). The WRITE side — the consent DB picker and the
// token-creation scope picker — lives in apps/web and writes the same rows.

import { and, eq, inArray } from "drizzle-orm";

import {
  mcpScopeGrants,
  type ConnectionDatabase,
  type McpScopeAccess,
} from "@midplane-cloud/db";

import type { Db } from "./resolve.ts";

/** Granted subset of a connection's databases: engine DB NAME → access. The
 *  X-Midplane-Scope header is keyed by name (the engine's alias), so we resolve
 *  connection_database_id grants back to names here. */
export type ScopeMap = Map<string, McpScopeAccess>;

/** Which credential we're resolving the grant for. OAuth grants are keyed by
 *  (client_id, user_id); headless PAT grants by the token's mcp_tokens id. */
export type ScopeSubject =
  | { kind: "oauth"; clientId: string; userId: string }
  | { kind: "token"; mcpTokenId: string };

/** Resolve the per-agent scope for a credential over a connection's databases.
 *  Returns a NAME→access map of ONLY the granted subset. EMPTY when the
 *  credential has no grant for any of the connection's DBs — the caller decides
 *  what empty means for its path (OAuth in cloud → 403; PAT or self-host →
 *  full access). A DB the connection has but the grant omits is simply absent
 *  from the map (the engine gates it out). */
export async function resolveScope(
  db: Db,
  subject: ScopeSubject,
  databases: ConnectionDatabase[],
): Promise<ScopeMap> {
  const nameById = new Map(databases.map((d) => [d.id, d.name]));
  const cdbIds = [...nameById.keys()];
  if (cdbIds.length === 0) return new Map();

  const subjectWhere =
    subject.kind === "oauth"
      ? and(
          eq(mcpScopeGrants.clientId, subject.clientId),
          eq(mcpScopeGrants.userId, subject.userId),
        )
      : eq(mcpScopeGrants.mcpTokenId, subject.mcpTokenId);

  const rows = (await db
    .select({
      connectionDatabaseId: mcpScopeGrants.connectionDatabaseId,
      access: mcpScopeGrants.access,
    })
    .from(mcpScopeGrants)
    .where(
      and(subjectWhere, inArray(mcpScopeGrants.connectionDatabaseId, cdbIds)),
    )) as Array<{ connectionDatabaseId: string; access: McpScopeAccess }>;

  const scope: ScopeMap = new Map();
  for (const r of rows) {
    const name = nameById.get(r.connectionDatabaseId);
    if (name) scope.set(name, r.access);
  }
  return scope;
}

/** Serialize a scope map to the `X-Midplane-Scope` header value, or null when
 *  the map is empty. Null = send NO header = the engine treats the session as
 *  unscoped (full access) — the caller uses this for the back-compat paths
 *  (PAT with no scope, self-host owner-all). The JSON shape is the engine's
 *  wire contract: a flat object of db name → "read" | "write". */
export function scopeHeaderValue(scope: ScopeMap): string | null {
  if (scope.size === 0) return null;
  return JSON.stringify(Object.fromEntries(scope));
}
