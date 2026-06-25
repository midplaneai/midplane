// CRUD library for mcp_tokens — the multi-token-per-project model that
// replaces the single plaintext mcp_token bearer URL. PR1 of N (schema +
// helpers); PR2 wires the proxy resolveByToken / spawner / indexer onto
// this surface, and PR3 builds the dashboard UX. See the design doc at
// dustinlange-lange-labs-mcp-url-auth-security-design-20260520-104330.md
// for the full ratification context.
//
// Conventions mirror apps/web/src/lib/projects.ts:
//   - All mutations run inside db.transaction(...) with FOR UPDATE on the
//     parent projects row, so concurrent mints/revokes on the same
//     project serialize through here. This is what prevents the "two
//     parallel creates with the same name" race from escaping as a raw
//     unique-constraint violation.
//   - All lookups by id check customer_id ownership on the parent and
//     return null (not throw) for "not found OR foreign" — the caller
//     can't distinguish, by design (leakage avoidance shape).
//   - Typed error classes for predictable user-facing failures.
//   - Best-effort audit emission separate from the durable mutation:
//     audit writes can fail without rolling back the mint/revoke.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { ulid } from "ulid";

import {
  auditEventsIndex,
  projects,
  projectDatabases,
  customers,
  generateToken,
  getDb,
  mcpScopeGrants,
  mcpTokens,
  parseToken,
  validateChecksum,
  type Customer,
  type McpScopeAccess,
  type McpTokenStatus,
  type Region,
} from "@midplane-cloud/db";
import { oauthApplication } from "@midplane-cloud/db/auth-schema";
import { hashToken } from "@midplane-cloud/kms/pepper";

import { PlanLimitError, type Plan } from "./plan.ts";

// Minimal structural type for a Drizzle transaction handle — enough for the
// read/insert helpers below without importing the full driver-specific tx type.
type TxLike = {
  select: (fields?: unknown) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  insert: (table: typeof mcpTokens) => {
    values: (row: typeof mcpTokens.$inferInsert) => Promise<unknown>;
  };
};

/** Count the customer's USABLE MCP tokens across every project they own.
 *  "Usable" matches the runtime resolver (lookupByPlaintext): status='active'
 *  AND (expires_at IS NULL OR expires_at > NOW()). status='active' alone
 *  over-counts — the expiry sweeper lags (it exists for dashboard
 *  truthfulness, not enforcement), so an expired-but-unswept row is still
 *  'active' in the table yet rejected at use time and must NOT consume a
 *  plan slot. Two queries (ids, then count) rather than a join so the same
 *  helper works under both unit-test fakes.
 *
 *  Runs inside the caller's txn — call it AFTER locking the customers row so
 *  the count can't drift between read and insert. */
export async function countUsableTokens(
  tx: TxLike,
  customerId: string,
): Promise<number> {
  const connRows = (await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.customerId, customerId))) as Array<{ id: string }>;
  const ids = connRows.map((r) => r.id);
  if (ids.length === 0) return 0;
  const rows = (await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(mcpTokens)
    .where(
      and(
        inArray(mcpTokens.projectId, ids),
        // OAuth attribution rows (kind='oauth') are NOT plaintext URL tokens
        // and must never consume a plan token slot — only 'url' tokens count.
        eq(mcpTokens.kind, "url"),
        eq(mcpTokens.status, "active"),
        sql`(${mcpTokens.expiresAt} IS NULL OR ${mcpTokens.expiresAt} > NOW())`,
      ),
    )) as Array<{ count: number }>;
  return Number(rows[0]?.count ?? 0);
}

/** Active agent count per project, for the dashboard list's "agents"
 *  stat. Counts BOTH connected interactive OAuth agents (kind='oauth') and
 *  active machine tokens (kind='url') — the same two things the project's
 *  Connect pane lists — so an OAuth-first project (no machine token) still
 *  reads its real agent count instead of "0 → connect an agent".
 *
 *  "Active" matches countUsableTokens / the runtime resolver: status='active'
 *  AND (expires_at IS NULL OR expires_at > NOW()) — so an expired-but-unswept
 *  row (still 'active' in the table) is NOT counted, keeping the dashboard
 *  number aligned with what an agent could actually use. Projects with zero
 *  active agents are absent from the map; the caller defaults to 0. The
 *  projectIds are assumed already ownership-scoped by the caller
 *  (listDashboardProjects derives them from the customer's own projects). */
export async function countActiveTokensByProject(
  customer: Customer,
  projectIds: string[],
): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();
  const db = getDb(customer.region);
  const rows = (await db
    .select({
      projectId: mcpTokens.projectId,
      count: sql<number>`count(*)::int`,
    })
    .from(mcpTokens)
    .where(
      and(
        inArray(mcpTokens.projectId, projectIds),
        // Both credential kinds — OAuth clients and machine tokens — are
        // "connected agents" on the Connect pane, so both count here.
        inArray(mcpTokens.kind, ["url", "oauth"]),
        eq(mcpTokens.status, "active"),
        sql`(${mcpTokens.expiresAt} IS NULL OR ${mcpTokens.expiresAt} > NOW())`,
      ),
    )
    .groupBy(mcpTokens.projectId)) as Array<{
    projectId: string;
    count: number;
  }>;
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.projectId, Number(r.count));
  return map;
}

/** Build + insert a token row inside an EXISTING transaction. The caller owns
 *  the txn and any locking, and is responsible for the TOKEN_CREATED audit
 *  after commit (best-effort — see emitTokenAuditRow).
 *
 *  This exists so createProject can mint a project's default token
 *  ATOMICALLY with the project insert AND the plan-cap check — all under
 *  the same customers-row lock. Minting the default in a separate post-commit
 *  transaction (as createToken does) let a concurrent manual mint slip in
 *  between the cap check and the default insert, pushing the org one token
 *  over its cap. Returns the new id + the show-once plaintext. */
export async function insertTokenRow(
  tx: TxLike,
  row: {
    id: string;
    projectId: string;
    name: string;
    createdByUserId: string;
    expiresAt: Date | null;
    env: "live" | "test";
  },
  pepper: { kid: string; pepper: Buffer },
): Promise<{ id: string; plaintext: string }> {
  const generated = generateToken(row.env);
  const tokenHash = hashToken(pepper.pepper, generated.plaintext);
  await tx.insert(mcpTokens).values({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    prefix: generated.prefix,
    last4: generated.last4,
    tokenHash,
    pepperKid: pepper.kid,
    createdByUserId: row.createdByUserId,
    expiresAt: row.expiresAt,
  });
  return { id: row.id, plaintext: generated.plaintext };
}

const CUSTOMER_ID_ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Postgres error code for unique_violation, plus the constraint names
// declared in 0017_mcp_tokens.sql. Used as the belt-and-suspenders catch
// around createToken — the FOR UPDATE lock on the parent project
// makes the pre-check sufficient in practice, but if any future caller
// bypasses the helper or the lock posture changes, the raw driver error
// translates into the typed DuplicateTokenName the API knows how to
// render.
const PG_UNIQUE_VIOLATION = "23505";
const NAME_UQ_CONSTRAINT = "mcp_tokens_name_per_project_uq";

function isDuplicateNameViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint_name?: unknown };
  return (
    e.code === PG_UNIQUE_VIOLATION && e.constraint_name === NAME_UQ_CONSTRAINT
  );
}

/** Returned when a sibling token already owns the requested name. */
export class DuplicateTokenName extends Error {
  constructor(public readonly takenName: string) {
    super(`token "${takenName}" already exists on this project`);
    this.name = "DuplicateTokenName";
  }
}

/** Returned when expiresAt is non-null and not strictly in the future.
 *  Catches dashboard form bugs and any caller passing a stale Date
 *  before the mint reaches the DB. */
export class ExpiryInThePast extends Error {
  constructor() {
    super("expiresAt must be in the future (or null for never)");
    this.name = "ExpiryInThePast";
  }
}

/** Dashboard-safe row shape — no token_hash, no plaintext, no pepper kid. */
export interface TokenSummary {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  createdByUserId: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  lastUsedUa: string | null;
  status: McpTokenStatus;
  revokedAt: Date | null;
  revokedReason: string | null;
}

/** Mint a new token on a project. Returns the new id + the plaintext
 *  URL component the caller renders ONCE in the show-once dashboard
 *  modal. The plaintext is never persisted — only its HMAC-SHA256(pepper)
 *  digest lands in the row.
 *
 *  `env` selects the prefix family ("live" vs "test") and is passed
 *  in by the caller (a server action / API route) based on the deploy
 *  tier. The plaintext format is `mp_(live|test)_<32 hex>_<6 base32>`
 *  per packages/db/src/token-format.ts. Returns null when the
 *  project is unknown or foreign (same leakage-avoidance shape as
 *  rotateProject / setTableAccess / addDatabase). */
export async function createToken(
  customer: Customer,
  projectId: string,
  args: {
    name: string;
    expiresAt: Date | null;
    actorUserId: string;
    env: "live" | "test";
    /** Manual mints pass the resolved token cap so the per-customer plan
     *  limit is enforced. The auto-minted default token (createProject)
     *  passes nothing — its room was already reserved at project-create
     *  time (decision D8), and re-checking here would block the default on
     *  a project that was just allowed. Infinity cap (Team) is a no-op. */
    planLimit?: { tokenCap: number; plan: Plan };
  },
  pepper: { kid: string; pepper: Buffer },
): Promise<{ id: string; plaintext: string } | null> {
  const trimmedName = args.name.trim();
  if (trimmedName.length === 0) {
    throw new Error("token name is required");
  }
  if (args.expiresAt !== null && args.expiresAt.getTime() <= Date.now()) {
    throw new ExpiryInThePast();
  }

  const generated = generateToken(args.env);
  const tokenHash = hashToken(pepper.pepper, generated.plaintext);
  const id = ulid();

  const db = getDb(customer.region);
  let result;
  try {
    result = await db.transaction(async (tx) => {
      // Plan cap (manual mints only — `planLimit` is absent on the
      // auto-minted default). Lock the customers row FIRST so concurrent
      // mints for this org serialize and the usable-token count can't drift
      // between read and insert (decision D4). customers-before-project
      // lock order is consistent with createProject (which locks only
      // customers), so no deadlock cycle. Infinity cap (Team) short-circuits
      // — never scan a large token set for an unlimited customer.
      if (args.planLimit && Number.isFinite(args.planLimit.tokenCap)) {
        await tx
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.id, customer.id))
          .for("update")
          .limit(1);
        const used = await countUsableTokens(tx, customer.id);
        if (used >= args.planLimit.tokenCap) {
          throw new PlanLimitError(
            "tokens",
            args.planLimit.tokenCap,
            args.planLimit.plan,
          );
        }
      }

      // Ownership-gated parent read + lock — same posture as
      // addDatabase/removeDatabase in projects.ts. Without the lock,
      // two parallel creates with the same name could each pass the
      // pre-check and the loser would hit the unique constraint as a
      // raw Postgres error instead of DuplicateTokenName.
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

      // Pre-check sibling collision on name. With the parent lock held,
      // the result holds until commit; the unique constraint is still
      // the durable enforcer if anything bypasses this helper.
      const collide = await tx
        .select({ id: mcpTokens.id })
        .from(mcpTokens)
        .where(
          and(
            eq(mcpTokens.projectId, projectId),
            eq(mcpTokens.name, trimmedName),
          ),
        )
        .limit(1);
      if (collide.length > 0) {
        return { error: "name_taken" as const };
      }

      await tx.insert(mcpTokens).values({
        id,
        projectId,
        name: trimmedName,
        prefix: generated.prefix,
        last4: generated.last4,
        tokenHash,
        pepperKid: pepper.kid,
        createdByUserId: args.actorUserId,
        expiresAt: args.expiresAt,
      });

      return { ok: true as const };
    });
  } catch (err) {
    if (isDuplicateNameViolation(err)) {
      throw new DuplicateTokenName(trimmedName);
    }
    throw err;
  }

  if (!result) return null;
  if ("error" in result) throw new DuplicateTokenName(trimmedName);

  // Best-effort audit emission. Failure to write audit shouldn't undo the
  // durable mint (already committed). Same fail-soft posture as
  // setTableAccess / setTenantScope in projects.ts.
  try {
    await emitTokenAuditRow(customer, {
      projectId,
      mcpTokenId: id,
      eventType: "TOKEN_CREATED",
      payload: {
        project_id: projectId,
        token_id: id,
        token_name: trimmedName,
        prefix: generated.prefix,
        last4: generated.last4,
        expires_at: args.expiresAt?.toISOString() ?? null,
      },
      actorUserId: args.actorUserId,
    });
  } catch (err) {
    console.error("[createToken] TOKEN_CREATED audit write failed", err);
  }

  return { id, plaintext: generated.plaintext };
}

/** List every token on a project — dashboard-safe shape (no hash, no
 *  plaintext, no pepper). Ordered newest-first so the show-once mint UX
 *  surfaces the just-created token at the top. Returns null when the
 *  project is unknown or foreign. */
export async function listTokens(
  customer: Customer,
  projectId: string,
): Promise<TokenSummary[] | null> {
  const db = getDb(customer.region);
  // Ownership check on the parent without a lock — read-only path,
  // serialization isn't required.
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

  const rows = await db
    .select({
      id: mcpTokens.id,
      name: mcpTokens.name,
      prefix: mcpTokens.prefix,
      last4: mcpTokens.last4,
      createdByUserId: mcpTokens.createdByUserId,
      createdAt: mcpTokens.createdAt,
      expiresAt: mcpTokens.expiresAt,
      lastUsedAt: mcpTokens.lastUsedAt,
      lastUsedIp: mcpTokens.lastUsedIp,
      lastUsedUa: mcpTokens.lastUsedUa,
      status: mcpTokens.status,
      revokedAt: mcpTokens.revokedAt,
      revokedReason: mcpTokens.revokedReason,
    })
    .from(mcpTokens)
    // Only plaintext URL tokens are shown in the dashboard list; OAuth
    // attribution rows (kind='oauth') carry no prefix/last4 the user issued
    // and are invisible here by design.
    .where(
      and(
        eq(mcpTokens.projectId, projectId),
        eq(mcpTokens.kind, "url"),
      ),
    )
    .orderBy(desc(mcpTokens.createdAt));
  return rows;
}

/** One database an agent may reach, with the access it was granted. */
export interface AgentScopeEntry {
  database: string;
  access: McpScopeAccess;
}

/** A connected agent — either a headless URL/PAT token (`kind: "url"`) or an
 *  interactive OAuth client (`kind: "oauth"`). Unifies the two so the dashboard
 *  renders one list. Dashboard-safe: no token_hash / plaintext / pepper kid. */
export interface AgentSummary {
  kind: "url" | "oauth";
  id: string;
  /** Token name (url) or the OAuth client's display name (oauth). */
  name: string;
  /** Env prefix (mp_live / mp_test) for url tokens; null for OAuth agents. */
  prefix: string | null;
  /** Last 4 of the token entropy (url) or of the OAuth client id (oauth). */
  last4: string;
  createdByUserId: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  lastUsedUa: string | null;
  status: McpTokenStatus;
  revokedAt: Date | null;
  revokedReason: string | null;
  /** Databases (of THIS project) the agent may reach + at what access. Empty =
   *  unscoped (full project access — the legacy/API-token default). */
  scope: AgentScopeEntry[];
}

/** Every connected agent on a project — OAuth clients AND headless URL tokens —
 *  each with its per-database scope. The dashboard Connect pane renders this;
 *  the REST `/api/projects/:id/tokens` surface still uses listTokens (URL
 *  tokens only). Returns null when the project is unknown or foreign. */
export async function listProjectAgents(
  customer: Customer,
  projectId: string,
): Promise<AgentSummary[] | null> {
  const db = getDb(customer.region);
  const parent = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(eq(projects.id, projectId), eq(projects.customerId, customer.id)),
    )
    .limit(1);
  if (parent.length === 0) return null;

  // Both credential kinds in one list. kind='oauth' rows are the per-(project,
  // client) attribution rows the OAuth path mints; kind='url' are PAT tokens.
  const rows = await db
    .select({
      id: mcpTokens.id,
      name: mcpTokens.name,
      prefix: mcpTokens.prefix,
      last4: mcpTokens.last4,
      kind: mcpTokens.kind,
      clientId: mcpTokens.clientId,
      createdByUserId: mcpTokens.createdByUserId,
      createdAt: mcpTokens.createdAt,
      expiresAt: mcpTokens.expiresAt,
      lastUsedAt: mcpTokens.lastUsedAt,
      lastUsedIp: mcpTokens.lastUsedIp,
      lastUsedUa: mcpTokens.lastUsedUa,
      status: mcpTokens.status,
      revokedAt: mcpTokens.revokedAt,
      revokedReason: mcpTokens.revokedReason,
    })
    .from(mcpTokens)
    .where(
      and(
        eq(mcpTokens.projectId, projectId),
        inArray(mcpTokens.kind, ["url", "oauth"]),
      ),
    )
    .orderBy(desc(mcpTokens.createdAt));
  if (rows.length === 0) return [];

  // All scope grants whose database belongs to THIS project, with the DB name.
  // The DB join scopes the result to this project (a grant's subject — token or
  // client — may also hold grants on other projects).
  const grantRows = await db
    .select({
      database: projectDatabases.name,
      access: mcpScopeGrants.access,
      mcpTokenId: mcpScopeGrants.mcpTokenId,
      clientId: mcpScopeGrants.clientId,
    })
    .from(mcpScopeGrants)
    .innerJoin(
      projectDatabases,
      eq(projectDatabases.id, mcpScopeGrants.projectDatabaseId),
    )
    .where(eq(projectDatabases.projectId, projectId));

  const byToken = new Map<string, AgentScopeEntry[]>();
  const byClient = new Map<string, AgentScopeEntry[]>();
  for (const g of grantRows) {
    const entry: AgentScopeEntry = { database: g.database, access: g.access };
    if (g.mcpTokenId) {
      const arr = byToken.get(g.mcpTokenId);
      if (arr) arr.push(entry);
      else byToken.set(g.mcpTokenId, [entry]);
    } else if (g.clientId) {
      const arr = byClient.get(g.clientId);
      if (arr) arr.push(entry);
      else byClient.set(g.clientId, [entry]);
    }
  }

  // Resolve OAuth client → human display name (DCR client_name). Absent for
  // clients that didn't send one; we fall back to a generic label.
  const clientIds = rows
    .filter((r) => r.kind === "oauth" && r.clientId)
    .map((r) => r.clientId!);
  const clientNames = new Map<string, string | null>();
  if (clientIds.length > 0) {
    const apps = await db
      .select({ clientId: oauthApplication.clientId, name: oauthApplication.name })
      .from(oauthApplication)
      .where(inArray(oauthApplication.clientId, clientIds));
    for (const a of apps) clientNames.set(a.clientId, a.name);
  }

  return rows.map((r): AgentSummary => {
    const isOauth = r.kind === "oauth";
    const scope = (
      isOauth ? byClient.get(r.clientId ?? "") : byToken.get(r.id)
    )?.slice() ?? [];
    scope.sort((a, b) => a.database.localeCompare(b.database));
    return {
      kind: isOauth ? "oauth" : "url",
      id: r.id,
      name: isOauth
        ? (clientNames.get(r.clientId ?? "") || "OAuth agent")
        : r.name,
      prefix: isOauth ? null : r.prefix,
      last4: r.last4,
      createdByUserId: r.createdByUserId,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      lastUsedAt: r.lastUsedAt,
      lastUsedIp: r.lastUsedIp,
      lastUsedUa: r.lastUsedUa,
      status: r.status,
      revokedAt: r.revokedAt,
      revokedReason: r.revokedReason,
      scope,
    };
  });
}

/** Revoke a token. Idempotent — revoking an already-revoked (or expired)
 *  token returns the row without rewriting revoked_at / revoked_reason,
 *  so retried API calls don't trample the original timestamps. Returns
 *  null when the project or token is unknown or foreign. */
export async function revokeToken(
  customer: Customer,
  projectId: string,
  tokenId: string,
  args: { reason: string; actorUserId: string },
): Promise<{ id: string } | null> {
  const db = getDb(customer.region);
  const result = await db.transaction(async (tx) => {
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

    // Read current status first — revoking an already-revoked or expired
    // token is a no-op that returns the existing row without rewriting
    // revoked_at / revoked_reason. Keeps the original timestamps as the
    // forensic record; retried API calls remain idempotent.
    const existing = await tx
      .select({ id: mcpTokens.id, status: mcpTokens.status })
      .from(mcpTokens)
      .where(
        and(
          eq(mcpTokens.projectId, projectId),
          eq(mcpTokens.id, tokenId),
        ),
      )
      .for("update")
      .limit(1);
    if (existing.length === 0) return null;

    if (existing[0]!.status === "active") {
      await tx
        .update(mcpTokens)
        .set({
          status: "revoked",
          revokedAt: new Date(),
          revokedReason: args.reason,
        })
        .where(eq(mcpTokens.id, tokenId));
      return { id: tokenId, transitioned: true as const };
    }
    return { id: tokenId, transitioned: false as const };
  });

  if (!result) return null;

  if (result.transitioned) {
    try {
      await emitTokenAuditRow(customer, {
        projectId,
        mcpTokenId: tokenId,
        eventType: "TOKEN_REVOKED",
        payload: {
          project_id: projectId,
          token_id: tokenId,
          reason: args.reason,
        },
        actorUserId: args.actorUserId,
      });
    } catch (err) {
      console.error("[revokeToken] TOKEN_REVOKED audit write failed", err);
    }
  }

  return { id: result.id };
}

/** Resolve a plaintext token to (token_id, project_id) for the
 *  regional Postgres. Validates format + checksum before any DB hit so
 *  malformed inputs cost nothing. Returns null for any non-matching
 *  shape: malformed, bad CRC, unknown hash, revoked / expired row, or
 *  row hashed with a pepper kid the caller's map doesn't include
 *  (pepper-rotation resilience).
 *
 *  `region` selects which regional Postgres to query — the design doc
 *  draft omitted this argument, but the proxy is global and the DB /
 *  pepper trust boundary is per-region; making region explicit here
 *  keeps the caller honest about which jurisdiction the lookup
 *  targets. PR2's resolveByToken decides whether to try regions
 *  sequentially or in parallel.
 *
 *  The conditional `last_used_*` UPDATE (5-min debounce) is NOT applied
 *  here — that belongs in the proxy boundary (PR2) where the request
 *  context (ip, user-agent) is available. This function just resolves
 *  the row. */
export async function lookupByPlaintext(
  plaintext: string,
  region: Region,
  peppers: Map<string, Buffer>,
): Promise<{ tokenId: string; projectId: string } | null> {
  const parsed = parseToken(plaintext);
  if (!parsed) return null;
  if (!validateChecksum(parsed)) return null;

  const db = getDb(region);
  // V1 always has exactly one pepper per region; future rotation
  // introduces additional kids and the loop tries each in turn against
  // mcp_tokens.token_hash. Status and expiry are filtered in the WHERE
  // so a revoked or past-due row never resolves. NOW() is the DB clock,
  // not the app clock — clock skew can't sneak a token past expiry.
  for (const pepper of peppers.values()) {
    const hash = hashToken(pepper, plaintext);
    const rows = await db
      .select({
        id: mcpTokens.id,
        projectId: mcpTokens.projectId,
      })
      .from(mcpTokens)
      .where(
        and(
          eq(mcpTokens.tokenHash, hash),
          eq(mcpTokens.kind, "url"),
          eq(mcpTokens.status, "active"),
          sql`(${mcpTokens.expiresAt} IS NULL OR ${mcpTokens.expiresAt} > NOW())`,
        ),
      )
      .limit(1);
    if (rows.length > 0) {
      return {
        tokenId: rows[0]!.id,
        projectId: rows[0]!.projectId,
      };
    }
  }
  return null;
}

/** Mint-or-get the attribution row that binds an OAuth client to a project,
 *  for the MCP-OAuth proxy path (lib/proxy.ts proxyMcpOAuth).
 *
 *  The OAuth bearer authenticates the user, but the engine still stamps a
 *  per-agent `mcp_token_id` on every audit row (via X-Midplane-Token-Id). That
 *  id must be a real mcp_tokens row so the audit FK holds. We mint exactly ONE
 *  `kind='oauth'` row per (project, OAuth client) — the registered MCP
 *  client IS the agent identity — and return its id. The row carries no HMAC
 *  secret (token_hash/pepper_kid NULL) and never resolves via the URL proxy; it
 *  exists solely so per-agent attribution survives the URL→OAuth switch.
 *
 *  Idempotent under concurrent first-use: the (project_id, client_id) partial
 *  unique index (kind='oauth') serializes the mint; a racing insert is caught
 *  and the winner's row re-read. */
export async function ensureOAuthAttributionToken(
  db: ReturnType<typeof getDb>,
  args: { projectId: string; clientId: string; userId: string },
): Promise<{ id: string; status: McpTokenStatus }> {
  const findExisting = () =>
    db
      .select({ id: mcpTokens.id, status: mcpTokens.status })
      .from(mcpTokens)
      .where(
        and(
          eq(mcpTokens.projectId, args.projectId),
          eq(mcpTokens.clientId, args.clientId),
          eq(mcpTokens.kind, "oauth"),
        ),
      )
      .limit(1);

  // The row's status is returned so the proxy can gate on it — a revoked OAuth
  // agent must be denied even though its grants still resolve. Mint-or-GET does
  // NOT reactivate a revoked row; re-consent does that (reactivateOAuthAttributionToken).
  const existing = await findExisting();
  if (existing[0]) return { id: existing[0].id, status: existing[0].status };

  const id = ulid();
  try {
    await db.insert(mcpTokens).values({
      id,
      projectId: args.projectId,
      // Encodes the client id so the (project_id, name) unique also guards
      // one-row-per-client; the partial unique on (project_id, client_id)
      // is the primary guard.
      name: `oauth:${args.clientId}`,
      // Sentinels: OAuth rows have no plaintext, but prefix/last4 stay NOT NULL
      // (the audit token-label join reads last4). mp_oauth marks the kind;
      // last4 surfaces which client.
      prefix: "mp_oauth",
      last4: args.clientId.slice(-4),
      kind: "oauth",
      clientId: args.clientId,
      createdByUserId: args.userId,
      // token_hash / pepper_kid omitted → NULL (no HMAC secret for OAuth rows).
    });
    return { id, status: "active" };
  } catch (err) {
    const raced = await findExisting();
    if (raced[0]) return { id: raced[0].id, status: raced[0].status };
    throw err;
  }
}

/** Reactivate a revoked OAuth attribution row on re-consent. When a user
 *  revokes an interactive agent we flip its (project, client) attribution row to
 *  status='revoked', and the proxy denies it (ensureOAuthAttributionToken returns
 *  the revoked status). Re-approving the same client through the consent flow
 *  must restore access — so the consent action calls this to clear the revoked
 *  state for the row it just re-granted. Ownership-scoped (only within a project
 *  this customer owns) and a no-op when there's no revoked row to restore. */
export async function reactivateOAuthAttributionToken(
  customer: Customer,
  projectId: string,
  clientId: string,
): Promise<void> {
  const db = getDb(customer.region);
  const owned = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(eq(projects.id, projectId), eq(projects.customerId, customer.id)),
    )
    .limit(1);
  if (owned.length === 0) return;
  await db
    .update(mcpTokens)
    .set({ status: "active", revokedAt: null, revokedReason: null })
    .where(
      and(
        eq(mcpTokens.projectId, projectId),
        eq(mcpTokens.clientId, clientId),
        eq(mcpTokens.kind, "oauth"),
        eq(mcpTokens.status, "revoked"),
      ),
    );
}

// --- internals --------------------------------------------------------------

export async function emitTokenAuditRow(
  customer: Customer,
  row: {
    projectId: string;
    mcpTokenId: string;
    eventType: "TOKEN_CREATED" | "TOKEN_REVOKED";
    payload: Record<string, unknown>;
    actorUserId: string;
  },
): Promise<void> {
  // Mirrors emitConfigAuditRow in projects.ts: validates customer.id
  // matches the ULID alphabet before inlining via sql.raw (SET LOCAL
  // rejects parameterized values), runs the bind + insert in one
  // transaction so RLS sees the bound customer_id, and lives in its own
  // transaction separate from the caller's durable mutation (best-effort
  // semantics — an audit failure must not undo a mint/revoke).
  //
  // The `database` column on audit_events_index is NOT NULL DEFAULT
  // 'main'; token events aren't tied to a specific DB so we pass 'main'
  // as a placeholder. PR3's UI work owns the project-level event
  // surface where this distinction matters; for now the column carries
  // the schema default's semantics.
  if (!CUSTOMER_ID_ULID_RE.test(customer.id)) {
    throw new Error("customer.id must be a ULID");
  }
  const db = getDb(customer.region);
  await db.transaction(async (tx) => {
    await tx.execute(
      sql.raw(`SET LOCAL app.customer_id = '${customer.id}'`),
    );
    await tx.insert(auditEventsIndex).values({
      id: ulid(),
      customerId: customer.id,
      tenantId: row.projectId,
      region: customer.region,
      queryId: ulid(),
      database: "main",
      ts: new Date(),
      eventType: row.eventType,
      payload: row.payload,
      actorUserId: row.actorUserId,
      mcpTokenId: row.mcpTokenId,
      // Stamp the canonical project scope (0020) so a project-
      // filtered /audit keeps these credential events. tenant_id carries
      // the same id for back-compat; project_id is the column the filter
      // and the FK ON DELETE SET NULL key on.
      projectId: row.projectId,
    });
  });
}
