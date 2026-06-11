// CRUD library for mcp_tokens — the multi-token-per-connection model that
// replaces the single plaintext mcp_token bearer URL. PR1 of N (schema +
// helpers); PR2 wires the proxy resolveByToken / spawner / indexer onto
// this surface, and PR3 builds the dashboard UX. See the design doc at
// dustinlange-lange-labs-mcp-url-auth-security-design-20260520-104330.md
// for the full ratification context.
//
// Conventions mirror apps/web/src/lib/connections.ts:
//   - All mutations run inside db.transaction(...) with FOR UPDATE on the
//     parent connections row, so concurrent mints/revokes on the same
//     connection serialize through here. This is what prevents the "two
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
  connections,
  customers,
  generateToken,
  getDb,
  mcpTokens,
  parseToken,
  validateChecksum,
  type Customer,
  type McpTokenStatus,
  type Region,
} from "@midplane-cloud/db";
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

/** Count the customer's USABLE MCP tokens across every connection they own.
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
    .select({ id: connections.id })
    .from(connections)
    .where(eq(connections.customerId, customerId))) as Array<{ id: string }>;
  const ids = connRows.map((r) => r.id);
  if (ids.length === 0) return 0;
  const rows = (await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(mcpTokens)
    .where(
      and(
        inArray(mcpTokens.connectionId, ids),
        eq(mcpTokens.status, "active"),
        sql`(${mcpTokens.expiresAt} IS NULL OR ${mcpTokens.expiresAt} > NOW())`,
      ),
    )) as Array<{ count: number }>;
  return Number(rows[0]?.count ?? 0);
}

/** Active token count per connection, for the dashboard list's "agents"
 *  stat. "Active" matches countUsableTokens / the runtime resolver:
 *  status='active' AND (expires_at IS NULL OR expires_at > NOW()) — so an
 *  expired-but-unswept row (still 'active' in the table) is NOT counted,
 *  keeping the dashboard number aligned with what an agent could actually
 *  use. Connections with zero active tokens are absent from the map; the
 *  caller defaults to 0. The connectionIds are assumed already
 *  ownership-scoped by the caller (listDashboardConnections derives them
 *  from the customer's own connections). */
export async function countActiveTokensByConnection(
  customer: Customer,
  connectionIds: string[],
): Promise<Map<string, number>> {
  if (connectionIds.length === 0) return new Map();
  const db = getDb(customer.region);
  const rows = (await db
    .select({
      connectionId: mcpTokens.connectionId,
      count: sql<number>`count(*)::int`,
    })
    .from(mcpTokens)
    .where(
      and(
        inArray(mcpTokens.connectionId, connectionIds),
        eq(mcpTokens.status, "active"),
        sql`(${mcpTokens.expiresAt} IS NULL OR ${mcpTokens.expiresAt} > NOW())`,
      ),
    )
    .groupBy(mcpTokens.connectionId)) as Array<{
    connectionId: string;
    count: number;
  }>;
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.connectionId, Number(r.count));
  return map;
}

/** Build + insert a token row inside an EXISTING transaction. The caller owns
 *  the txn and any locking, and is responsible for the TOKEN_CREATED audit
 *  after commit (best-effort — see emitTokenAuditRow).
 *
 *  This exists so createConnection can mint a connection's default token
 *  ATOMICALLY with the connection insert AND the plan-cap check — all under
 *  the same customers-row lock. Minting the default in a separate post-commit
 *  transaction (as createToken does) let a concurrent manual mint slip in
 *  between the cap check and the default insert, pushing the org one token
 *  over its cap. Returns the new id + the show-once plaintext. */
export async function insertTokenRow(
  tx: TxLike,
  row: {
    id: string;
    connectionId: string;
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
    connectionId: row.connectionId,
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
// around createToken — the FOR UPDATE lock on the parent connection
// makes the pre-check sufficient in practice, but if any future caller
// bypasses the helper or the lock posture changes, the raw driver error
// translates into the typed DuplicateTokenName the API knows how to
// render.
const PG_UNIQUE_VIOLATION = "23505";
const NAME_UQ_CONSTRAINT = "mcp_tokens_name_per_connection_uq";

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
    super(`token "${takenName}" already exists on this connection`);
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

/** Mint a new token on a connection. Returns the new id + the plaintext
 *  URL component the caller renders ONCE in the show-once dashboard
 *  modal. The plaintext is never persisted — only its HMAC-SHA256(pepper)
 *  digest lands in the row.
 *
 *  `env` selects the prefix family ("live" vs "test") and is passed
 *  in by the caller (a server action / API route) based on the deploy
 *  tier. The plaintext format is `mp_(live|test)_<32 hex>_<6 base32>`
 *  per packages/db/src/token-format.ts. Returns null when the
 *  connection is unknown or foreign (same leakage-avoidance shape as
 *  rotateConnection / setTableAccess / addDatabase). */
export async function createToken(
  customer: Customer,
  connectionId: string,
  args: {
    name: string;
    expiresAt: Date | null;
    actorClerkUserId: string;
    env: "live" | "test";
    /** Manual mints pass the resolved token cap so the per-customer plan
     *  limit is enforced. The auto-minted default token (createConnection)
     *  passes nothing — its room was already reserved at connection-create
     *  time (decision D8), and re-checking here would block the default on
     *  a connection that was just allowed. Infinity cap (Team) is a no-op. */
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
      // between read and insert (decision D4). customers-before-connection
      // lock order is consistent with createConnection (which locks only
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
      // addDatabase/removeDatabase in connections.ts. Without the lock,
      // two parallel creates with the same name could each pass the
      // pre-check and the loser would hit the unique constraint as a
      // raw Postgres error instead of DuplicateTokenName.
      const parent = await tx
        .select({ id: connections.id })
        .from(connections)
        .where(
          and(
            eq(connections.id, connectionId),
            eq(connections.customerId, customer.id),
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
            eq(mcpTokens.connectionId, connectionId),
            eq(mcpTokens.name, trimmedName),
          ),
        )
        .limit(1);
      if (collide.length > 0) {
        return { error: "name_taken" as const };
      }

      await tx.insert(mcpTokens).values({
        id,
        connectionId,
        name: trimmedName,
        prefix: generated.prefix,
        last4: generated.last4,
        tokenHash,
        pepperKid: pepper.kid,
        createdByUserId: args.actorClerkUserId,
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
  // setTableAccess / setTenantScope in connections.ts.
  try {
    await emitTokenAuditRow(customer, {
      connectionId,
      mcpTokenId: id,
      eventType: "TOKEN_CREATED",
      payload: {
        connection_id: connectionId,
        token_id: id,
        token_name: trimmedName,
        prefix: generated.prefix,
        last4: generated.last4,
        expires_at: args.expiresAt?.toISOString() ?? null,
      },
      actorClerkUserId: args.actorClerkUserId,
    });
  } catch (err) {
    console.error("[createToken] TOKEN_CREATED audit write failed", err);
  }

  return { id, plaintext: generated.plaintext };
}

/** List every token on a connection — dashboard-safe shape (no hash, no
 *  plaintext, no pepper). Ordered newest-first so the show-once mint UX
 *  surfaces the just-created token at the top. Returns null when the
 *  connection is unknown or foreign. */
export async function listTokens(
  customer: Customer,
  connectionId: string,
): Promise<TokenSummary[] | null> {
  const db = getDb(customer.region);
  // Ownership check on the parent without a lock — read-only path,
  // serialization isn't required.
  const parent = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.customerId, customer.id),
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
    .where(eq(mcpTokens.connectionId, connectionId))
    .orderBy(desc(mcpTokens.createdAt));
  return rows;
}

/** Revoke a token. Idempotent — revoking an already-revoked (or expired)
 *  token returns the row without rewriting revoked_at / revoked_reason,
 *  so retried API calls don't trample the original timestamps. Returns
 *  null when the connection or token is unknown or foreign. */
export async function revokeToken(
  customer: Customer,
  connectionId: string,
  tokenId: string,
  args: { reason: string; actorClerkUserId: string },
): Promise<{ id: string } | null> {
  const db = getDb(customer.region);
  const result = await db.transaction(async (tx) => {
    const parent = await tx
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.customerId, customer.id),
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
          eq(mcpTokens.connectionId, connectionId),
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
        connectionId,
        mcpTokenId: tokenId,
        eventType: "TOKEN_REVOKED",
        payload: {
          connection_id: connectionId,
          token_id: tokenId,
          reason: args.reason,
        },
        actorClerkUserId: args.actorClerkUserId,
      });
    } catch (err) {
      console.error("[revokeToken] TOKEN_REVOKED audit write failed", err);
    }
  }

  return { id: result.id };
}

/** Resolve a plaintext token to (token_id, connection_id) for the
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
): Promise<{ tokenId: string; connectionId: string } | null> {
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
        connectionId: mcpTokens.connectionId,
      })
      .from(mcpTokens)
      .where(
        and(
          eq(mcpTokens.tokenHash, hash),
          eq(mcpTokens.status, "active"),
          sql`(${mcpTokens.expiresAt} IS NULL OR ${mcpTokens.expiresAt} > NOW())`,
        ),
      )
      .limit(1);
    if (rows.length > 0) {
      return {
        tokenId: rows[0]!.id,
        connectionId: rows[0]!.connectionId,
      };
    }
  }
  return null;
}

// --- internals --------------------------------------------------------------

export async function emitTokenAuditRow(
  customer: Customer,
  row: {
    connectionId: string;
    mcpTokenId: string;
    eventType: "TOKEN_CREATED" | "TOKEN_REVOKED";
    payload: Record<string, unknown>;
    actorClerkUserId: string;
  },
): Promise<void> {
  // Mirrors emitConfigAuditRow in connections.ts: validates customer.id
  // matches the ULID alphabet before inlining via sql.raw (SET LOCAL
  // rejects parameterized values), runs the bind + insert in one
  // transaction so RLS sees the bound customer_id, and lives in its own
  // transaction separate from the caller's durable mutation (best-effort
  // semantics — an audit failure must not undo a mint/revoke).
  //
  // The `database` column on audit_events_index is NOT NULL DEFAULT
  // 'main'; token events aren't tied to a specific DB so we pass 'main'
  // as a placeholder. PR3's UI work owns the connection-level event
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
      tenantId: row.connectionId,
      region: customer.region,
      queryId: ulid(),
      database: "main",
      ts: new Date(),
      eventType: row.eventType,
      payload: row.payload,
      actorClerkUserId: row.actorClerkUserId,
      mcpTokenId: row.mcpTokenId,
      // Stamp the canonical connection scope (0020) so a connection-
      // filtered /audit keeps these credential events. tenant_id carries
      // the same id for back-compat; connection_id is the column the filter
      // and the FK ON DELETE SET NULL key on.
      connectionId: row.connectionId,
    });
  });
}
