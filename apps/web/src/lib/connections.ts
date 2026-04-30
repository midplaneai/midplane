import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";

import {
  connections,
  getDb,
  indexerCursors,
  validatePolicy,
  type AccessLevel,
  type Customer,
  type TableAccessPolicy,
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

// Shared create-connection path used by both the Server Action behind the
// paste-DSN form and the JSON POST /api/connections route. Encrypts the DSN
// with the customer's region key, persists the ciphertext, mints an opaque
// MCP token. Returns the new row's id and token; the caller decides whether
// to render a success page or return JSON.
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

  const db = getDb();
  await db.insert(connections).values({
    id,
    customerId: customer.id,
    region: customer.region,
    name: normalizeName(name),
    encryptedDsn: ciphertext,
    kmsKeyId,
    mcpToken,
    tableAccess,
  });

  return { id, mcpToken };
}

export function isValidDsn(s: unknown): s is string {
  return typeof s === "string" && /^postgres(ql)?:\/\//i.test(s) && s.length >= 8;
}

// Update the user-supplied name. Cosmetic — no caches to invalidate, no
// container to restart, no token rotation. Returns null when the id is
// unknown OR owned by another customer (matches deleteConnection's
// leakage-avoidance shape).
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
// Returns the deleted row's mcpToken so the caller can stop the running
// container — without that step the OSS sidecar lingers (still holding
// the now-deleted DSN in env) until its 30-minute idle timer fires.
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
  cache: { invalidate(connectionId: string, region: Region): void };
  registry: { invalidate(token: string): Promise<void> };
}

// Dependencies setTableAccess needs to push the new policy to the
// running engine (preferred path) or, if that fails non-recoverably,
// fall back to stop-and-respawn.
export interface PolicyPushDeps {
  registry: { invalidate(token: string): Promise<void> };
  pushPolicy(
    token: string,
    policy: TableAccessPolicy,
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

// Replace the table_access policy on a connection. Preferred path is
// hot-reload via POST /admin/policy on the running engine — the agent's
// MCP session stays alive. If no container is running OR the engine
// doesn't expose the endpoint, the Postgres write alone is enough; the
// next spawn reads the new policy from PG. On a 5xx/401/network failure
// we fall back to stop-and-respawn (matches rotateConnection's
// fail-soft posture: durable fact is committed, in-memory layer catches
// up). On 400 we do NOT fall back — engine kept the old policy, so the
// running session is fine; respawn would re-read the now-rejected
// policy from PG and fail the spawn. Caller surfaces the engine's
// validator message to the user.
//
// Returns null when the id is unknown OR owned by another customer
// (mirrors the leakage-avoidance shape of rotateConnection / delete).
//
// Validation runs here AND at the spawner boundary; the dashboard form
// also validates before submitting, so a malformed policy reaches this
// function only via a hostile / buggy non-browser caller.
export async function setTableAccess(
  customer: Customer,
  id: string,
  policy: TableAccessPolicy,
  deps: PolicyPushDeps,
): Promise<{ mcpToken: string } | null> {
  const validation = validatePolicy(policy);
  if (!validation.ok) {
    const summary = validation.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new Error(`invalid policy: ${summary}`);
  }

  const db = getDb();
  const updated = await db
    .update(connections)
    .set({ tableAccess: validation.value })
    .where(and(eq(connections.id, id), eq(connections.customerId, customer.id)))
    .returning({ mcpToken: connections.mcpToken });

  const row = updated[0];
  if (!row) return null;

  try {
    const result = await deps.pushPolicy(row.mcpToken, validation.value);
    if ("rejected" in result) {
      // Engine kept the previous policy. Don't fall back — respawn
      // would re-read this same (rejected) policy from PG and fail to
      // boot. Surface the engine's message to the caller.
      console.error(
        "[setTableAccess] engine rejected policy (validator drift)",
        result.rejected,
      );
      throw new EnginePolicyRejected(result.rejected.body);
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
    await deps.registry.invalidate(row.mcpToken).catch(() => undefined);
  }

  return row;
}

// Rotate a connection's DSN: re-encrypt with the customer's region key,
// atomically swap the ciphertext + kms_key_id + rotated_at in Postgres,
// then invalidate BOTH in-memory layers (DecryptCache holds the cached
// plaintext, ContainerRegistry holds the running OSS container with the
// old DSN in env). Skipping either layer means the old DSN keeps serving
// traffic until the 30-min idle timer fires — that's the security incident.
//
// Returns null when the id is unknown OR owned by another customer (caller
// can't distinguish, mirroring deleteConnection's leakage-avoidance shape).
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
): Promise<{ id: string; mcpToken: string; region: Region } | null> {
  const kms = makeKmsContext(process.env);
  const { ciphertext, kmsKeyId } = await encryptDsn(
    kms,
    dsn,
    customer.id,
    customer.region,
  );

  const db = getDb();
  const updated = await db
    .update(connections)
    .set({
      encryptedDsn: ciphertext,
      kmsKeyId,
      rotatedAt: new Date(),
    })
    .where(
      and(eq(connections.id, id), eq(connections.customerId, customer.id)),
    )
    .returning({
      id: connections.id,
      mcpToken: connections.mcpToken,
      region: connections.region,
    });

  const row = updated[0];
  if (!row) return null;

  try {
    caches.cache.invalidate(row.id, row.region);
  } catch (err) {
    console.error("[rotateConnection] cache.invalidate failed", err);
  }
  try {
    await caches.registry.invalidate(row.mcpToken);
  } catch (err) {
    console.error("[rotateConnection] registry.invalidate failed", err);
  }

  return row;
}
