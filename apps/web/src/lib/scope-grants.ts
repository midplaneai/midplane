// Write side of the per-agent DB scope model (P6.1, migration 0028).
//
// The proxy READS mcp_scope_grants (packages/router/scope.ts resolveScope) to
// build the X-Midplane-Scope header. This module WRITES those rows:
//   - setOAuthGrants  — the consent DB picker (interactive agents), keyed
//                       (client_id, user_id).
//   - setTokenGrants  — the token-creation scope picker (API tokens), keyed
//                       mcp_token_id.
// Both are REPLACE-ALL within their key: the latest choice is the whole grant
// set, so re-consenting or re-scoping never leaves stale rows. Every selection
// is ownership-validated against the customer before it lands.

import { and, eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";

import {
  connectionDatabases,
  connections,
  getDb,
  mcpScopeGrants,
  type Customer,
  type McpScopeAccess,
} from "@midplane-cloud/db";

/** One DB the user can grant, for the consent picker — grouped by connection. */
export interface GrantableDatabase {
  connectionDatabaseId: string;
  name: string;
}
export interface GrantableConnection {
  connectionId: string;
  connectionName: string | null;
  databases: GrantableDatabase[];
}

/** A single DB selection from a picker: which DB, at what access. */
export interface ScopeSelection {
  connectionDatabaseId: string;
  access: McpScopeAccess;
}

/** Every database the customer owns, grouped by connection — the universe the
 *  OAuth consent picker offers (an agent's grant can span the user's
 *  connections). Ordered by connection then DB name for a stable UI. */
export async function listGrantableDatabases(
  customer: Customer,
): Promise<GrantableConnection[]> {
  const db = getDb(customer.region);
  const rows = await db
    .select({
      connectionId: connections.id,
      connectionName: connections.name,
      cdbId: connectionDatabases.id,
      cdbName: connectionDatabases.name,
    })
    .from(connections)
    .innerJoin(
      connectionDatabases,
      eq(connectionDatabases.connectionId, connections.id),
    )
    .where(eq(connections.customerId, customer.id));

  const byConnection = new Map<string, GrantableConnection>();
  for (const r of rows) {
    let entry = byConnection.get(r.connectionId);
    if (!entry) {
      entry = {
        connectionId: r.connectionId,
        connectionName: r.connectionName,
        databases: [],
      };
      byConnection.set(r.connectionId, entry);
    }
    entry.databases.push({ connectionDatabaseId: r.cdbId, name: r.cdbName });
  }
  const out = [...byConnection.values()];
  for (const c of out) c.databases.sort((a, b) => a.name.localeCompare(b.name));
  out.sort((a, b) =>
    (a.connectionName ?? a.connectionId).localeCompare(
      b.connectionName ?? b.connectionId,
    ),
  );
  return out;
}

/** Which of the supplied connection_database ids the customer actually owns.
 *  The grant table FK-references connection_databases, but ownership (the cdb's
 *  connection belongs to THIS customer) isn't enforced by the FK — so we filter
 *  here before writing. A foreign id is silently dropped (a tampered picker
 *  submit can't grant another tenant's DB; the proxy ownership check is the
 *  durable backstop anyway). */
async function ownedDbIds(
  db: ReturnType<typeof getDb>,
  customerId: string,
  cdbIds: string[],
): Promise<Set<string>> {
  if (cdbIds.length === 0) return new Set();
  const rows = await db
    .select({ id: connectionDatabases.id })
    .from(connectionDatabases)
    .innerJoin(
      connections,
      eq(connections.id, connectionDatabases.connectionId),
    )
    .where(
      and(
        eq(connections.customerId, customerId),
        inArray(connectionDatabases.id, cdbIds),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

/** Replace the OAuth grant set for (client_id, user_id) — SCOPED TO THIS
 *  CUSTOMER's databases — with `selections`. Ownership-validated; non-owned /
 *  duplicate selections are dropped. Runs in one txn so a re-consent is atomic
 *  (the agent never sees a half-applied set). Returns the number of grant rows
 *  written.
 *
 *  Why the delete is customer-scoped: a user can belong to more than one org
 *  (customer) in the same region, and the consent picker only offers the CURRENT
 *  customer's databases. The grant key is (client_id, user_id) — which spans
 *  customers — so a blanket delete on that key would wipe the SAME user+client's
 *  grants for ANOTHER customer's connections, 403-ing those agents. We restrict
 *  the replace to grants whose connection_database belongs to THIS customer; the
 *  selection then IS the complete grant set for this customer. (No customer_id
 *  column needed — the row's connection_database_id already ties it to a
 *  customer via connection_databases → connections.) */
export async function setOAuthGrants(
  customer: Customer,
  args: { clientId: string; userId: string; selections: ScopeSelection[] },
): Promise<number> {
  const db = getDb(customer.region);
  const owned = await ownedDbIds(
    db,
    customer.id,
    args.selections.map((s) => s.connectionDatabaseId),
  );
  const rows = dedupeSelections(args.selections, owned).map((s) => ({
    id: ulid(),
    connectionDatabaseId: s.connectionDatabaseId,
    clientId: args.clientId,
    userId: args.userId,
    access: s.access,
  }));

  await db.transaction(async (tx) => {
    // Scope the replace to THIS customer's connection_databases (subquery), so
    // re-consenting in one workspace can't clear another workspace's grants for
    // the same user+client. A different-customer grant for the same key survives.
    const customerDbIds = tx
      .select({ id: connectionDatabases.id })
      .from(connectionDatabases)
      .innerJoin(
        connections,
        eq(connections.id, connectionDatabases.connectionId),
      )
      .where(eq(connections.customerId, customer.id));
    await tx
      .delete(mcpScopeGrants)
      .where(
        and(
          eq(mcpScopeGrants.clientId, args.clientId),
          eq(mcpScopeGrants.userId, args.userId),
          inArray(mcpScopeGrants.connectionDatabaseId, customerDbIds),
        ),
      );
    if (rows.length > 0) await tx.insert(mcpScopeGrants).values(rows);
  });
  return rows.length;
}

/** Replace the grant set for an API token (mcp_token_id) with `selections`.
 *  A PAT is bound to ONE connection, so callers pass that connection's id and
 *  selections are validated to belong to it (and to the customer). Returns the
 *  number of grant rows written. */
export async function setTokenGrants(
  customer: Customer,
  args: {
    mcpTokenId: string;
    connectionId: string;
    selections: ScopeSelection[];
  },
): Promise<number> {
  const db = getDb(customer.region);
  // Restrict to DBs of THIS connection (owned by the customer).
  const connDbRows = await db
    .select({ id: connectionDatabases.id })
    .from(connectionDatabases)
    .innerJoin(
      connections,
      eq(connections.id, connectionDatabases.connectionId),
    )
    .where(
      and(
        eq(connections.customerId, customer.id),
        eq(connectionDatabases.connectionId, args.connectionId),
      ),
    );
  const owned = new Set(connDbRows.map((r) => r.id));
  const rows = dedupeSelections(args.selections, owned).map((s) => ({
    id: ulid(),
    connectionDatabaseId: s.connectionDatabaseId,
    mcpTokenId: args.mcpTokenId,
    access: s.access,
  }));

  await db.transaction(async (tx) => {
    await tx
      .delete(mcpScopeGrants)
      .where(eq(mcpScopeGrants.mcpTokenId, args.mcpTokenId));
    if (rows.length > 0) await tx.insert(mcpScopeGrants).values(rows);
  });
  return rows.length;
}

/** The current OAuth grant for (client, user) as a cdbId→access map — used to
 *  pre-check the consent picker so a re-consent shows the prior selection. */
export async function getOAuthGrantMap(
  customer: Customer,
  clientId: string,
  userId: string,
): Promise<Map<string, McpScopeAccess>> {
  const db = getDb(customer.region);
  const rows = await db
    .select({
      connectionDatabaseId: mcpScopeGrants.connectionDatabaseId,
      access: mcpScopeGrants.access,
    })
    .from(mcpScopeGrants)
    .where(
      and(
        eq(mcpScopeGrants.clientId, clientId),
        eq(mcpScopeGrants.userId, userId),
      ),
    );
  return new Map(rows.map((r) => [r.connectionDatabaseId, r.access]));
}

/** Keep only owned, last-wins-per-DB selections. Exported for unit testing the
 *  validation without a database. */
export function dedupeSelections(
  selections: ScopeSelection[],
  owned: Set<string>,
): ScopeSelection[] {
  const byId = new Map<string, McpScopeAccess>();
  for (const s of selections) {
    if (!owned.has(s.connectionDatabaseId)) continue;
    if (s.access !== "read" && s.access !== "write") continue;
    byId.set(s.connectionDatabaseId, s.access); // last wins
  }
  return [...byId.entries()].map(([connectionDatabaseId, access]) => ({
    connectionDatabaseId,
    access,
  }));
}
