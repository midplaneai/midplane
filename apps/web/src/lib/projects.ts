import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { ulid } from "ulid";

import {
  auditEventsIndex,
  projectDatabases,
  projects,
  customers,
  EMPTY_TENANT_SCOPE,
  getDb,
  indexerCursors,
  validateColumnMasks,
  validateGuardrails,
  validateIgnoredColumns,
  validatePolicy,
  validateTenantScope,
  type AccessLevel,
  type ColumnMasksConfig,
  type Customer,
  type DatabaseEntry,
  type GuardrailsConfig,
  type IgnoredColumnsConfig,
  type MaskColumnTypes,
  type TableAccessPolicy,
  type TenantScopeConfig,
} from "@midplane-cloud/db";
import {
  encryptDsn,
  makeKmsContext,
  type Region,
} from "@midplane-cloud/kms";
import { loadPepperFromKms } from "@midplane-cloud/kms/pepper";

import {
  DB_NAME_RE,
  isValidDatabaseName,
  normalizeName,
  slugifyDatabaseName,
} from "./project-name.ts";
import { projectLabel } from "./format.ts";
import { resolveServing, type ServingState } from "./freshness.ts";
import { PlanLimitError, type ResolvedPlan } from "./plan.ts";
import { tokenEnvFromConfig } from "./token-env.ts";
import { EVENT_TYPES } from "./audit.ts";
import {
  countActiveTokensByProject,
  countUsableTokens,
  emitTokenAuditRow,
  insertTokenRow,
} from "./tokens.ts";

export {
  MAX_PROJECT_NAME_LENGTH,
  isValidDatabaseName,
  normalizeName,
  slugifyDatabaseName,
} from "./project-name.ts";

// audit_events_index enforces RLS keyed on app.customer_id (see
// 0001_constraints.sql + 0004_force_rls). Inserts must run inside a txn
// that has SET LOCAL app.customer_id; outside that bind, RLS rejects the
// row and the change is silently lost. Mirror audit.ts's withCustomerScope
// pattern locally so the cloud-emitted POLICY_CHANGED / TENANT_SCOPE_CHANGED
// rows survive RLS enforcement (today on Neon's BYPASSRLS owner role this
// is a no-op; once the app role flips, the bind is what keeps these
// inserts working).
const CUSTOMER_ID_ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Default projection for project_databases reads that ship to UI
// surfaces. Excludes `encryptedDsn` (bytea — Next 15 refuses to serialize
// across the RSC boundary, but more importantly we want defense-in-depth:
// the ciphertext should never leave Postgres unless we're about to
// decrypt it) and `kmsKeyId` (reveals which KMS key wraps the credential
// — not a smoking gun but irrelevant to any UI surface).
//
// Callers that genuinely need to decrypt a DSN (the tables-introspection
// route, the proxy resolver) use the `*AndCredential` variants below, so
// every wider-exposure read is greppable at code review time.
const SAFE_DATABASE_COLUMNS = {
  id: projectDatabases.id,
  projectId: projectDatabases.projectId,
  name: projectDatabases.name,
  tableAccess: projectDatabases.tableAccess,
  tenantScope: projectDatabases.tenantScope,
  guardrails: projectDatabases.guardrails,
  // Non-secret policy config (same class as tableAccess/guardrails) — the
  // masked-preview panel reads it to prefill a query + label masked columns.
  columnMasks: projectDatabases.columnMasks,
  // Scan-view dismissals — the exposure scan seeds these so masked/dismissed
  // columns render (and stay manageable) before any live scan is run.
  ignoredColumns: projectDatabases.ignoredColumns,
  rotatedAt: projectDatabases.rotatedAt,
  lastKmsSuccessAt: projectDatabases.lastKmsSuccessAt,
  createdAt: projectDatabases.createdAt,
} as const;

export type SafeProjectDatabase = Pick<
  typeof projectDatabases.$inferSelect,
  | "id"
  | "projectId"
  | "name"
  | "tableAccess"
  | "tenantScope"
  | "guardrails"
  | "columnMasks"
  | "ignoredColumns"
  | "rotatedAt"
  | "lastKmsSuccessAt"
  | "createdAt"
>;

export async function emitConfigAuditRow(
  customer: Customer,
  row: {
    tenantId: string;
    database: string;
    eventType:
      | "POLICY_CHANGED"
      | "TENANT_SCOPE_CHANGED"
      | "GUARDRAILS_CHANGED"
      | "REGION_CHANGED"
      | "PROJECT_PAUSED"
      | "PROJECT_RESUMED";
    payload: Record<string, unknown>;
    actorUserId: string;
  },
): Promise<void> {
  if (!CUSTOMER_ID_ULID_RE.test(customer.id)) {
    throw new Error("customer.id must be a ULID");
  }
  const db = getDb(customer.region);
  await db.transaction(async (tx) => {
    // sql.raw is required: Postgres rejects parameterized values in
    // SET LOCAL. customer.id was matched against the ULID alphabet above,
    // so the interpolation can't escape the literal.
    await tx.execute(
      sql.raw(`SET LOCAL app.customer_id = '${customer.id}'`),
    );
    await tx.insert(auditEventsIndex).values({
      id: ulid(),
      customerId: customer.id,
      tenantId: row.tenantId,
      region: customer.region,
      queryId: ulid(),
      database: row.database,
      ts: new Date(),
      eventType: row.eventType,
      payload: row.payload,
      actorUserId: row.actorUserId,
      // Every config event passes the project id as tenantId (see the
      // setTableAccess comment — "tenant_id = project_id so a future
      // per-project audit view can filter on it for free"). Stamp the
      // canonical project_id column (0020) from it so a project-
      // filtered /audit keeps these config rows alongside the query rows.
      projectId: row.tenantId,
    });
  });
}

// Default child name applied to the auto-created DB when a project is
// first created. A project has 1+ children, all of which share the
// project's token surface (mcp_tokens table — multi-token per
// project since PR2 of mcp_url_auth_security). Add-second-DB flow
// lives in PR-C and the per-DB helpers below take an explicit `dbName`
// argument that defaults to this value.
export const DEFAULT_DATABASE_NAME = "main";

// DB_NAME_RE / isValidDatabaseName / slugifyDatabaseName now live in
// ./project-name.ts (pure + client-safe) so the create form previews the
// exact alias grammar the engine enforces. isValidDatabaseName is
// re-exported above to keep this module's public surface unchanged.

// Derive an agent-facing database alias from a Postgres DSN. Takes the URL's
// database path (postgres://…/<db>), lowercases it, and sanitizes to
// DB_NAME_RE (the engine's name grammar). Falls back to DEFAULT_DATABASE_NAME
// when the DSN carries no usable name, so the first database always lands a
// valid alias even from a path-less or unparseable DSN.
export function deriveDatabaseAlias(dsn: string): string {
  let path: string;
  try {
    path = new URL(dsn).pathname;
  } catch {
    return DEFAULT_DATABASE_NAME;
  }
  let raw = path.replace(/^\/+/, "");
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // Leave raw as-is on a malformed %-escape; the sanitizer below copes.
  }
  const sanitized = slugifyDatabaseName(raw);
  return isValidDatabaseName(sanitized) ? sanitized : DEFAULT_DATABASE_NAME;
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

// Shared create-project path used by both the Server Action behind the
// paste-DSN form and the JSON POST /api/projects route. Encrypts the
// DSN with the customer's region key, persists the ciphertext on a
// project_databases row whose agent-facing alias is `name` (when it's a
// valid DB alias) or, failing that, derived from the DSN's database name.
// That same alias labels the project, so a one-database project reads
// coherently and the container recedes until a second DB is added (the
// project is renamable later via renameProject). Optionally auto-mints a
// default mcp_tokens row (mintDefaultToken — on for the programmatic API,
// off for the OAuth-first web flow).
//
// Returns the new parent id and, when a default token was minted, its
// PLAINTEXT — the caller renders the plaintext URL ONCE and never sees it
// again (only the HMAC-SHA256(pepper) digest is stored, the show-once
// property). defaultTokenPlaintext is null when mintDefaultToken is false.
export async function createProject(
  customer: Customer,
  dsn: string,
  name: string | null = null,
  defaultAccess: AccessLevel = "read",
  actorUserId: string,
  // Resolved plan + caps for the org (from resolvePlan() at the call site).
  // Enforced under a customers-row lock before the project is inserted;
  // throws PlanLimitError when the project cap is reached OR (when minting a
  // default token) there is no room for it (decision D8).
  entitlement: ResolvedPlan,
  // Whether to auto-mint a default URL token. The programmatic API
  // (POST /api/projects) wants one — the caller has no browser for OAuth, so a
  // token returned in the response is its only credential. The web flow passes
  // false: it's OAuth-first, so an auto-minted token would be a hidden,
  // unusable row burning a plan token slot. When false, `defaultTokenPlaintext`
  // is null and no token slot is consumed.
  mintDefaultToken: boolean = true,
): Promise<{ id: string; defaultTokenPlaintext: string | null }> {
  const kms = makeKmsContext(process.env);
  const { ciphertext, kmsKeyId } = await encryptDsn(
    kms,
    dsn,
    customer.id,
    customer.region,
  );

  const id = ulid();

  // The first database's agent-facing alias: the caller's name when it's a
  // valid alias, otherwise derived from the DSN's database name (fallback
  // DEFAULT_DATABASE_NAME). This same value labels the project below.
  const dbAlias =
    typeof name === "string" && isValidDatabaseName(name.trim())
      ? name.trim()
      : deriveDatabaseAlias(dsn);

  // Initial policy: default = customer's choice from the create form,
  // tables = {} (per-table overrides are added later from the permission
  // grid on the project detail page). The schema column default
  // ('deny', {}) is the safety net for any code path that bypasses this
  // helper; this insert overrides it with the customer's selection.
  const tableAccess: TableAccessPolicy = {
    default: defaultAccess,
    tables: {},
  };

  const childId = ulid();
  const defaultTokenId = ulid();
  const { caps, plan } = entitlement;

  // Load the pepper BEFORE the transaction so the project txn never holds
  // a row lock during a KMS round-trip. The default token is then inserted
  // INSIDE the txn (below) — atomically with the cap check — so a concurrent
  // manual mint can't slip between "count under the cap" and "insert the
  // default" and push the org over its token cap. (The map is cached after
  // the first load per region; rotation adds kids and we pick the first as
  // the active write-side kid.)
  //
  // Only when a token will actually be minted: the OAuth-first web flow
  // (mintDefaultToken=false) needs no token material, so a region with no
  // pepper configured must not fail a create that only encrypts a DSN.
  const mintMaterial = mintDefaultToken
    ? await (async () => {
        const peppers = await loadPepperFromKms(customer.region, process.env);
        const kid = peppers.keys().next().value as string | undefined;
        if (!kid) {
          throw new Error(
            `no pepper available for region '${customer.region}' — token mint cannot proceed`,
          );
        }
        return { kid, pepper: peppers.get(kid)! };
      })()
    : null;
  const expiresAt = new Date(Date.now() + NINETY_DAYS_MS);

  const db = getDb(customer.region);
  // The project the first DB + default token attach to: a reused empty project
  // (the auto-seeded "Default") or, failing that, a newly inserted one.
  // Assigned inside the txn below.
  let resolvedProjectId = id;
  const defaultTokenPlaintext = await db.transaction(async (tx) => {
    // Plan caps (decisions D4/D8). Lock the customers row first so concurrent
    // creates for this org serialize and the counts can't drift before the
    // inserts. Infinity caps (Team) short-circuit each check — we never scan
    // an unlimited customer's project/token set.
    if (Number.isFinite(caps.projects) || Number.isFinite(caps.tokens)) {
      await tx
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.id, customer.id))
        .for("update")
        .limit(1);
    }
    // Reuse the customer's empty (database-less) project if one exists — the
    // auto-seeded "Default" (ensureDefaultProject), or any project with no
    // databases yet. Attaching the first DB + default token to an existing
    // project does NOT consume a new project slot, so the project cap is
    // enforced ONLY when we insert a new project below. This is what lets a
    // Free customer (cap = 1, auto-seeded at signup) add their first database
    // instead of tripping the cap with a second project.
    const emptyProject = await tx
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(
        and(
          eq(projects.customerId, customer.id),
          sql`NOT EXISTS (SELECT 1 FROM project_databases pd WHERE pd.project_id = ${projects.id})`,
        ),
      )
      .limit(1);
    if (emptyProject[0]) {
      resolvedProjectId = emptyProject[0].id;
      // Label the reused project with the first database's alias when it's
      // still unnamed or the auto-seed placeholder "Default" — a one-DB
      // project reads coherently and stays renamable later.
      if (
        emptyProject[0].name === null ||
        emptyProject[0].name === "Default"
      ) {
        await tx
          .update(projects)
          .set({ name: dbAlias })
          .where(eq(projects.id, resolvedProjectId));
      }
    } else if (Number.isFinite(caps.projects)) {
      const existing = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.customerId, customer.id));
      if (existing.length >= caps.projects) {
        throw new PlanLimitError("projects", caps.projects, plan);
      }
    }
    if (mintDefaultToken && Number.isFinite(caps.tokens)) {
      // The default token inserted below consumes a token slot. Count usable
      // tokens under the lock and block if there's no room, so total usable
      // tokens can never exceed the cap. Skipped when we're not minting one.
      const usedTokens = await countUsableTokens(tx, customer.id);
      if (usedTokens >= caps.tokens) {
        throw new PlanLimitError("tokens", caps.tokens, plan);
      }
    }
    if (!emptyProject[0]) {
      await tx.insert(projects).values({
        id,
        customerId: customer.id,
        region: customer.region,
        name: dbAlias,
      });
    }
    await tx.insert(projectDatabases).values({
      id: childId,
      projectId: resolvedProjectId,
      name: dbAlias,
      encryptedDsn: ciphertext,
      kmsKeyId,
      tableAccess,
    });
    // OAuth-first (web) flow: no auto-minted token — the user connects an agent
    // over OAuth, or mints a machine token explicitly later. (mintMaterial is
    // non-null whenever mintDefaultToken is true; the guard carries both.)
    if (!mintDefaultToken || !mintMaterial) return null;
    // Default token, ATOMIC with the cap check + DB insert (closes the over-cap
    // race). This is the project's FIRST token — an empty (reused or new)
    // project has none, so the "default" name can't collide; ownership is
    // guaranteed (the project belongs to this customer), so no pre-check needed.
    const minted = await insertTokenRow(
      tx,
      {
        id: defaultTokenId,
        projectId: resolvedProjectId,
        name: "default",
        createdByUserId: actorUserId,
        expiresAt,
        env: tokenEnvFromConfig(process.env),
      },
      mintMaterial,
    );
    return minted.plaintext;
  });

  // Best-effort TOKEN_CREATED audit, post-commit (matches createToken's
  // fail-soft posture — an audit hiccup must not undo the durable mint).
  // Only when we actually minted a default token.
  if (mintDefaultToken) {
    try {
      await emitTokenAuditRow(customer, {
        projectId: resolvedProjectId,
        mcpTokenId: defaultTokenId,
        eventType: "TOKEN_CREATED",
        payload: {
          project_id: resolvedProjectId,
          token_id: defaultTokenId,
          token_name: "default",
          expires_at: expiresAt.toISOString(),
        },
        actorUserId,
      });
    } catch (err) {
      console.error("[createProject] default TOKEN_CREATED audit failed", err);
    }
  }

  return { id: resolvedProjectId, defaultTokenPlaintext };
}

// Idempotently seed an empty "Default" project for a customer at onboarding so a
// new customer lands on a ready project ("add a database / connect your agent")
// instead of having to create a container first (decision D6/D7-A). An EMPTY
// project carries no token and triggers no engine spawn, so it never reaches the
// proxy/spawner zero-database invariants — the first database + default token are
// minted later by createProject(), which reuses this project.
//
// Race-safe: an xact-scoped advisory lock keyed on the customer serializes
// concurrent onboards (a double-submitted region form, two tabs) so they can't
// each seed a different default — mirrors getOrCreateOrgForUser. No-op when the
// customer already has any project. Used by both the cloud signup path
// (upsertCustomerRegion) and self-host boot (ensureImplicitCustomer); self-host
// is uncapped, so the seed never trips a plan limit.
export async function ensureDefaultProject(
  customerId: string,
  region: Region,
): Promise<void> {
  await getDb(region).transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${customerId}, 0))`,
    );
    const existing = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.customerId, customerId))
      .limit(1);
    if (existing[0]) return;
    await tx.insert(projects).values({
      id: ulid(),
      customerId,
      region,
      name: "Default",
    });
  });
}

// Does the customer have a reusable empty (database-less) project? createProject
// attaches the first DB + token to such a project WITHOUT consuming a new
// project slot, so a projects-cap preflight must treat "has an empty project" as
// "can still add a database" — otherwise a fresh Free customer (auto-seeded
// Default, projects 1/1) is wrongly told the DSN form is at its project limit.
export async function hasEmptyProject(customer: Customer): Promise<boolean> {
  const rows = await getDb(customer.region)
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.customerId, customer.id),
        sql`NOT EXISTS (SELECT 1 FROM project_databases pd WHERE pd.project_id = ${projects.id})`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export function isValidDsn(s: unknown): s is string {
  return typeof s === "string" && /^postgres(ql)?:\/\//i.test(s) && s.length >= 8;
}

/** Read-only plan usage for pre-flight UX gating (current project +
 *  usable-token counts for the customer's region). NOT authoritative: the
 *  locked count inside createProject is the real cap enforcer and closes
 *  the concurrent-create race. This unlocked read can be a hair stale, which
 *  is fine — the UI uses it to show "N of M" usage and hide the create form
 *  when a cap is already reached; the transaction still has the final say.
 *
 *  Pairs with {@link projectCreateBlock} in lib/plan.ts. */
export async function getPlanUsage(
  customer: Customer,
): Promise<{ projects: number; tokens: number }> {
  const db = getDb(customer.region);
  const [connRows, tokens] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(projects)
      .where(eq(projects.customerId, customer.id)),
    countUsableTokens(db, customer.id),
  ]);
  return { projects: Number(connRows[0]?.count ?? 0), tokens };
}

export interface ProjectOption {
  /** projects.id — the audit filter value (project_id). */
  id: string;
  /** Display label for the chip: the user's project name, else a stable
   *  id-prefix (mirrors projectLabel so the chip reads the same as the
   *  card it was deep-linked from). */
  label: string;
}

/** The customer's projects (id + display label) for the /audit
 *  project filter chip. Newest-first to match the dashboard list. Unlike
 *  the audit chip lists (tenants/databases/agents/tokens, which are DISTINCT
 *  over audit rows), this reads the projects table directly so a brand-
 *  new project with no audit rows yet still appears in the dropdown. */
export async function listProjectOptions(
  customer: Customer,
): Promise<ProjectOption[]> {
  const db = getDb(customer.region);
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.customerId, customer.id))
    .orderBy(desc(projects.createdAt));
  return rows.map((r) => ({ id: r.id, label: projectLabel(r) }));
}

/** Usable machine-token count for the customer — the tokens half of
 *  getPlanUsage, for pages that already know the project count from rows
 *  they fetch anyway (the project workspace derives it from the switcher
 *  rows instead of paying a second COUNT per render). */
export async function getTokenUsage(customer: Customer): Promise<number> {
  return countUsableTokens(getDb(customer.region), customer.id);
}

export interface ProjectSwitcherRow {
  id: string;
  /** Display label: the user's project name, else a stable id-prefix
   *  (parity with projectLabel / listProjectOptions). */
  label: string;
  /** Serving-readiness headline state for the row's dot (ready / paused /
   *  broken) — the switcher is a fleet of headline dots, so it renders
   *  Axis 1, never audit-drain health (see lib/freshness.ts). */
  serving: ServingState;
}

/** The customer's projects with the light facts the rail-header switcher
 *  needs (label + serving dot) — the parents slice of
 *  listDashboardProjects without tokens / last-query / cursor detail. One
 *  grouped query (database count feeds resolveServing). Newest-first to
 *  match the dashboard list. */
export async function listProjectSwitcherRows(
  customer: Customer,
): Promise<ProjectSwitcherRow[]> {
  const db = getDb(customer.region);
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      pausedAt: projects.pausedAt,
      databaseCount: sql<number>`count(${projectDatabases.id})::int`,
    })
    .from(projects)
    .leftJoin(projectDatabases, eq(projectDatabases.projectId, projects.id))
    .where(eq(projects.customerId, customer.id))
    // projects.id is the PK, so the non-aggregated columns are functionally
    // dependent and Postgres accepts the single-column GROUP BY.
    .groupBy(projects.id)
    .orderBy(desc(projects.createdAt));
  return rows.map((r) => ({
    id: r.id,
    label: projectLabel(r),
    serving: resolveServing({
      pausedAt: r.pausedAt,
      databaseCount: Number(r.databaseCount ?? 0),
    }).state,
  }));
}

// Update the user-supplied name on the parent project. Cosmetic — no
// caches to invalidate, no container to restart, no token rotation.
// Returns null when the id is unknown OR owned by another customer
// (matches deleteProject's leakage-avoidance shape).
export async function renameProject(
  customer: Customer,
  id: string,
  name: string | null,
): Promise<{ name: string | null } | null> {
  const db = getDb(customer.region);
  const updated = await db
    .update(projects)
    .set({ name: normalizeName(name) })
    .where(and(eq(projects.id, id), eq(projects.customerId, customer.id)))
    .returning({ name: projects.name });
  return updated[0] ?? null;
}

// Delete a project only if it belongs to the calling customer. Returns
// the deleted row's id (the registry / cursor key in the hybrid model)
// or null (when the id is unknown OR owned by another customer — the
// caller can't distinguish, by design, to avoid leaking existence).
//
// Children in project_databases are removed by the FK ON DELETE
// CASCADE declared in 0008. mcp_tokens rows are removed by the FK ON
// DELETE CASCADE declared in 0017. The matching indexer_cursors row's
// project_id flips to NULL via FK ON DELETE SET NULL (0018) — it
// outlives the project by design so the indexer can finish draining
// any backlog before a future sweeper deletes it. We additionally
// delete the cursor explicitly to keep clean-slate dashboard semantics
// when there's no pending backlog; the FK is the durable enforcer if
// this best-effort delete is bypassed.
//
// Returns the deleted row's id so the caller can stop the running
// container — without that step the OSS sidecar lingers (still holding
// the now-deleted DSNs in env) until its 30-minute idle timer fires.
export async function deleteProject(
  customer: Customer,
  id: string,
): Promise<{ id: string } | null> {
  const db = getDb(customer.region);
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(projects)
      .where(
        and(eq(projects.id, id), eq(projects.customerId, customer.id)),
      )
      .returning({ id: projects.id });
    const row = deleted[0];
    if (!row) return null;
    // Best-effort cursor cleanup. The FK ON DELETE SET NULL has already
    // fired by the time this runs (the projects delete cascaded
    // through the FK), so any cursor for this project now has
    // project_id=NULL. We delete the now-orphaned cursor explicitly
    // to keep the dashboard clean; the future orphan-sweeper handles the
    // race where the indexer is mid-drain and a row gets re-stamped
    // briefly.
    await tx
      .delete(indexerCursors)
      .where(eq(indexerCursors.projectId, row.id));
    return { id: row.id };
  });
}

// Pause a project — the reversible kill switch. Sets `paused_at` so the
// resolver rejects agent requests with a distinct 403 while tokens, URLs,
// and policy stay intact. Customer-gated (the WHERE pins customer_id so a
// foreign id is a no-op) and idempotent: COALESCE keeps the original
// pause instant if the project is already paused, so a re-pause doesn't
// move "paused since" — it returns the owned row either way, and null only
// when the id isn't this customer's.
//
// Tearing down the running container (registry.invalidate) is the caller's
// job — same split as deleteProject, which returns the id and lets the
// route/action stop the sidecar. Without that step the OSS container lingers
// (still serving the now-paused project) until its 30-minute idle timer.
export async function pauseProject(
  customer: Customer,
  id: string,
): Promise<{ id: string } | null> {
  const db = getDb(customer.region);
  const updated = await db
    .update(projects)
    .set({ pausedAt: sql`COALESCE(${projects.pausedAt}, now())` })
    .where(and(eq(projects.id, id), eq(projects.customerId, customer.id)))
    .returning({ id: projects.id });
  return updated[0] ?? null;
}

// Resume a paused project — clears `paused_at` so the resolver admits
// agent requests again on the next call. No container teardown needed: the
// next request spawns a fresh engine with the current policy. Customer-gated
// and idempotent (clearing an already-active project is a no-op that
// still returns the owned row; null only for a foreign/unknown id).
export async function resumeProject(
  customer: Customer,
  id: string,
): Promise<{ id: string } | null> {
  const db = getDb(customer.region);
  const updated = await db
    .update(projects)
    .set({ pausedAt: null })
    .where(and(eq(projects.id, id), eq(projects.customerId, customer.id)))
    .returning({ id: projects.id });
  return updated[0] ?? null;
}

// Dependencies rotateProject needs to invalidate the in-memory layers.
// Concrete implementations live in @midplane-cloud/router; we accept the
// minimal shape so unit tests don't have to construct a full registry.
export interface RotationCaches {
  /** DecryptCache invalidate is per-credential — keyed on the
   *  project_databases.id (the credential), not the parent project.
   *  Multi-DB rollout in 0008. */
  cache: { invalidate(projectDatabaseId: string, region: Region): void };
  /** ContainerRegistry invalidate is keyed on the parent project id
   *  (PR2 of mcp_url_auth_security — was plaintext token). */
  registry: { invalidate(projectId: string): Promise<void> };
}

// Dependencies setTableAccess needs to push the new policy to the
// running engine (preferred path) or, if that fails non-recoverably,
// fall back to stop-and-respawn.
//
// pushPolicy carries a multi-DB body — every DB on the project must
// be listed since OSS drops absent entries from the engine's registry.
// The caller loads sibling DBs from PG and assembles the full set.
export interface PolicyPushDeps {
  registry: { invalidate(projectId: string): Promise<void> };
  pushPolicy(
    projectId: string,
    databases: readonly DatabaseEntry[],
  ): Promise<
    | { delivered: true }
    | { delivered: false }
    | { rejected: { status: number; body: string } }
  >;
}

// Thrown when the engine's POST /admin/policy returned 400 — engine
// kept the previous policy intact, so the running session is fine; the
// caller (server action) should surface `body` to the user. Cloud's
// validatePolicy already passed, so this signals validator drift
// between cloud and engine — should be unreachable.
export class EnginePolicyRejected extends Error {
  constructor(public readonly engineMessage: string) {
    super(`engine rejected policy: ${engineMessage}`);
    this.name = "EnginePolicyRejected";
  }
}

// One config block on one DB of a project — the shared spine of
// setTableAccess / setTenantScope / setGuardrails. Preferred path is
// hot-reload via POST /admin/policy on the running engine — the agent's
// MCP session stays alive and a POLICY_RELOADED audit event is emitted.
// If no container is running OR the engine doesn't expose the endpoint,
// the Postgres write alone is enough; the next spawn reads the new
// config from PG. On a 5xx/401/network failure we fall back to
// stop-and-respawn (matches rotateProject's fail-soft posture). On
// 400 we do NOT fall back — engine kept the old policy, so the running
// session is fine; respawn would re-read the now-rejected config from
// PG and fail the spawn. Caller surfaces the engine's validator message
// to the user.
//
// Returns null when the id is unknown OR owned by another customer OR
// the named child does not exist (mirrors the leakage-avoidance shape
// of rotateProject / delete — caller can't distinguish from "id
// unknown").
interface PolicyConfigChange {
  /** Column patch for the named child row, e.g. { tableAccess: value }.
   *  Values are VALIDATED — the public setters gate before delegating. */
  update: Partial<
    Pick<
      typeof projectDatabases.$inferInsert,
      "tableAccess" | "tenantScope" | "guardrails" | "columnMasks"
    >
  >;
  eventType: "POLICY_CHANGED" | "TENANT_SCOPE_CHANGED" | "GUARDRAILS_CHANGED";
  /** Event-specific payload fields; project_id / database_name are
   *  stamped by the helper. */
  payload: Record<string, unknown>;
  /** e.g. "[setTableAccess]" — keeps logs greppable per setter. */
  logPrefix: string;
  /** column_masks is boot-time only (the engine reads it at construction, not
   *  via the hot-reload body), so a mask change can't be pushed to the running
   *  engine — force a respawn so the next request reads the new masks from PG.
   *  Hot-reloadable setters (table_access etc.) leave this false. */
  forceRespawn?: boolean;
}

async function applyPolicyConfigChange(
  customer: Customer,
  id: string,
  deps: PolicyPushDeps,
  actorUserId: string,
  dbName: string,
  change: PolicyConfigChange,
): Promise<{ id: string } | null> {
  const db = getDb(customer.region);
  // Three-step in a txn: ownership check on the parent (so we don't leak
  // existence by writing through to a foreign customer's DB), update the
  // named child's config column, then snapshot every DB on the project
  // (post-update) for the hot-reload body. RETURNING on the child write
  // distinguishes "child not found" from "wrote but no change" and keeps
  // the leakage-avoidance shape (null for both cases).
  //
  // Sibling DBs ride along because OSS hot-reload drops any DB absent
  // from the body — we have to re-state every DB to keep them registered.
  //
  // FOR UPDATE on the parent serializes concurrent config edits on the
  // same project (any mix of the three setters, or add/remove/rename):
  // without it, two parallel edits each read their own snapshot of
  // siblings and the engine ends up with the loser's stale view of the
  // winner's DB. NOTE: a narrower race remains between commit-of-T1 and
  // pushPolicy-of-T1 vs T2 — the engine converges on the next edit since
  // each push sends full state, but a per-project push mutex would
  // close it fully.
  const result = await db.transaction(async (tx) => {
    const parent = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.id, id), eq(projects.customerId, customer.id)),
      )
      .for("update")
      .limit(1);
    if (parent.length === 0) return null;
    const updated = await tx
      .update(projectDatabases)
      .set(change.update)
      .where(
        and(
          eq(projectDatabases.projectId, id),
          eq(projectDatabases.name, dbName),
        ),
      )
      .returning({ id: projectDatabases.id });
    if (updated.length === 0) return null;
    const siblings = await tx
      .select({
        id: projectDatabases.id,
        name: projectDatabases.name,
        tableAccess: projectDatabases.tableAccess,
        tenantScope: projectDatabases.tenantScope,
        guardrails: projectDatabases.guardrails,
      })
      .from(projectDatabases)
      .where(eq(projectDatabases.projectId, id));
    return { id: parent[0]!.id, siblings };
  });

  if (!result) return null;

  const databases: DatabaseEntry[] = result.siblings.map((s) => ({
    name: s.name,
    projectDatabaseId: s.id,
    tableAccess: s.tableAccess,
    tenantScope: s.tenantScope ?? EMPTY_TENANT_SCOPE,
    guardrails: s.guardrails,
  }));

  if (change.forceRespawn) {
    // Boot-time-only config (column_masks): the running engine can't hot-swap
    // it, so drop the container and let the next agent request respawn with the
    // new config from PG. Same fail-soft posture as the catch below.
    await deps.registry.invalidate(result.id).catch((err) => {
      console.error(`${change.logPrefix} registry.invalidate failed`, err);
    });
  } else {
    try {
    const pushResult = await deps.pushPolicy(result.id, databases);
    if ("rejected" in pushResult) {
      // Engine kept the previous policy. Don't fall back — respawn
      // would re-read this same (rejected) config from PG and fail to
      // boot. Surface the engine's message to the caller. We also skip
      // the audit row: the project_databases update is committed
      // (validator drift is unreachable in practice; if it happens,
      // engine state stays put and the dashboard surfaces the error),
      // but recording "config changed" would be a lie.
      console.error(
        `${change.logPrefix} engine rejected policy (validator drift)`,
        pushResult.rejected,
      );
      throw new EnginePolicyRejected(pushResult.rejected.body);
    }
    // delivered=true → engine swapped in place; delivered=false → no
    // active container, next spawn reads from PG. Either way we're done.
  } catch (err) {
    if (err instanceof EnginePolicyRejected) throw err;
    // 5xx / 401 / network — fall back to invalidate so the next agent
    // request respawns with the new config from PG. Same fail-soft
    // posture as rotateProject.
    console.error(
      `${change.logPrefix} hot reload failed; falling back to respawn`,
      err,
    );
    await deps.registry.invalidate(result.id).catch(() => undefined);
    }
  }

  // Cloud-emitted audit row, distinct from the engine's POLICY_RELOADED:
  // this one carries actor_clerk_user_id, so the audit log answers "who
  // changed the policy?" without needing the OSS engine to thread an
  // actor through /admin/policy. tenant_id = project_id so a future
  // per-project audit view can filter on it for free; database =
  // dbName so the column-level filter on /audit attributes the change to
  // the right child (default 'main' would misattribute non-main edits).
  // Best-effort: failure to write audit shouldn't undo the durable
  // config change (already committed in PG and pushed to the engine).
  try {
    await emitConfigAuditRow(customer, {
      tenantId: id,
      database: dbName,
      eventType: change.eventType,
      payload: {
        project_id: id,
        database_name: dbName,
        ...change.payload,
      },
      actorUserId,
    });
  } catch (err) {
    console.error(
      `${change.logPrefix} ${change.eventType} audit write failed`,
      err,
    );
  }

  return { id: result.id };
}

// Replace the table_access policy on one DB of a project. See
// applyPolicyConfigChange for the hot-reload / fallback semantics.
//
// `dbName` defaults to "main" so existing single-DB callers keep
// working; multi-DB callers pass the agent-facing alias explicitly.
//
// Validation runs here AND at the spawner boundary; the dashboard form
// also validates before submitting, so a malformed policy reaches this
// function only via a hostile / buggy non-browser caller.
export async function setTableAccess(
  customer: Customer,
  id: string,
  policy: TableAccessPolicy,
  deps: PolicyPushDeps,
  actorUserId: string,
  dbName: string = DEFAULT_DATABASE_NAME,
): Promise<{ id: string } | null> {
  const validation = validatePolicy(policy);
  if (!validation.ok) {
    const summary = validation.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`invalid policy: ${summary}`);
  }
  return applyPolicyConfigChange(customer, id, deps, actorUserId, dbName, {
    update: { tableAccess: validation.value },
    eventType: "POLICY_CHANGED",
    payload: { policy: validation.value },
    logPrefix: "[setTableAccess]",
  });
}

// Replace the tenant_scope config on one DB of a project.
//
// OSS 0.5.0 semantics: `column` is the universal default tenant column;
// setting it scopes every queried table unless overridden or exempted.
// `column: null` means only the listed `overrides` are checked; every
// other queried table is unscoped. The latter shape DOES NOT protect new
// tables from cross-tenant exposure — cloud keeps writing it for back-
// compat with customers who haven't set a default column yet.
// EMPTY_TENANT_SCOPE = tenant_scope disabled for the DB; serializer
// omits the block entirely.
//
// TENANT_SCOPE_CHANGED records "who reconfigured tenant isolation on
// which DB?" — directly relevant to row-level security audits.
export async function setTenantScope(
  customer: Customer,
  id: string,
  config: TenantScopeConfig,
  deps: PolicyPushDeps,
  actorUserId: string,
  dbName: string = DEFAULT_DATABASE_NAME,
): Promise<{ id: string } | null> {
  // Cloud-side validation before touching PG. The YAML emitter would also
  // throw, but failing here gives a clean per-field error message to the
  // dashboard action instead of bubbling a serialization throw out of
  // pushPolicy after the DB write has already committed.
  const validation = validateTenantScope(config);
  if (!validation.ok) {
    const summary = validation.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`invalid tenant_scope: ${summary}`);
  }
  return applyPolicyConfigChange(customer, id, deps, actorUserId, dbName, {
    update: { tenantScope: validation.value },
    eventType: "TENANT_SCOPE_CHANGED",
    payload: { config: validation.value },
    logPrefix: "[setTenantScope]",
  });
}

// Replace the dangerous-statement guardrails on one DB of a project.
//
// OSS 0.9.0 semantics: both flags fire regardless of table_access /
// tenant_scope; an omitted YAML section defaults BOTH on. The cloud
// always emits the section explicitly, so turning a flag off here is
// what makes the opt-out reach the engine.
//
// GUARDRAILS_CHANGED records "who turned the destructive-statement net
// off (or back on)?" — an opt-out is exactly the kind of change an
// audit reviewer wants attributed. The payload key is `guardrails` (not
// the generic `config`) so the audit list's eventSummary can recognize
// the row by shape — all cloud config events share the POLICY_RELOAD
// status bucket.
export async function setGuardrails(
  customer: Customer,
  id: string,
  config: GuardrailsConfig,
  deps: PolicyPushDeps,
  actorUserId: string,
  dbName: string = DEFAULT_DATABASE_NAME,
): Promise<{ id: string } | null> {
  const validation = validateGuardrails(config);
  if (!validation.ok) {
    const summary = validation.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`invalid guardrails: ${summary}`);
  }
  return applyPolicyConfigChange(customer, id, deps, actorUserId, dbName, {
    update: { guardrails: validation.value },
    eventType: "GUARDRAILS_CHANGED",
    payload: { guardrails: validation.value },
    logPrefix: "[setGuardrails]",
  });
}

// Column masking (design A2). Same write path as table_access / guardrails:
// validate, persist the column_masks JSONB on the named database, and invalidate
// the running engine so the next agent request spawns with the new masks. Reuses
// the POLICY_CHANGED audit event (column_masks is part of the database's policy;
// a distinct event_type would need a CHECK-constraint migration) — the payload
// carries column_masks so the change is still legible in the audit log.
export async function setColumnMasks(
  customer: Customer,
  id: string,
  config: ColumnMasksConfig,
  deps: PolicyPushDeps,
  actorUserId: string,
  dbName: string = DEFAULT_DATABASE_NAME,
  // Optional per-column Postgres types (ET6/B5). When supplied, a transform whose
  // output type doesn't fit the column (full-redact on an int, generalize:year on a
  // text column, …) is rejected here at save instead of surfacing as a query-time
  // reject. Omitted ⇒ no type check (query-time stays the fail-closed backstop).
  columnTypes?: MaskColumnTypes,
): Promise<{ id: string } | null> {
  // Enforce the SOURCE_REWRITE type domains: every DB that declares masks runs the
  // source-rewrite path (the spawner emits `mask_source_rewrite: true` + a
  // `requires_features` interlock, unconditionally), so a mask that's valid post-exec
  // but not under source-rewrite (full-redact / consistent-hash on a non-text column)
  // must be caught HERE — otherwise it passes save and the engine rejects it at spawn.
  const validation = validateColumnMasks(config, columnTypes, "source_rewrite");
  if (!validation.ok) {
    const summary = validation.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`invalid column_masks: ${summary}`);
  }
  return applyPolicyConfigChange(customer, id, deps, actorUserId, dbName, {
    update: { columnMasks: validation.value },
    eventType: "POLICY_CHANGED",
    payload: { column_masks: validation.value },
    logPrefix: "[setColumnMasks]",
    forceRespawn: true,
  });
}

/** True if `next` turns masking ON or strengthens it vs `prev` — adds a masked
 *  column, or changes an existing column's rule. Pure removals (and no-ops)
 *  return false. The save path uses this to fail LOUD when masking is configured
 *  on a deployment without MIDPLANE_MASK_SALT_MASTER (the engine would refuse to
 *  spawn), while still letting the user REMOVE masks to recover a project whose
 *  engine is already stuck. Both args must be normalized
 *  (parseColumnMasksOrThrow) so rule equality is a stable JSON compare. */
export function maskConfigAddsMasking(
  prev: ColumnMasksConfig,
  next: ColumnMasksConfig,
): boolean {
  for (const [table, cols] of Object.entries(next)) {
    for (const [col, rule] of Object.entries(cols)) {
      const before = prev[table]?.[col];
      if (before === undefined) return true;
      if (JSON.stringify(before) !== JSON.stringify(rule)) return true;
    }
  }
  return false;
}

// PII-scan dismissals (design D1). Deliberately NOT routed through
// applyPolicyConfigChange: ignored_columns is scan-view state, not policy.
// It never reaches the engine, so there is no respawn, no policy push, and no
// sibling re-statement; and it is not a security-relevant change, so it skips
// the POLICY_CHANGED audit row. Just a validated, ownership-gated JSONB write
// on the named child. Returns null with the same leakage-avoidance shape as the
// policy setters (unknown id / foreign customer / unknown child are
// indistinguishable to the caller).
export async function setIgnoredColumns(
  customer: Customer,
  id: string,
  config: IgnoredColumnsConfig,
  dbName: string = DEFAULT_DATABASE_NAME,
): Promise<{ id: string } | null> {
  const validation = validateIgnoredColumns(config);
  if (!validation.ok) {
    const summary = validation.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`invalid ignored_columns: ${summary}`);
  }
  const db = getDb(customer.region);
  return db.transaction(async (tx) => {
    // Ownership check on the parent first so a write-through can't confirm a
    // foreign project's existence (mirrors applyPolicyConfigChange).
    const parent = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.customerId, customer.id)))
      .limit(1);
    if (parent.length === 0) return null;
    const updated = await tx
      .update(projectDatabases)
      .set({ ignoredColumns: validation.value })
      .where(
        and(
          eq(projectDatabases.projectId, id),
          eq(projectDatabases.name, dbName),
        ),
      )
      .returning({ id: projectDatabases.id });
    if (updated.length === 0) return null;
    return { id: parent[0]!.id };
  });
}

// Rotate one DB's DSN on a project: re-encrypt with the customer's
// region key, atomically swap the ciphertext + kms_key_id + rotated_at
// on the named project_databases row, then invalidate BOTH in-memory
// layers (DecryptCache holds the cached plaintext keyed on
// project_database id; ContainerRegistry holds the running OSS
// container with the old DSN in env). Skipping either layer means the
// old DSN keeps serving traffic until the 30-min idle timer fires —
// that's the security incident.
//
// `dbName` is the agent-facing alias of the child to rotate — required,
// no default. It used to default to "main", but the first database is no
// longer always named "main" (createProject names it from the DSN), so an
// implicit default would silently rotate the wrong / a nonexistent child.
// Single-DB callers without a name in hand resolve it via
// getProjectWithFirstDatabase first.
//
// Returns null when the id is unknown OR owned by another customer OR
// the named child does not exist (caller can't distinguish, mirroring
// deleteProject's leakage-avoidance shape).
//
// Tokens are intentionally NOT rotated by DSN rotation — the agent-
// facing URL is a contract with the agent runtime; rotating it would
// force re-paste and defeat the purpose of in-place credential rotation.
// (The hybrid token model in PR2 of mcp_url_auth_security makes this
// stronger still: a project can have many sibling tokens, each with
// independent lifecycle. DSN rotation touches no token row at all.)
//
// Failure isolation: if cache.invalidate throws, the DB write is already
// committed (we don't roll back — "DSN rotated" is the durable fact);
// registry.invalidate still runs. Errors in either layer are logged but
// not propagated, since the cache will catch up at worst on next idle
// expiry. Callers see rotation as successful.
export async function rotateProject(
  customer: Customer,
  id: string,
  dsn: string,
  caches: RotationCaches,
  dbName: string,
): Promise<{ id: string; region: Region } | null> {
  const kms = makeKmsContext(process.env);
  const { ciphertext, kmsKeyId } = await encryptDsn(
    kms,
    dsn,
    customer.id,
    customer.region,
  );

  const db = getDb(customer.region);
  const result = await db.transaction(async (tx) => {
    // Ownership-gated parent read first — confirms the project belongs
    // to this customer and gives us the region for the cache invalidation
    // step. Returning null here is indistinguishable from "id unknown",
    // which is the leakage shape we want.
    const parent = await tx
      .select({
        id: projects.id,
        region: projects.region,
      })
      .from(projects)
      .where(
        and(eq(projects.id, id), eq(projects.customerId, customer.id)),
      )
      .limit(1);
    if (parent.length === 0) return null;

    const updated = await tx
      .update(projectDatabases)
      .set({
        encryptedDsn: ciphertext,
        kmsKeyId,
        rotatedAt: new Date(),
      })
      .where(
        and(
          eq(projectDatabases.projectId, id),
          eq(projectDatabases.name, dbName),
        ),
      )
      .returning({ id: projectDatabases.id });
    if (updated.length === 0) return null;
    return {
      id: parent[0]!.id,
      region: parent[0]!.region,
      projectDatabaseId: updated[0]!.id,
    };
  });

  if (!result) return null;

  try {
    caches.cache.invalidate(result.projectDatabaseId, result.region);
  } catch (err) {
    console.error("[rotateProject] cache.invalidate failed", err);
  }
  try {
    await caches.registry.invalidate(result.id);
  } catch (err) {
    console.error("[rotateProject] registry.invalidate failed", err);
  }

  return {
    id: result.id,
    region: result.region,
  };
}

/** Read a project plus one named child for the per-DB detail page.
 *  Returns null when the project is unknown OR owned by another
 *  customer OR the named child does not exist (caller can't
 *  distinguish — same leakage shape as the rotate / delete paths).
 *
 *  Projects to `SafeProjectDatabase` — no encryptedDsn / kmsKeyId.
 *  Callers that need to decrypt (table introspection, proxy resolver)
 *  must use {@link getProjectWithDatabaseAndCredential}. */
export async function getProjectWithDatabase(
  customer: Customer,
  id: string,
  name: string,
): Promise<
  | {
      project: typeof projects.$inferSelect;
      database: SafeProjectDatabase;
    }
  | null
> {
  const db = getDb(customer.region);
  const connRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.customerId, customer.id)))
    .limit(1);
  const conn = connRows[0];
  if (!conn) return null;
  const dbRows = await db
    .select(SAFE_DATABASE_COLUMNS)
    .from(projectDatabases)
    .where(
      and(
        eq(projectDatabases.projectId, conn.id),
        eq(projectDatabases.name, name),
      ),
    )
    .limit(1);
  const database = dbRows[0];
  if (!database) return null;
  return { project: conn, database };
}

/** Credential-bearing variant of {@link getProjectWithDatabase}.
 *  Pulls `encryptedDsn` + `kmsKeyId` so the caller can hand the row to
 *  `DsnResolver.resolve(...)`. The encrypted ciphertext never reaches a
 *  client component or response body — keep it on the server. */
export async function getProjectWithDatabaseAndCredential(
  customer: Customer,
  id: string,
  name: string,
): Promise<
  | {
      project: typeof projects.$inferSelect;
      database: typeof projectDatabases.$inferSelect;
    }
  | null
> {
  const db = getDb(customer.region);
  const connRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.customerId, customer.id)))
    .limit(1);
  const conn = connRows[0];
  if (!conn) return null;
  const dbRows = await db
    .select()
    .from(projectDatabases)
    .where(
      and(
        eq(projectDatabases.projectId, conn.id),
        eq(projectDatabases.name, name),
      ),
    )
    .limit(1);
  const database = dbRows[0];
  if (!database) return null;
  return { project: conn, database };
}

/** List every DB on a project, ordered by name. Data source for the
 *  per-DB context strip (databases/[name]/layout.tsx — sibling tabs +
 *  settings, added by the projects-ux design after the db pages
 *  spent PR-B..PR-3 as dead ends). Returns null when the project is
 *  unknown OR owned by another customer.
 *
 *  Safe projection — no encryptedDsn / kmsKeyId. */
export async function listDatabasesForProject(
  customer: Customer,
  id: string,
): Promise<
  | {
      project: typeof projects.$inferSelect;
      databases: SafeProjectDatabase[];
    }
  | null
> {
  const db = getDb(customer.region);
  const connRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.customerId, customer.id)))
    .limit(1);
  const conn = connRows[0];
  if (!conn) return null;
  const databases = await db
    .select(SAFE_DATABASE_COLUMNS)
    .from(projectDatabases)
    .where(eq(projectDatabases.projectId, conn.id))
    .orderBy(asc(projectDatabases.name));
  return { project: conn, databases };
}

/** Credential-bearing variant of {@link listDatabasesForProject} —
 *  parent + ALL children with `encryptedDsn` + `kmsKeyId`. Required by
 *  the dry-run route, which builds full SpawnOptions (the engine
 *  container boots with every configured DB, same as the proxy path).
 *  Ciphertext never reaches a client component or response body. */
export async function getProjectWithDatabasesAndCredentials(
  customer: Customer,
  id: string,
): Promise<
  | {
      project: typeof projects.$inferSelect;
      databases: Array<typeof projectDatabases.$inferSelect>;
    }
  | null
> {
  const db = getDb(customer.region);
  const connRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.customerId, customer.id)))
    .limit(1);
  const conn = connRows[0];
  if (!conn) return null;
  const databases = await db
    .select()
    .from(projectDatabases)
    .where(eq(projectDatabases.projectId, conn.id))
    .orderBy(asc(projectDatabases.name));
  return { project: conn, databases };
}

/** Resolve a project plus its first database (by name order) — the
 *  single-database convenience read for surfaces that act on "the
 *  project's database" with no name in the URL: the post-create success
 *  page and the JSON DSN-rotate route. A freshly created project has
 *  exactly one child, so "first" is unambiguous there; a multi-DB project
 *  resolves the alphabetically-first child (deterministic). Returns null
 *  when the project is unknown, owned by another customer, or has no
 *  database.
 *
 *  Replaces the old getProjectWithMainDatabase shim: the first database is
 *  no longer always named "main" (createProject names it from the DSN), so
 *  a fixed-name lookup would miss it.
 *
 *  Safe projection — no encryptedDsn / kmsKeyId. */
export async function getProjectWithFirstDatabase(
  customer: Customer,
  id: string,
): Promise<
  | {
      project: typeof projects.$inferSelect;
      database: SafeProjectDatabase;
    }
  | null
> {
  const db = getDb(customer.region);
  const connRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.customerId, customer.id)))
    .limit(1);
  const conn = connRows[0];
  if (!conn) return null;
  const dbRows = await db
    .select(SAFE_DATABASE_COLUMNS)
    .from(projectDatabases)
    .where(eq(projectDatabases.projectId, conn.id))
    .orderBy(asc(projectDatabases.name))
    .limit(1);
  const database = dbRows[0];
  if (!database) return null;
  return { project: conn, database };
}

// Dependency shape for the add / remove / rename helpers — narrower
// than RotationCaches because none of them rotate a credential, so
// DecryptCache invalidation is moot. The running container needs to
// respawn so the OSS engine picks up the new YAML `databases:` block.
export interface DatabaseMutationDeps {
  registry: { invalidate(projectId: string): Promise<void> };
}

/** Returned when a sibling DB already owns the requested name. */
export class DatabaseNameTaken extends Error {
  constructor(public readonly takenName: string) {
    super(`database "${takenName}" already exists on this project`);
    this.name = "DatabaseNameTaken";
  }
}

/** Returned when removeDatabase would leave a project child-less.
 *  The OSS engine spawn requires `databases:` to be non-empty, so we
 *  block the last delete cloud-side rather than letting the container
 *  fail to start on next agent call. */
export class LastDatabaseProtected extends Error {
  constructor() {
    super("a project must have at least one database");
    this.name = "LastDatabaseProtected";
  }
}

// Postgres error code for unique_violation, plus the constraint name on
// the (project_id, name) index in project_databases. Used as a
// belt-and-suspenders catch around add/rename — the FOR UPDATE lock on
// the parent project row should make this unreachable, but if any
// future caller bypasses the helper (or the lock posture changes), the
// outer catch still translates the raw driver error into the typed
// DatabaseNameTaken the dashboard action knows how to render.
const PG_UNIQUE_VIOLATION = "23505";
const NAME_UQ_CONSTRAINT = "project_databases_project_name_uq";

function isUniqueDbNameViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint_name?: unknown };
  return (
    e.code === PG_UNIQUE_VIOLATION && e.constraint_name === NAME_UQ_CONSTRAINT
  );
}

// Add a new DB to an existing project. Encrypts the DSN with the
// customer's region key, inserts the child row, and invalidates the
// running container so the next spawn includes the new entry in the
// YAML `databases:` block. Returns the new child id + project id.
//
// Throws DatabaseNameTaken if the name collides with an existing
// sibling, and PlanLimitError when the project is already at the plan's
// per-project database cap (counted under the same parent lock, so
// concurrent adds can't overshoot). Returns null when the project is
// unknown OR owned by another customer (same leakage shape as
// createProject). The dbName regex is enforced here even though the
// schema CHECK would also catch it, so the caller gets a clean error
// before KMS spend.
export async function addDatabase(
  customer: Customer,
  projectId: string,
  dbName: string,
  dsn: string,
  defaultAccess: AccessLevel,
  // Resolved plan + caps for the org (from resolvePlan() at the call site) —
  // caps.databases is the per-project ceiling enforced here.
  entitlement: ResolvedPlan,
  deps: DatabaseMutationDeps,
): Promise<{ id: string; projectId: string } | null> {
  if (!isValidDatabaseName(dbName)) {
    throw new Error(
      `invalid database name: must match ${DB_NAME_RE} (lowercase alnum + _- , 1–32 chars, leading letter)`,
    );
  }

  const kms = makeKmsContext(process.env);
  const { ciphertext, kmsKeyId } = await encryptDsn(
    kms,
    dsn,
    customer.id,
    customer.region,
  );

  const tableAccess: TableAccessPolicy = {
    default: defaultAccess,
    tables: {},
  };

  const childId = ulid();
  const db = getDb(customer.region);
  let result;
  try {
    result = await db.transaction(async (tx) => {
      // Ownership-gated parent read first AND lock — gives us the
      // project id for the registry invalidation, ensures we never
      // write through to a foreign customer's project, and
      // serializes concurrent add/remove/rename on this same
      // project. Without the lock, two parallel adds for the same
      // alias can each pass the collision pre-check below and the
      // loser would hit the unique constraint at insert time, which
      // would escape as a raw Postgres error instead of
      // DatabaseNameTaken.
      const parent = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.customerId, customer.id),
          ),
        )
        .for("update")
        .limit(1);
      if (parent.length === 0) return null;

      // Per-project database cap (plan.ts caps.databases). Counted under
      // the parent FOR UPDATE lock above, so two concurrent adds can't
      // both read "one below the cap" and overshoot. Infinity caps
      // (Team / self-host) skip the count entirely.
      const { caps, plan } = entitlement;
      if (Number.isFinite(caps.databases)) {
        const siblings = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(projectDatabases)
          .where(eq(projectDatabases.projectId, projectId));
        if (Number(siblings[0]?.count ?? 0) >= caps.databases) {
          throw new PlanLimitError("databases", caps.databases, plan);
        }
      }

      // Pre-check sibling collision (cheap; the lock guarantees the
      // result holds until commit). The unique constraint
      // project_databases_project_name_uq is still the durable
      // enforcer if anything bypasses this helper.
      const collide = await tx
        .select({ id: projectDatabases.id })
        .from(projectDatabases)
        .where(
          and(
            eq(projectDatabases.projectId, projectId),
            eq(projectDatabases.name, dbName),
          ),
        )
        .limit(1);
      if (collide.length > 0) {
        return { error: "name_taken" as const };
      }

      await tx.insert(projectDatabases).values({
        id: childId,
        projectId,
        name: dbName,
        encryptedDsn: ciphertext,
        kmsKeyId,
        tableAccess,
      });
      return { id: parent[0]!.id };
    });
  } catch (err) {
    // Belt-and-suspenders: the FOR UPDATE lock plus the pre-check
    // should make this unreachable, but if a unique violation slips
    // through (driver retries, savepoint quirks, future refactor that
    // drops the lock), translate it into the typed error the
    // dashboard action knows how to surface.
    if (isUniqueDbNameViolation(err)) {
      throw new DatabaseNameTaken(dbName);
    }
    throw err;
  }

  if (!result) return null;
  if ("error" in result) throw new DatabaseNameTaken(dbName);

  try {
    await deps.registry.invalidate(result.id);
  } catch (err) {
    console.error("[addDatabase] registry.invalidate failed", err);
  }

  return { id: childId, projectId: result.id };
}

// Remove a named DB from a project. The project itself is
// preserved — only the child row goes away (FK cascade deletes any
// per-DB state we add later). Audit history stays in
// audit_events_index keyed on the (customer, region, database) tuple,
// which is the compliance posture we want.
//
// Throws LastDatabaseProtected if the named child is the only DB on
// the project (the OSS spawn requires `databases:` non-empty).
// Returns null when the project is unknown / foreign or the child
// doesn't exist on it.
export async function removeDatabase(
  customer: Customer,
  projectId: string,
  dbName: string,
  deps: DatabaseMutationDeps,
): Promise<{ id: string } | null> {
  const db = getDb(customer.region);
  const result = await db.transaction(async (tx) => {
    // Lock the parent project row at the top of the txn so any
    // concurrent add/remove/rename on the same project serializes
    // through here. Without this, two parallel removeDatabase calls
    // on a 2-DB project can each see siblings.length === 2 in
    // their own snapshot, each delete one row, and leave the
    // project child-less — violating LastDatabaseProtected and
    // breaking the next engine spawn.
    const parent = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.customerId, customer.id),
        ),
      )
      .for("update")
      .limit(1);
    if (parent.length === 0) return null;

    // Count siblings BEFORE the delete so we can block the last-DB
    // case. The parent lock above guarantees no other txn can change
    // this count until we commit. N is small (single digits in
    // practice); reading rows and checking length is cheaper to
    // reason about than a raw count() expression.
    const siblings = await tx
      .select({ id: projectDatabases.id })
      .from(projectDatabases)
      .where(eq(projectDatabases.projectId, projectId));
    if (siblings.length <= 1) {
      return { error: "last_database" as const };
    }

    const deleted = await tx
      .delete(projectDatabases)
      .where(
        and(
          eq(projectDatabases.projectId, projectId),
          eq(projectDatabases.name, dbName),
        ),
      )
      .returning({ id: projectDatabases.id });
    if (deleted.length === 0) return null;
    return { id: parent[0]!.id };
  });

  if (!result) return null;
  if ("error" in result) throw new LastDatabaseProtected();

  try {
    await deps.registry.invalidate(result.id);
  } catch (err) {
    console.error("[removeDatabase] registry.invalidate failed", err);
  }

  return { id: result.id };
}

// Rename a DB alias. The OSS engine treats `database` as the agent-facing
// identifier on every tool call, so renaming forces a container restart
// (engine rejects database-alias hot-swap by spec). DecryptCache is
// keyed on the project_database row id, not the name, so no cache
// invalidation is needed.
//
// Throws DatabaseNameTaken on sibling collision. Returns null when the
// project is unknown / foreign or the source name doesn't exist.
export async function renameDatabase(
  customer: Customer,
  projectId: string,
  oldName: string,
  newName: string,
  deps: DatabaseMutationDeps,
): Promise<{ id: string } | null> {
  if (!isValidDatabaseName(newName)) {
    throw new Error(
      `invalid database name: must match ${DB_NAME_RE} (lowercase alnum + _- , 1–32 chars, leading letter)`,
    );
  }
  if (oldName === newName) {
    // No-op rename — short-circuit so callers don't have to special-case
    // it before submitting. We still verify ownership to avoid telling
    // an attacker that a project exists by returning null vs. a no-op.
    const db = getDb(customer.region);
    const parent = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.customerId, customer.id),
        ),
      )
      .limit(1);
    if (parent.length === 0) return null;
    return { id: parent[0]!.id };
  }

  const db = getDb(customer.region);
  let result;
  try {
    result = await db.transaction(async (tx) => {
      // Same FOR UPDATE posture as add/remove — serialize concurrent
      // mutations on this project. Without the lock, another
      // request could insert or rename a sibling to newName between
      // our pre-check and our update; the update would then trip the
      // unique constraint and bubble up as a raw 500 instead of the
      // typed DatabaseNameTaken the dashboard knows how to handle.
      const parent = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.customerId, customer.id),
          ),
        )
        .for("update")
        .limit(1);
      if (parent.length === 0) return null;

      // Sibling-collision pre-check. With the parent lock held, the
      // result holds until commit; the unique constraint is still
      // there as the durable enforcer.
      const collide = await tx
        .select({ id: projectDatabases.id })
        .from(projectDatabases)
        .where(
          and(
            eq(projectDatabases.projectId, projectId),
            eq(projectDatabases.name, newName),
          ),
        )
        .limit(1);
      if (collide.length > 0) {
        return { error: "name_taken" as const };
      }

      const updated = await tx
        .update(projectDatabases)
        .set({ name: newName })
        .where(
          and(
            eq(projectDatabases.projectId, projectId),
            eq(projectDatabases.name, oldName),
          ),
        )
        .returning({ id: projectDatabases.id });
      if (updated.length === 0) return null;
      return { id: parent[0]!.id };
    });
  } catch (err) {
    if (isUniqueDbNameViolation(err)) {
      throw new DatabaseNameTaken(newName);
    }
    throw err;
  }

  if (!result) return null;
  if ("error" in result) throw new DatabaseNameTaken(newName);

  try {
    await deps.registry.invalidate(result.id);
  } catch (err) {
    console.error("[renameDatabase] registry.invalidate failed", err);
  }

  return { id: result.id };
}

/** Server-side fetch for the hierarchical dashboard. Returns one row per
 *  project paired with EVERY child DB on it (each annotated with its
 *  own lastQueryAt from audit_events_index), plus the indexer cursor
 *  that drives the project-level freshness dot. */
export type DashboardDatabase = SafeProjectDatabase & {
  /** Most recent ts of an actual agent query (ATTEMPTED/DECIDED/EXECUTED/
   *  FAILED) on `audit_events_index` for this DB within the customer's
   *  region — control-plane rows (policy / token / pause-resume) are
   *  excluded so a config action never reads as "last query". NULL when the
   *  agent has never queried this DB — the dashboard renders this as
   *  "awaiting first query".
   *
   *  Scoped to (project_id, database) via the 0020 column, so a customer
   *  with two projects each holding a "main" DB sees each card's "last
   *  query" independently — no more fan-in across same-named DBs. Rows that
   *  predate the backfill carry a NULL project_id and are excluded from
   *  this aggregate (a new query re-establishes the timestamp). */
  lastQueryAt: Date | null;
};

export interface DashboardProjectRow {
  project: typeof projects.$inferSelect;
  databases: DashboardDatabase[];
  cursor: {
    lastIndexedAt: Date | null;
    lastErrorAt: Date | null;
  };
  /** Count of usable agent tokens on this project — drives the "agents"
   *  stat on the dashboard list (0 = a non-functional project, surfaced
   *  as a "connect an agent" nudge). Same active predicate as the runtime
   *  resolver; see countActiveTokensByProject. */
  activeTokens: number;
}

// Composite key for the last-query aggregate: a DB name alone fans in
// across projects (two projects each with a "main" DB would collide),
// so the map is keyed on (project_id, database). A space separates the
// two parts unambiguously — a ULID project id is Crockford base32 and a
// DB alias matches DB_NAME_RE, so neither can contain a space.
function lastQueryKey(projectId: string, database: string): string {
  return `${projectId} ${database}`;
}

// Internal helper: compute MAX(ts) per (project_id, database) within
// (customer, region). The compound index
// audit_customer_region_project_ts_idx covers the scan. Grouping by
// project_id (added in 0020) is what makes each card's "last query"
// truly its own — before it, same-named DBs in different projects
// shared a timestamp.
//
// retentionDays clamps the aggregate to the plan's audit window so the
// dashboard freshness dot can't surface "last query" derived from a row
// outside what /audit would show (codex #6 — a retention leak via the
// freshness path). Omitted = no clamp.
async function lastQueryByDatabase(
  customer: Customer,
  retentionDays?: number,
): Promise<Map<string, Date>> {
  const db = getDb(customer.region);
  const since =
    retentionDays !== undefined && Number.isFinite(retentionDays)
      ? new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
      : null;
  const rows = await db
    .select({
      projectId: auditEventsIndex.projectId,
      database: auditEventsIndex.database,
      lastQueryAt: sql<Date | string>`MAX(${auditEventsIndex.ts})`,
    })
    .from(auditEventsIndex)
    .where(
      and(
        eq(auditEventsIndex.customerId, customer.id),
        eq(auditEventsIndex.region, customer.region),
        // "Last query" means an actual agent query — only the OSS per-query
        // lifecycle events count. Control-plane rows ride in the same table
        // (POLICY_CHANGED, TOKEN_CREATED/REVOKED, PROJECT_PAUSED/RESUMED)
        // and several are stamped database="main" with ts=now(); without
        // this filter, pausing a project would make its "main" DB read
        // "last query: just now" with no query ever sent.
        inArray(auditEventsIndex.eventType, [...EVENT_TYPES]),
        // Rows that predate the backfill (or never carried a token) have a
        // NULL project_id and can't be attributed to a card — skip them
        // rather than bucket them under a meaningless key. Also lets the
        // partial project index serve the scan.
        isNotNull(auditEventsIndex.projectId),
        since ? gte(auditEventsIndex.ts, since) : undefined,
      ),
    )
    .groupBy(auditEventsIndex.projectId, auditEventsIndex.database);

  // Some drivers return the aggregate as a string (Postgres TIMESTAMPTZ
  // text representation) instead of a Date; coerce defensively so
  // downstream consumers always see a real Date.
  const map = new Map<string, Date>();
  for (const row of rows) {
    if (!row.lastQueryAt || !row.projectId) continue;
    const d =
      row.lastQueryAt instanceof Date
        ? row.lastQueryAt
        : new Date(row.lastQueryAt);
    map.set(lastQueryKey(row.projectId, row.database), d);
  }
  return map;
}

export async function listDashboardProjects(
  customer: Customer,
  retentionDays?: number,
): Promise<DashboardProjectRow[]> {
  const db = getDb(customer.region);
  // Three-query fetch — parents (with joined cursor), children
  // (IN-list), and per-DB last-query (one GROUP BY per customer). A
  // single inner-join across all three would multiply rows; this keeps
  // each result shape stable.
  const [parents, lastQueryMap] = await Promise.all([
    db
      .select({
        project: projects,
        lastIndexedAt: indexerCursors.lastIndexedAt,
        lastErrorAt: indexerCursors.lastErrorAt,
      })
      .from(projects)
      .leftJoin(
        indexerCursors,
        eq(indexerCursors.projectId, projects.id),
      )
      .where(eq(projects.customerId, customer.id))
      .orderBy(desc(projects.createdAt)),
    lastQueryByDatabase(customer, retentionDays),
  ]);
  if (parents.length === 0) return [];

  const parentIds = parents.map((p) => p.project.id);
  const [children, tokenCounts] = await Promise.all([
    db
      .select(SAFE_DATABASE_COLUMNS)
      .from(projectDatabases)
      .where(inArray(projectDatabases.projectId, parentIds))
      .orderBy(asc(projectDatabases.name)),
    countActiveTokensByProject(customer, parentIds),
  ]);

  const childrenByConn = new Map<string, DashboardDatabase[]>();
  for (const child of children) {
    const list = childrenByConn.get(child.projectId) ?? [];
    list.push({
      ...child,
      lastQueryAt:
        lastQueryMap.get(lastQueryKey(child.projectId, child.name)) ?? null,
    });
    childrenByConn.set(child.projectId, list);
  }

  return parents.map((p) => ({
    project: p.project,
    databases: childrenByConn.get(p.project.id) ?? [],
    cursor: {
      lastIndexedAt: p.lastIndexedAt,
      lastErrorAt: p.lastErrorAt,
    },
    activeTokens: tokenCounts.get(p.project.id) ?? 0,
  }));
}

/** Single-project slice of the dashboard data — the project home
 *  page (/projects/[id]) renders the same db rows + freshness facts
 *  the list page does, scoped to one parent. Same safe projection, same
 *  lastQueryAt semantics (clamped to the plan's retention window).
 *  Returns null on unknown/foreign id — the page 404s with the same
 *  leakage shape as every other project read. */
export async function getProjectHomeData(
  customer: Customer,
  id: string,
  retentionDays?: number,
): Promise<{
  project: typeof projects.$inferSelect;
  databases: DashboardDatabase[];
  cursor: { lastIndexedAt: Date | null; lastErrorAt: Date | null };
} | null> {
  const db = getDb(customer.region);
  const [parents, lastQueryMap] = await Promise.all([
    db
      .select({
        project: projects,
        lastIndexedAt: indexerCursors.lastIndexedAt,
        lastErrorAt: indexerCursors.lastErrorAt,
      })
      .from(projects)
      .leftJoin(
        indexerCursors,
        eq(indexerCursors.projectId, projects.id),
      )
      .where(
        and(eq(projects.id, id), eq(projects.customerId, customer.id)),
      )
      .limit(1),
    lastQueryByDatabase(customer, retentionDays),
  ]);
  const parent = parents[0];
  if (!parent) return null;

  const children = await db
    .select(SAFE_DATABASE_COLUMNS)
    .from(projectDatabases)
    .where(eq(projectDatabases.projectId, parent.project.id))
    .orderBy(asc(projectDatabases.name));

  return {
    project: parent.project,
    databases: children.map((c) => ({
      ...c,
      lastQueryAt:
        lastQueryMap.get(lastQueryKey(c.projectId, c.name)) ?? null,
    })),
    cursor: {
      lastIndexedAt: parent.lastIndexedAt,
      lastErrorAt: parent.lastErrorAt,
    },
  };
}

/** Slim payload for the 60s polling endpoint. Identifiers + freshness
 *  signals only — no policy / table_access / ciphertext. The client
 *  hook merges this into local state and updates only the freshness
 *  dots and meta lines; rename / menu / sheet state stay put. */
export interface DashboardFreshnessSnapshot {
  projects: Array<{
    id: string;
    /** Non-null = paused. Carried on the poll so the dashboard's freshness
     *  dots reflect the kill switch (amber "paused") instead of the stale
     *  indexer-derived live/down — see resolveFreshness. */
    pausedAt: Date | null;
    cursor: {
      lastIndexedAt: Date | null;
      lastErrorAt: Date | null;
    };
    databases: Array<{
      name: string;
      lastQueryAt: Date | null;
    }>;
  }>;
}

export async function getDashboardFreshness(
  customer: Customer,
  retentionDays?: number,
): Promise<DashboardFreshnessSnapshot> {
  const db = getDb(customer.region);
  const [parents, lastQueryMap] = await Promise.all([
    db
      .select({
        id: projects.id,
        pausedAt: projects.pausedAt,
        lastIndexedAt: indexerCursors.lastIndexedAt,
        lastErrorAt: indexerCursors.lastErrorAt,
      })
      .from(projects)
      .leftJoin(
        indexerCursors,
        eq(indexerCursors.projectId, projects.id),
      )
      .where(eq(projects.customerId, customer.id))
      .orderBy(desc(projects.createdAt)),
    lastQueryByDatabase(customer, retentionDays),
  ]);
  if (parents.length === 0) return { projects: [] };

  const parentIds = parents.map((p) => p.id);
  const children = await db
    .select({
      projectId: projectDatabases.projectId,
      name: projectDatabases.name,
    })
    .from(projectDatabases)
    .where(inArray(projectDatabases.projectId, parentIds))
    .orderBy(asc(projectDatabases.name));

  const childrenByConn = new Map<
    string,
    Array<{ name: string; lastQueryAt: Date | null }>
  >();
  for (const child of children) {
    const list = childrenByConn.get(child.projectId) ?? [];
    list.push({
      name: child.name,
      lastQueryAt:
        lastQueryMap.get(lastQueryKey(child.projectId, child.name)) ?? null,
    });
    childrenByConn.set(child.projectId, list);
  }

  return {
    projects: parents.map((p) => ({
      id: p.id,
      pausedAt: p.pausedAt ?? null,
      cursor: {
        lastIndexedAt: p.lastIndexedAt,
        lastErrorAt: p.lastErrorAt,
      },
      databases: childrenByConn.get(p.id) ?? [],
    })),
  };
}
