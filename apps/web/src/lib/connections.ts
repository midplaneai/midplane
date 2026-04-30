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

// Replace the table_access policy on a connection. The DSN-side cache
// stays valid (DSN didn't change), but the running OSS container is
// holding the old policy file, so we invalidate the registry and let
// the next agent request respawn with the new YAML mounted in.
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
  caches: { registry: { invalidate(token: string): Promise<void> } },
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

  // Same fail-soft posture as rotateConnection: the durable fact (new
  // policy in Postgres) is committed; if invalidate throws, the next
  // idle expiry catches up. Worst case is one stale request window —
  // the same race rotation already accepts.
  try {
    await caches.registry.invalidate(row.mcpToken);
  } catch (err) {
    console.error("[setTableAccess] registry.invalidate failed", err);
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
