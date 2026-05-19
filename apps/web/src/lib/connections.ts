import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { ulid } from "ulid";

import {
  auditEventsIndex,
  connectionDatabases,
  connections,
  EMPTY_TENANT_SCOPE,
  getDb,
  indexerCursors,
  validatePolicy,
  validateTenantScope,
  type AccessLevel,
  type Customer,
  type DatabaseEntry,
  type TableAccessPolicy,
  type TenantScopeConfig,
} from "@midplane-cloud/db";
import {
  encryptDsn,
  makeKmsContext,
  type Region,
} from "@midplane-cloud/kms";

import { normalizeName } from "./connection-name.ts";

export {
  MAX_CONNECTION_NAME_LENGTH,
  normalizeName,
} from "./connection-name.ts";

// Default child name applied to the auto-created DB when a connection is
// first created. A connection has 1+ children, all of which share the
// connection's mcp_token; the add-second-DB flow lives in PR-C and the
// per-DB helpers below take an explicit `dbName` argument that defaults
// to this value.
export const DEFAULT_DATABASE_NAME = "main";

// Mirror of the OSS engine's DB_NAME_RE. A name validated here also
// passes OSS-side parsing without an extra round-trip.
const DB_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function isValidDatabaseName(s: unknown): s is string {
  return typeof s === "string" && DB_NAME_RE.test(s);
}

// Shared create-connection path used by both the Server Action behind the
// paste-DSN form and the JSON POST /api/connections route. Encrypts the DSN
// with the customer's region key, persists the ciphertext on a
// connection_databases row named "main", and mints an opaque MCP token on
// the parent connection. Returns the new parent id and token; the caller
// decides whether to render a success page or return JSON.
export async function createConnection(
  customer: Customer,
  dsn: string,
  name: string | null = null,
  defaultAccess: AccessLevel = "read",
): Promise<{ id: string; mcpToken: string }> {
  const kms = makeKmsContext(process.env);
  const { ciphertext, kmsKeyId } = await encryptDsn(
    kms,
    dsn,
    customer.id,
    customer.region,
  );

  const id = ulid();
  // 32 hex chars (~128 bits of entropy) — opaque, URL-safe, no PII.
  const mcpToken = crypto.randomUUID().replace(/-/g, "");

  // Initial policy: default = customer's choice from the create form,
  // tables = {} (per-table overrides are added later from the permission
  // grid on the connection detail page). The schema column default
  // ('deny', {}) is the safety net for any code path that bypasses this
  // helper; this insert overrides it with the customer's selection.
  const tableAccess: TableAccessPolicy = {
    default: defaultAccess,
    tables: {},
  };

  const childId = ulid();
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.insert(connections).values({
      id,
      customerId: customer.id,
      region: customer.region,
      name: normalizeName(name),
      mcpToken,
    });
    await tx.insert(connectionDatabases).values({
      id: childId,
      connectionId: id,
      name: DEFAULT_DATABASE_NAME,
      encryptedDsn: ciphertext,
      kmsKeyId,
      tableAccess,
    });
  });

  return { id, mcpToken };
}

export function isValidDsn(s: unknown): s is string {
  return typeof s === "string" && /^postgres(ql)?:\/\//i.test(s) && s.length >= 8;
}

// Update the user-supplied name on the parent connection. Cosmetic — no
// caches to invalidate, no container to restart, no token rotation.
// Returns null when the id is unknown OR owned by another customer
// (matches deleteConnection's leakage-avoidance shape).
export async function renameConnection(
  customer: Customer,
  id: string,
  name: string | null,
): Promise<{ name: string | null } | null> {
  const db = getDb();
  const updated = await db
    .update(connections)
    .set({ name: normalizeName(name) })
    .where(and(eq(connections.id, id), eq(connections.customerId, customer.id)))
    .returning({ name: connections.name });
  return updated[0] ?? null;
}

// Delete a connection only if it belongs to the calling customer. Returns
// the number of rows deleted (0 if the id is unknown OR owned by another
// customer — the caller can't distinguish, by design, to avoid leaking
// existence). The matching indexer_cursors row is also removed so the
// staleness probe and any operational reporting on cursors don't pick
// up orphans for connections that no longer exist.
//
// Children in connection_databases are removed by the FK ON DELETE
// CASCADE declared in 0008 — no explicit child delete here.
//
// Returns the deleted row's mcpToken so the caller can stop the running
// container — without that step the OSS sidecar lingers (still holding
// the now-deleted DSNs in env) until its 30-minute idle timer fires.
export async function deleteConnection(
  customer: Customer,
  id: string,
): Promise<{ mcpToken: string } | null> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(connections)
      .where(
        and(eq(connections.id, id), eq(connections.customerId, customer.id)),
      )
      .returning({ id: connections.id, mcpToken: connections.mcpToken });
    const row = deleted[0];
    if (!row) return null;
    await tx
      .delete(indexerCursors)
      .where(eq(indexerCursors.mcpToken, row.mcpToken));
    return { mcpToken: row.mcpToken };
  });
}

// Dependencies rotateConnection needs to invalidate the in-memory layers.
// Concrete implementations live in @midplane-cloud/router; we accept the
// minimal shape so unit tests don't have to construct a full registry.
export interface RotationCaches {
  /** DecryptCache invalidate is per-credential — keyed on the
   *  connection_databases.id (the credential), not the parent connection.
   *  Multi-DB rollout in 0008. */
  cache: { invalidate(connectionDatabaseId: string, region: Region): void };
  registry: { invalidate(token: string): Promise<void> };
}

// Dependencies setTableAccess needs to push the new policy to the
// running engine (preferred path) or, if that fails non-recoverably,
// fall back to stop-and-respawn.
//
// pushPolicy carries a multi-DB body — every DB on the connection must
// be listed since OSS drops absent entries from the engine's registry.
// The caller loads sibling DBs from PG and assembles the full set.
export interface PolicyPushDeps {
  registry: { invalidate(token: string): Promise<void> };
  pushPolicy(
    token: string,
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

// Replace the table_access policy on one DB of a connection. Preferred
// path is hot-reload via POST /admin/policy on the running engine — the
// agent's MCP session stays alive and a POLICY_RELOADED audit event is
// emitted. If no container is running OR the engine doesn't expose the
// endpoint, the Postgres write alone is enough; the next spawn reads
// the new policy from PG. On a 5xx/401/network failure we fall back to
// stop-and-respawn (matches rotateConnection's fail-soft posture). On
// 400 we do NOT fall back — engine kept the old policy, so the running
// session is fine; respawn would re-read the now-rejected policy from
// PG and fail the spawn. Caller surfaces the engine's validator
// message to the user.
//
// `dbName` defaults to "main" so existing single-DB callers keep
// working; multi-DB callers pass the agent-facing alias explicitly.
//
// Returns null when the id is unknown OR owned by another customer OR
// the named child does not exist (mirrors the leakage-avoidance shape
// of rotateConnection / delete — caller can't distinguish from "id
// unknown").
//
// Validation runs here AND at the spawner boundary; the dashboard form
// also validates before submitting, so a malformed policy reaches this
// function only via a hostile / buggy non-browser caller.
export async function setTableAccess(
  customer: Customer,
  id: string,
  policy: TableAccessPolicy,
  deps: PolicyPushDeps,
  actorClerkUserId: string,
  dbName: string = DEFAULT_DATABASE_NAME,
): Promise<{ mcpToken: string } | null> {
  const validation = validatePolicy(policy);
  if (!validation.ok) {
    const summary = validation.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`invalid policy: ${summary}`);
  }

  const db = getDb();
  // Three-step in a txn: ownership check on the parent (so we don't leak
  // existence by writing through to a foreign customer's DB), update the
  // named child's tableAccess, then snapshot every DB on the connection
  // (post-update) for the hot-reload body. RETURNING on the child write
  // distinguishes "child not found" from "wrote but no policy change"
  // and keeps the leakage-avoidance shape (null for both cases).
  //
  // Sibling DBs ride along because OSS hot-reload drops any DB absent
  // from the body — we have to re-state every DB to keep them registered.
  //
  // FOR UPDATE on the parent serializes concurrent setTableAccess calls
  // on the same connection: without it, two parallel edits to different
  // DBs each read their own snapshot of siblings and the engine ends up
  // with the loser's stale view of the winner's DB. Same posture as
  // addDatabase/removeDatabase/renameDatabase below. NOTE: a narrower
  // race remains between commit-of-T1 and pushPolicy-of-T1 vs T2 — the
  // engine converges on the next edit since each push sends full state,
  // but a per-token push mutex would close it fully.
  const result = await db.transaction(async (tx) => {
    const parent = await tx
      .select({ mcpToken: connections.mcpToken })
      .from(connections)
      .where(
        and(eq(connections.id, id), eq(connections.customerId, customer.id)),
      )
      .for("update")
      .limit(1);
    if (parent.length === 0) return null;
    const updated = await tx
      .update(connectionDatabases)
      .set({ tableAccess: validation.value })
      .where(
        and(
          eq(connectionDatabases.connectionId, id),
          eq(connectionDatabases.name, dbName),
        ),
      )
      .returning({ id: connectionDatabases.id });
    if (updated.length === 0) return null;
    const siblings = await tx
      .select({
        id: connectionDatabases.id,
        name: connectionDatabases.name,
        tableAccess: connectionDatabases.tableAccess,
        tenantScope: connectionDatabases.tenantScope,
      })
      .from(connectionDatabases)
      .where(eq(connectionDatabases.connectionId, id));
    return { mcpToken: parent[0]!.mcpToken, siblings };
  });

  if (!result) return null;

  const databases: DatabaseEntry[] = result.siblings.map((s) => ({
    name: s.name,
    connectionDatabaseId: s.id,
    tableAccess: s.tableAccess,
    tenantScope: s.tenantScope,
  }));

  try {
    const pushResult = await deps.pushPolicy(result.mcpToken, databases);
    if ("rejected" in pushResult) {
      // Engine kept the previous policy. Don't fall back — respawn
      // would re-read this same (rejected) policy from PG and fail to
      // boot. Surface the engine's message to the caller. We also skip
      // the POLICY_CHANGED audit row: the connections-row update is
      // committed (validator drift is unreachable in practice; if it
      // happens, engine state stays put and the dashboard surfaces the
      // error), but recording "policy changed" would be a lie.
      console.error(
        "[setTableAccess] engine rejected policy (validator drift)",
        pushResult.rejected,
      );
      throw new EnginePolicyRejected(pushResult.rejected.body);
    }
    // delivered=true → engine swapped in place; delivered=false → no
    // active container, next spawn reads from PG. Either way we're done.
  } catch (err) {
    if (err instanceof EnginePolicyRejected) throw err;
    // 5xx / 401 / network — fall back to invalidate so the next agent
    // request respawns with the new policy from PG. Same fail-soft
    // posture as rotateConnection.
    console.error(
      "[setTableAccess] hot reload failed; falling back to respawn",
      err,
    );
    await deps.registry.invalidate(result.mcpToken).catch(() => undefined);
  }

  // Cloud-emitted audit row, distinct from the engine's POLICY_RELOADED:
  // this one carries actor_clerk_user_id, so the audit log answers "who
  // changed the policy?" without needing the OSS engine to thread an
  // actor through /admin/policy. tenant_id = connection_id so a future
  // per-connection audit view can filter on it for free. Best-effort:
  // failure to write audit shouldn't undo the durable policy change
  // (which is already committed in PG and pushed to engine).
  try {
    await db.insert(auditEventsIndex).values({
      id: ulid(),
      customerId: customer.id,
      tenantId: id,
      region: customer.region,
      queryId: ulid(),
      ts: new Date(),
      eventType: "POLICY_CHANGED",
      payload: {
        connection_id: id,
        database_name: dbName,
        policy: validation.value,
      },
      actorClerkUserId,
    });
  } catch (err) {
    console.error("[setTableAccess] POLICY_CHANGED audit write failed", err);
  }

  return result;
}

// Replace the tenant_scope config on one DB of a connection. Same shape
// as setTableAccess: validate cloud-side, FOR UPDATE on the parent, write
// the named child, snapshot every sibling for the full multi-DB body,
// push to OSS hot-reload.
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
// `dbName` defaults to "main" so existing single-DB callers keep working;
// multi-DB callers pass the agent-facing alias explicitly.
//
// Returns null when the id is unknown OR owned by another customer OR the
// named child does not exist (matches setTableAccess / rotateConnection
// leakage-avoidance shape — caller can't distinguish).
export async function setTenantScope(
  customer: Customer,
  id: string,
  config: TenantScopeConfig,
  deps: PolicyPushDeps,
  actorClerkUserId: string,
  dbName: string = DEFAULT_DATABASE_NAME,
): Promise<{ mcpToken: string } | null> {
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

  const db = getDb();
  // Same three-step txn as setTableAccess: ownership check on the parent
  // (so we don't leak existence by writing through to a foreign customer's
  // DB), update the named child's tenantScope, then snapshot every DB on
  // the connection (post-update) for the hot-reload body. RETURNING on
  // the child write distinguishes "child not found" from "wrote but no
  // config change" and keeps the leakage-avoidance shape (null for both).
  //
  // FOR UPDATE on the parent serializes concurrent edits on this same
  // connection (whether the concurrent edit is another setTenantScope, a
  // setTableAccess, or any add/remove/rename). Without it, two parallel
  // edits each read their own snapshot of siblings and the engine ends
  // up with the loser's stale view of the winner's DB.
  const result = await db.transaction(async (tx) => {
    const parent = await tx
      .select({ mcpToken: connections.mcpToken })
      .from(connections)
      .where(
        and(eq(connections.id, id), eq(connections.customerId, customer.id)),
      )
      .for("update")
      .limit(1);
    if (parent.length === 0) return null;
    const updated = await tx
      .update(connectionDatabases)
      .set({ tenantScope: validation.value })
      .where(
        and(
          eq(connectionDatabases.connectionId, id),
          eq(connectionDatabases.name, dbName),
        ),
      )
      .returning({ id: connectionDatabases.id });
    if (updated.length === 0) return null;
    const siblings = await tx
      .select({
        id: connectionDatabases.id,
        name: connectionDatabases.name,
        tableAccess: connectionDatabases.tableAccess,
        tenantScope: connectionDatabases.tenantScope,
      })
      .from(connectionDatabases)
      .where(eq(connectionDatabases.connectionId, id));
    return { mcpToken: parent[0]!.mcpToken, siblings };
  });

  if (!result) return null;

  const databases: DatabaseEntry[] = result.siblings.map((s) => ({
    name: s.name,
    connectionDatabaseId: s.id,
    tableAccess: s.tableAccess,
    tenantScope: s.tenantScope ?? EMPTY_TENANT_SCOPE,
  }));

  try {
    const pushResult = await deps.pushPolicy(result.mcpToken, databases);
    if ("rejected" in pushResult) {
      // Engine kept the previous policy. Don't fall back — respawn would
      // re-read the same (rejected) config from PG and fail to boot.
      console.error(
        "[setTenantScope] engine rejected policy (validator drift)",
        pushResult.rejected,
      );
      throw new EnginePolicyRejected(pushResult.rejected.body);
    }
  } catch (err) {
    if (err instanceof EnginePolicyRejected) throw err;
    console.error(
      "[setTenantScope] hot reload failed; falling back to respawn",
      err,
    );
    await deps.registry.invalidate(result.mcpToken).catch(() => undefined);
  }

  // Cloud-emitted audit row, same shape as POLICY_CHANGED (see setTableAccess
  // for the rationale). TENANT_SCOPE_CHANGED records "who reconfigured tenant
  // isolation on which DB?" — directly relevant to row-level security audits.
  try {
    await db.insert(auditEventsIndex).values({
      id: ulid(),
      customerId: customer.id,
      tenantId: id,
      region: customer.region,
      queryId: ulid(),
      ts: new Date(),
      eventType: "TENANT_SCOPE_CHANGED",
      payload: {
        connection_id: id,
        database_name: dbName,
        config: validation.value,
      },
      actorClerkUserId,
    });
  } catch (err) {
    console.error("[setTenantScope] TENANT_SCOPE_CHANGED audit write failed", err);
  }

  return { mcpToken: result.mcpToken };
}

// Rotate one DB's DSN on a connection: re-encrypt with the customer's
// region key, atomically swap the ciphertext + kms_key_id + rotated_at
// on the named connection_databases row, then invalidate BOTH in-memory
// layers (DecryptCache holds the cached plaintext keyed on
// connection_database id; ContainerRegistry holds the running OSS
// container with the old DSN in env). Skipping either layer means the
// old DSN keeps serving traffic until the 30-min idle timer fires —
// that's the security incident.
//
// `dbName` defaults to "main" so existing single-DB callers keep
// working; multi-DB callers pass the agent-facing alias explicitly.
//
// Returns null when the id is unknown OR owned by another customer OR
// the named child does not exist (caller can't distinguish, mirroring
// deleteConnection's leakage-avoidance shape).
//
// mcp_token is intentionally NOT rotated — the URL is a contract with the
// agent runtime; rotating it would force re-paste and defeat the purpose
// of in-place credential rotation.
//
// Failure isolation: if cache.invalidate throws, the DB write is already
// committed (we don't roll back — "DSN rotated" is the durable fact);
// registry.invalidate still runs. Errors in either layer are logged but
// not propagated, since the cache will catch up at worst on next idle
// expiry. Callers see rotation as successful.
export async function rotateConnection(
  customer: Customer,
  id: string,
  dsn: string,
  caches: RotationCaches,
  dbName: string = DEFAULT_DATABASE_NAME,
): Promise<{ id: string; mcpToken: string; region: Region } | null> {
  const kms = makeKmsContext(process.env);
  const { ciphertext, kmsKeyId } = await encryptDsn(
    kms,
    dsn,
    customer.id,
    customer.region,
  );

  const db = getDb();
  const result = await db.transaction(async (tx) => {
    // Ownership-gated parent read first — confirms the connection belongs
    // to this customer and gives us the mcp_token + region for the cache
    // invalidation step. Returning null here is indistinguishable from
    // "id unknown", which is the leakage shape we want.
    const parent = await tx
      .select({
        id: connections.id,
        mcpToken: connections.mcpToken,
        region: connections.region,
      })
      .from(connections)
      .where(
        and(eq(connections.id, id), eq(connections.customerId, customer.id)),
      )
      .limit(1);
    if (parent.length === 0) return null;

    const updated = await tx
      .update(connectionDatabases)
      .set({
        encryptedDsn: ciphertext,
        kmsKeyId,
        rotatedAt: new Date(),
      })
      .where(
        and(
          eq(connectionDatabases.connectionId, id),
          eq(connectionDatabases.name, dbName),
        ),
      )
      .returning({ id: connectionDatabases.id });
    if (updated.length === 0) return null;
    return {
      id: parent[0]!.id,
      mcpToken: parent[0]!.mcpToken,
      region: parent[0]!.region,
      connectionDatabaseId: updated[0]!.id,
    };
  });

  if (!result) return null;

  try {
    caches.cache.invalidate(result.connectionDatabaseId, result.region);
  } catch (err) {
    console.error("[rotateConnection] cache.invalidate failed", err);
  }
  try {
    await caches.registry.invalidate(result.mcpToken);
  } catch (err) {
    console.error("[rotateConnection] registry.invalidate failed", err);
  }

  return {
    id: result.id,
    mcpToken: result.mcpToken,
    region: result.region,
  };
}

/** Read a connection plus one named child for the per-DB detail page.
 *  Returns null when the connection is unknown OR owned by another
 *  customer OR the named child does not exist (caller can't
 *  distinguish — same leakage shape as the rotate / delete paths). */
export async function getConnectionWithDatabase(
  customer: Customer,
  id: string,
  name: string,
): Promise<
  | {
      connection: typeof connections.$inferSelect;
      database: typeof connectionDatabases.$inferSelect;
    }
  | null
> {
  const db = getDb();
  const connRows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), eq(connections.customerId, customer.id)))
    .limit(1);
  const conn = connRows[0];
  if (!conn) return null;
  const dbRows = await db
    .select()
    .from(connectionDatabases)
    .where(
      and(
        eq(connectionDatabases.connectionId, conn.id),
        eq(connectionDatabases.name, name),
      ),
    )
    .limit(1);
  const database = dbRows[0];
  if (!database) return null;
  return { connection: conn, database };
}

/** List every DB on a connection, ordered by name. Used by the per-DB
 *  detail page (sibling tab strip is intentionally absent — PR-B locked
 *  the hierarchy as the navigation — but the dashboard renders the same
 *  list inline under each connection header). Returns null when the
 *  connection is unknown OR owned by another customer. */
export async function listDatabasesForConnection(
  customer: Customer,
  id: string,
): Promise<
  | {
      connection: typeof connections.$inferSelect;
      databases: Array<typeof connectionDatabases.$inferSelect>;
    }
  | null
> {
  const db = getDb();
  const connRows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, id), eq(connections.customerId, customer.id)))
    .limit(1);
  const conn = connRows[0];
  if (!conn) return null;
  const databases = await db
    .select()
    .from(connectionDatabases)
    .where(eq(connectionDatabases.connectionId, conn.id))
    .orderBy(asc(connectionDatabases.name));
  return { connection: conn, databases };
}

/** Back-compat shim for callers that still expect the {connection,
 *  mainDatabase} shape. New code should call getConnectionWithDatabase
 *  directly with the name from the URL. */
export async function getConnectionWithMainDatabase(
  customer: Customer,
  id: string,
): Promise<
  | {
      connection: typeof connections.$inferSelect;
      mainDatabase: typeof connectionDatabases.$inferSelect;
    }
  | null
> {
  const result = await getConnectionWithDatabase(
    customer,
    id,
    DEFAULT_DATABASE_NAME,
  );
  if (!result) return null;
  return { connection: result.connection, mainDatabase: result.database };
}

// Dependency shape for the add / remove / rename helpers — narrower
// than RotationCaches because none of them rotate a credential, so
// DecryptCache invalidation is moot. The running container needs to
// respawn so the OSS engine picks up the new YAML `databases:` block.
export interface DatabaseMutationDeps {
  registry: { invalidate(token: string): Promise<void> };
}

/** Returned when a sibling DB already owns the requested name. */
export class DatabaseNameTaken extends Error {
  constructor(public readonly takenName: string) {
    super(`database "${takenName}" already exists on this connection`);
    this.name = "DatabaseNameTaken";
  }
}

/** Returned when removeDatabase would leave a connection child-less.
 *  The OSS engine spawn requires `databases:` to be non-empty, so we
 *  block the last delete cloud-side rather than letting the container
 *  fail to start on next agent call. */
export class LastDatabaseProtected extends Error {
  constructor() {
    super("a connection must have at least one database");
    this.name = "LastDatabaseProtected";
  }
}

// Postgres error code for unique_violation, plus the constraint name on
// the (connection_id, name) index in connection_databases. Used as a
// belt-and-suspenders catch around add/rename — the FOR UPDATE lock on
// the parent connection row should make this unreachable, but if any
// future caller bypasses the helper (or the lock posture changes), the
// outer catch still translates the raw driver error into the typed
// DatabaseNameTaken the dashboard action knows how to render.
const PG_UNIQUE_VIOLATION = "23505";
const NAME_UQ_CONSTRAINT = "connection_databases_connection_name_uq";

function isUniqueDbNameViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint_name?: unknown };
  return (
    e.code === PG_UNIQUE_VIOLATION && e.constraint_name === NAME_UQ_CONSTRAINT
  );
}

// Add a new DB to an existing connection. Encrypts the DSN with the
// customer's region key, inserts the child row, and invalidates the
// running container so the next spawn includes the new entry in the
// YAML `databases:` block. Returns the new child id + parent mcpToken.
//
// Throws DatabaseNameTaken if the name collides with an existing
// sibling. Returns null when the connection is unknown OR owned by
// another customer (same leakage shape as createConnection). The
// dbName regex is enforced here even though the schema CHECK would
// also catch it, so the caller gets a clean error before KMS spend.
export async function addDatabase(
  customer: Customer,
  connectionId: string,
  dbName: string,
  dsn: string,
  defaultAccess: AccessLevel,
  deps: DatabaseMutationDeps,
): Promise<{ id: string; mcpToken: string } | null> {
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
  const db = getDb();
  let result;
  try {
    result = await db.transaction(async (tx) => {
      // Ownership-gated parent read first AND lock — gives us the
      // mcp_token for the registry invalidation, ensures we never
      // write through to a foreign customer's connection, and
      // serializes concurrent add/remove/rename on this same
      // connection. Without the lock, two parallel adds for the same
      // alias can each pass the collision pre-check below and the
      // loser would hit the unique constraint at insert time, which
      // would escape as a raw Postgres error instead of
      // DatabaseNameTaken.
      const parent = await tx
        .select({ mcpToken: connections.mcpToken })
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

      // Pre-check sibling collision (cheap; the lock guarantees the
      // result holds until commit). The unique constraint
      // connection_databases_connection_name_uq is still the durable
      // enforcer if anything bypasses this helper.
      const collide = await tx
        .select({ id: connectionDatabases.id })
        .from(connectionDatabases)
        .where(
          and(
            eq(connectionDatabases.connectionId, connectionId),
            eq(connectionDatabases.name, dbName),
          ),
        )
        .limit(1);
      if (collide.length > 0) {
        return { error: "name_taken" as const };
      }

      await tx.insert(connectionDatabases).values({
        id: childId,
        connectionId,
        name: dbName,
        encryptedDsn: ciphertext,
        kmsKeyId,
        tableAccess,
      });
      return { mcpToken: parent[0]!.mcpToken };
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
    await deps.registry.invalidate(result.mcpToken);
  } catch (err) {
    console.error("[addDatabase] registry.invalidate failed", err);
  }

  return { id: childId, mcpToken: result.mcpToken };
}

// Remove a named DB from a connection. The connection itself is
// preserved — only the child row goes away (FK cascade deletes any
// per-DB state we add later). Audit history stays in
// audit_events_index keyed on the (customer, region, database) tuple,
// which is the compliance posture we want.
//
// Throws LastDatabaseProtected if the named child is the only DB on
// the connection (the OSS spawn requires `databases:` non-empty).
// Returns null when the connection is unknown / foreign or the child
// doesn't exist on it.
export async function removeDatabase(
  customer: Customer,
  connectionId: string,
  dbName: string,
  deps: DatabaseMutationDeps,
): Promise<{ mcpToken: string } | null> {
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    // Lock the parent connection row at the top of the txn so any
    // concurrent add/remove/rename on the same connection serializes
    // through here. Without this, two parallel removeDatabase calls
    // on a 2-DB connection can each see siblings.length === 2 in
    // their own snapshot, each delete one row, and leave the
    // connection child-less — violating LastDatabaseProtected and
    // breaking the next engine spawn.
    const parent = await tx
      .select({ mcpToken: connections.mcpToken })
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

    // Count siblings BEFORE the delete so we can block the last-DB
    // case. The parent lock above guarantees no other txn can change
    // this count until we commit. N is small (single digits in
    // practice); reading rows and checking length is cheaper to
    // reason about than a raw count() expression.
    const siblings = await tx
      .select({ id: connectionDatabases.id })
      .from(connectionDatabases)
      .where(eq(connectionDatabases.connectionId, connectionId));
    if (siblings.length <= 1) {
      return { error: "last_database" as const };
    }

    const deleted = await tx
      .delete(connectionDatabases)
      .where(
        and(
          eq(connectionDatabases.connectionId, connectionId),
          eq(connectionDatabases.name, dbName),
        ),
      )
      .returning({ id: connectionDatabases.id });
    if (deleted.length === 0) return null;
    return { mcpToken: parent[0]!.mcpToken };
  });

  if (!result) return null;
  if ("error" in result) throw new LastDatabaseProtected();

  try {
    await deps.registry.invalidate(result.mcpToken);
  } catch (err) {
    console.error("[removeDatabase] registry.invalidate failed", err);
  }

  return { mcpToken: result.mcpToken };
}

// Rename a DB alias. The OSS engine treats `database` as the agent-facing
// identifier on every tool call, so renaming forces a container restart
// (engine rejects database-alias hot-swap by spec). DecryptCache is
// keyed on the connection_database row id, not the name, so no cache
// invalidation is needed.
//
// Throws DatabaseNameTaken on sibling collision. Returns null when the
// connection is unknown / foreign or the source name doesn't exist.
export async function renameDatabase(
  customer: Customer,
  connectionId: string,
  oldName: string,
  newName: string,
  deps: DatabaseMutationDeps,
): Promise<{ mcpToken: string } | null> {
  if (!isValidDatabaseName(newName)) {
    throw new Error(
      `invalid database name: must match ${DB_NAME_RE} (lowercase alnum + _- , 1–32 chars, leading letter)`,
    );
  }
  if (oldName === newName) {
    // No-op rename — short-circuit so callers don't have to special-case
    // it before submitting. We still verify ownership to avoid telling
    // an attacker that a connection exists by returning null vs. a no-op.
    const db = getDb();
    const parent = await db
      .select({ mcpToken: connections.mcpToken })
      .from(connections)
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.customerId, customer.id),
        ),
      )
      .limit(1);
    if (parent.length === 0) return null;
    return { mcpToken: parent[0]!.mcpToken };
  }

  const db = getDb();
  let result;
  try {
    result = await db.transaction(async (tx) => {
      // Same FOR UPDATE posture as add/remove — serialize concurrent
      // mutations on this connection. Without the lock, another
      // request could insert or rename a sibling to newName between
      // our pre-check and our update; the update would then trip the
      // unique constraint and bubble up as a raw 500 instead of the
      // typed DatabaseNameTaken the dashboard knows how to handle.
      const parent = await tx
        .select({ mcpToken: connections.mcpToken })
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

      // Sibling-collision pre-check. With the parent lock held, the
      // result holds until commit; the unique constraint is still
      // there as the durable enforcer.
      const collide = await tx
        .select({ id: connectionDatabases.id })
        .from(connectionDatabases)
        .where(
          and(
            eq(connectionDatabases.connectionId, connectionId),
            eq(connectionDatabases.name, newName),
          ),
        )
        .limit(1);
      if (collide.length > 0) {
        return { error: "name_taken" as const };
      }

      const updated = await tx
        .update(connectionDatabases)
        .set({ name: newName })
        .where(
          and(
            eq(connectionDatabases.connectionId, connectionId),
            eq(connectionDatabases.name, oldName),
          ),
        )
        .returning({ id: connectionDatabases.id });
      if (updated.length === 0) return null;
      return { mcpToken: parent[0]!.mcpToken };
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
    await deps.registry.invalidate(result.mcpToken);
  } catch (err) {
    console.error("[renameDatabase] registry.invalidate failed", err);
  }

  return { mcpToken: result.mcpToken };
}

/** Server-side fetch for the hierarchical dashboard. Returns one row per
 *  connection paired with EVERY child DB on it (each annotated with its
 *  own lastQueryAt from audit_events_index), plus the indexer cursor
 *  that drives the connection-level freshness dot. */
export type DashboardDatabase = typeof connectionDatabases.$inferSelect & {
  /** Most recent ts on `audit_events_index` for this DB name within the
   *  customer's region. NULL when the agent has never queried this DB —
   *  the dashboard renders this as "awaiting first query".
   *
   *  KNOWN LIMITATION: audit_events_index has no `mcp_token` /
   *  `connection_id` column today, so the max-ts aggregate fan-ins
   *  across same-named DBs in different connections of the same
   *  customer-region. If a customer has two connections each with a
   *  "main" DB, both rows show the same lastQueryAt. PR-C accepts this
   *  for v1; a future schema migration adds the disambiguator. */
  lastQueryAt: Date | null;
};

export interface DashboardConnectionRow {
  connection: typeof connections.$inferSelect;
  databases: DashboardDatabase[];
  cursor: {
    lastIndexedAt: Date | null;
    lastErrorAt: Date | null;
  };
}

// Internal helper: compute MAX(ts) per database name within (customer,
// region). The compound index audit_customer_region_database_ts_idx
// makes this a single index scan with no per-database round trips.
async function lastQueryByDatabase(
  customer: Customer,
): Promise<Map<string, Date>> {
  const db = getDb();
  const rows = await db
    .select({
      database: auditEventsIndex.database,
      lastQueryAt: sql<Date | string>`MAX(${auditEventsIndex.ts})`,
    })
    .from(auditEventsIndex)
    .where(
      and(
        eq(auditEventsIndex.customerId, customer.id),
        eq(auditEventsIndex.region, customer.region),
      ),
    )
    .groupBy(auditEventsIndex.database);

  // Some drivers return the aggregate as a string (Postgres TIMESTAMPTZ
  // text representation) instead of a Date; coerce defensively so
  // downstream consumers always see a real Date.
  const map = new Map<string, Date>();
  for (const row of rows) {
    if (!row.lastQueryAt) continue;
    const d =
      row.lastQueryAt instanceof Date
        ? row.lastQueryAt
        : new Date(row.lastQueryAt);
    map.set(row.database, d);
  }
  return map;
}

export async function listDashboardConnections(
  customer: Customer,
): Promise<DashboardConnectionRow[]> {
  const db = getDb();
  // Three-query fetch — parents (with joined cursor), children
  // (IN-list), and per-DB last-query (one GROUP BY per customer). A
  // single inner-join across all three would multiply rows; this keeps
  // each result shape stable.
  const [parents, lastQueryMap] = await Promise.all([
    db
      .select({
        connection: connections,
        lastIndexedAt: indexerCursors.lastIndexedAt,
        lastErrorAt: indexerCursors.lastErrorAt,
      })
      .from(connections)
      .leftJoin(
        indexerCursors,
        eq(indexerCursors.mcpToken, connections.mcpToken),
      )
      .where(eq(connections.customerId, customer.id))
      .orderBy(desc(connections.createdAt)),
    lastQueryByDatabase(customer),
  ]);
  if (parents.length === 0) return [];

  const parentIds = parents.map((p) => p.connection.id);
  const children = await db
    .select()
    .from(connectionDatabases)
    .where(inArray(connectionDatabases.connectionId, parentIds))
    .orderBy(asc(connectionDatabases.name));

  const childrenByConn = new Map<string, DashboardDatabase[]>();
  for (const child of children) {
    const list = childrenByConn.get(child.connectionId) ?? [];
    list.push({
      ...child,
      lastQueryAt: lastQueryMap.get(child.name) ?? null,
    });
    childrenByConn.set(child.connectionId, list);
  }

  return parents.map((p) => ({
    connection: p.connection,
    databases: childrenByConn.get(p.connection.id) ?? [],
    cursor: {
      lastIndexedAt: p.lastIndexedAt,
      lastErrorAt: p.lastErrorAt,
    },
  }));
}

/** Slim payload for the 60s polling endpoint. Identifiers + freshness
 *  signals only — no policy / table_access / ciphertext. The client
 *  hook merges this into local state and updates only the freshness
 *  dots and meta lines; rename / menu / sheet state stay put. */
export interface DashboardFreshnessSnapshot {
  connections: Array<{
    id: string;
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
): Promise<DashboardFreshnessSnapshot> {
  const db = getDb();
  const [parents, lastQueryMap] = await Promise.all([
    db
      .select({
        id: connections.id,
        mcpToken: connections.mcpToken,
        lastIndexedAt: indexerCursors.lastIndexedAt,
        lastErrorAt: indexerCursors.lastErrorAt,
      })
      .from(connections)
      .leftJoin(
        indexerCursors,
        eq(indexerCursors.mcpToken, connections.mcpToken),
      )
      .where(eq(connections.customerId, customer.id))
      .orderBy(desc(connections.createdAt)),
    lastQueryByDatabase(customer),
  ]);
  if (parents.length === 0) return { connections: [] };

  const parentIds = parents.map((p) => p.id);
  const children = await db
    .select({
      connectionId: connectionDatabases.connectionId,
      name: connectionDatabases.name,
    })
    .from(connectionDatabases)
    .where(inArray(connectionDatabases.connectionId, parentIds))
    .orderBy(asc(connectionDatabases.name));

  const childrenByConn = new Map<
    string,
    Array<{ name: string; lastQueryAt: Date | null }>
  >();
  for (const child of children) {
    const list = childrenByConn.get(child.connectionId) ?? [];
    list.push({
      name: child.name,
      lastQueryAt: lastQueryMap.get(child.name) ?? null,
    });
    childrenByConn.set(child.connectionId, list);
  }

  return {
    connections: parents.map((p) => ({
      id: p.id,
      cursor: {
        lastIndexedAt: p.lastIndexedAt,
        lastErrorAt: p.lastErrorAt,
      },
      databases: childrenByConn.get(p.id) ?? [],
    })),
  };
}
