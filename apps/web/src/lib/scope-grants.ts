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
  projectDatabases,
  projects,
  getDb,
  mcpScopeGrants,
  type Customer,
  type McpScopeAccess,
} from "@midplane-cloud/db";

/** One DB the user can grant, for the consent picker — grouped by project. */
export interface GrantableDatabase {
  projectDatabaseId: string;
  name: string;
}
export interface GrantableProject {
  projectId: string;
  projectName: string | null;
  databases: GrantableDatabase[];
}

/** A single DB selection from a picker: which DB, at what access. */
export interface ScopeSelection {
  projectDatabaseId: string;
  access: McpScopeAccess;
}

/** Every database the customer owns, grouped by project — the universe the
 *  OAuth consent picker offers (an agent's grant can span the user's
 *  projects). Ordered by project then DB name for a stable UI. */
export async function listGrantableDatabases(
  customer: Customer,
): Promise<GrantableProject[]> {
  const db = getDb(customer.region);
  const rows = await db
    .select({
      projectId: projects.id,
      projectName: projects.name,
      cdbId: projectDatabases.id,
      cdbName: projectDatabases.name,
    })
    .from(projects)
    .innerJoin(
      projectDatabases,
      eq(projectDatabases.projectId, projects.id),
    )
    .where(eq(projects.customerId, customer.id));

  const byProject = new Map<string, GrantableProject>();
  for (const r of rows) {
    let entry = byProject.get(r.projectId);
    if (!entry) {
      entry = {
        projectId: r.projectId,
        projectName: r.projectName,
        databases: [],
      };
      byProject.set(r.projectId, entry);
    }
    entry.databases.push({ projectDatabaseId: r.cdbId, name: r.cdbName });
  }
  const out = [...byProject.values()];
  for (const c of out) c.databases.sort((a, b) => a.name.localeCompare(b.name));
  out.sort((a, b) =>
    (a.projectName ?? a.projectId).localeCompare(
      b.projectName ?? b.projectId,
    ),
  );
  return out;
}

/** Replace the OAuth grant set for (client_id, user_id) with `selections`,
 *  binding the credential to ONE project. One OAuth credential → one project:
 *  selections are restricted to `projectId`'s databases (owned by the customer),
 *  and the replace clears the cred's ENTIRE grant set within this customer — so
 *  re-consenting onto a different project drops the prior project's grants and
 *  rebinds. Non-owned / off-project / duplicate selections are dropped. Runs in
 *  one txn so a re-consent is atomic (the agent never sees a half-applied set).
 *  Returns the number of grant rows written.
 *
 *  The bound project is what the region-wide `/mcp` endpoint resolves the
 *  credential to (router resolveOAuthProjectId reads it back from these rows).
 *
 *  Why the delete is customer-scoped: a user can belong to more than one org
 *  (customer) in the same region, and the consent picker only offers the CURRENT
 *  customer's databases. The grant key is (client_id, user_id) — which spans
 *  customers — so a blanket delete on that key would wipe the SAME user+client's
 *  grants for ANOTHER customer's projects, 403-ing those agents. We restrict the
 *  replace to grants whose project_database belongs to THIS customer; the
 *  selection then IS the complete grant set for this customer. */
export async function setOAuthGrants(
  customer: Customer,
  args: {
    clientId: string;
    userId: string;
    projectId: string;
    selections: ScopeSelection[];
  },
): Promise<number> {
  const db = getDb(customer.region);
  // Restrict to DBs of THIS project (owned by the customer). A selection outside
  // the bound project — a tampered submit — is silently dropped; the proxy
  // ownership + scope checks are the durable backstop.
  const projectDbRows = await db
    .select({ id: projectDatabases.id })
    .from(projectDatabases)
    .innerJoin(projects, eq(projects.id, projectDatabases.projectId))
    .where(
      and(
        eq(projects.customerId, customer.id),
        eq(projectDatabases.projectId, args.projectId),
      ),
    );
  const owned = new Set(projectDbRows.map((r) => r.id));
  const rows = dedupeSelections(args.selections, owned).map((s) => ({
    id: ulid(),
    projectDatabaseId: s.projectDatabaseId,
    clientId: args.clientId,
    userId: args.userId,
    access: s.access,
  }));

  await db.transaction(async (tx) => {
    // Scope the replace to THIS customer's project_databases (subquery), so
    // re-consenting in one workspace can't clear another workspace's grants for
    // the same user+client. A different-customer grant for the same key survives.
    const customerDbIds = tx
      .select({ id: projectDatabases.id })
      .from(projectDatabases)
      .innerJoin(
        projects,
        eq(projects.id, projectDatabases.projectId),
      )
      .where(eq(projects.customerId, customer.id));
    await tx
      .delete(mcpScopeGrants)
      .where(
        and(
          eq(mcpScopeGrants.clientId, args.clientId),
          eq(mcpScopeGrants.userId, args.userId),
          inArray(mcpScopeGrants.projectDatabaseId, customerDbIds),
        ),
      );
    if (rows.length > 0) await tx.insert(mcpScopeGrants).values(rows);
  });
  return rows.length;
}

/** Replace the grant set for an API token (mcp_token_id) with `selections`.
 *  A PAT is bound to ONE project, so callers pass that project's id and
 *  selections are validated to belong to it (and to the customer). Returns the
 *  number of grant rows written. */
export async function setTokenGrants(
  customer: Customer,
  args: {
    mcpTokenId: string;
    projectId: string;
    selections: ScopeSelection[];
  },
): Promise<number> {
  const db = getDb(customer.region);
  // Restrict to DBs of THIS project (owned by the customer).
  const connDbRows = await db
    .select({ id: projectDatabases.id })
    .from(projectDatabases)
    .innerJoin(
      projects,
      eq(projects.id, projectDatabases.projectId),
    )
    .where(
      and(
        eq(projects.customerId, customer.id),
        eq(projectDatabases.projectId, args.projectId),
      ),
    );
  const owned = new Set(connDbRows.map((r) => r.id));
  const rows = dedupeSelections(args.selections, owned).map((s) => ({
    id: ulid(),
    projectDatabaseId: s.projectDatabaseId,
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
      projectDatabaseId: mcpScopeGrants.projectDatabaseId,
      access: mcpScopeGrants.access,
    })
    .from(mcpScopeGrants)
    .where(
      and(
        eq(mcpScopeGrants.clientId, clientId),
        eq(mcpScopeGrants.userId, userId),
      ),
    );
  return new Map(rows.map((r) => [r.projectDatabaseId, r.access]));
}

/** Keep only owned, last-wins-per-DB selections. Exported for unit testing the
 *  validation without a database. */
export function dedupeSelections(
  selections: ScopeSelection[],
  owned: Set<string>,
): ScopeSelection[] {
  const byId = new Map<string, McpScopeAccess>();
  for (const s of selections) {
    if (!owned.has(s.projectDatabaseId)) continue;
    if (s.access !== "read" && s.access !== "write") continue;
    byId.set(s.projectDatabaseId, s.access); // last wins
  }
  return [...byId.entries()].map(([projectDatabaseId, access]) => ({
    projectDatabaseId,
    access,
  }));
}
