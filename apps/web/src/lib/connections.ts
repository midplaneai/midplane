import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";

import { connections, getDb, type Customer } from "@midplane-cloud/db";
import { encryptDsn, makeKmsContext } from "@midplane-cloud/kms";

// Shared create-connection path used by both the Server Action behind the
// paste-DSN form and the JSON POST /api/connections route. Encrypts the DSN
// with the customer's region key, persists the ciphertext, mints an opaque
// MCP token. Returns the new row's id and token; the caller decides whether
// to render a success page or return JSON.
export async function createConnection(
  customer: Customer,
  dsn: string,
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

  const db = getDb();
  await db.insert(connections).values({
    id,
    customerId: customer.id,
    region: customer.region,
    encryptedDsn: ciphertext,
    kmsKeyId,
    mcpToken,
  });

  return { id, mcpToken };
}

export function isValidDsn(s: unknown): s is string {
  return typeof s === "string" && /^postgres(ql)?:\/\//i.test(s) && s.length >= 8;
}

// Delete a connection only if it belongs to the calling customer. Returns
// the number of rows deleted (0 if the id is unknown OR owned by another
// customer — the caller can't distinguish, by design, to avoid leaking
// existence).
export async function deleteConnection(
  customer: Customer,
  id: string,
): Promise<number> {
  const db = getDb();
  const rows = await db
    .delete(connections)
    .where(
      and(eq(connections.id, id), eq(connections.customerId, customer.id)),
    )
    .returning({ id: connections.id });
  return rows.length;
}
