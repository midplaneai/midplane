import "server-only";

import { notFound } from "next/navigation";

import { ACCESS_LEVELS, type AccessLevel } from "@midplane-cloud/db/policy";

import {
  addDatabase,
  DatabaseNameTaken,
  isValidDatabaseName,
  isValidDsn,
} from "@/lib/connections";
import type { Customer } from "@midplane-cloud/db";
import { getMcpProxyContext } from "@/lib/mcp-proxy";

// Shared body of the add-database server actions. Two surfaces post the
// same AddDatabaseForm: the dashboard list and the connection home —
// each defines its own thin "use server" action (actions must live in
// server files) that delegates here and then revalidates its own paths.
//
// Error contract: throws Error with a user-renderable message — the
// client form wraps the action in try/catch and renders inline (see
// add-database-form.tsx). Tamper-shaped failures (missing connectionId)
// also throw; they're not reachable through the real form.
//
// Callers' revalidation duty: besides their own surface, membership
// changes alter EVERY per-DB page of the connection (the sibling strip
// in databases/[name]/layout.tsx renders the db list) — revalidate the
// bracketed page path too.

export async function addDatabaseFromForm(
  customer: Customer,
  formData: FormData,
): Promise<{ connectionId: string; name: string }> {
  const connectionId = formData.get("connectionId");
  if (typeof connectionId !== "string" || connectionId.length === 0) {
    throw new Error("missing connectionId");
  }
  const nameRaw = formData.get("name");
  if (typeof nameRaw !== "string" || !isValidDatabaseName(nameRaw.trim())) {
    throw new Error(
      "Name must be 1–32 lowercase letters / digits / _ - , starting with a letter.",
    );
  }
  const dbName = nameRaw.trim();
  const dsn = formData.get("dsn");
  if (!isValidDsn(dsn)) {
    throw new Error("DSN must be a postgres:// or postgresql:// URL");
  }
  // The form posts a string; validate against the canonical enum so a
  // tampered request can't smuggle in something the spawner would
  // refuse. Missing field falls back to "read" — same posture as
  // createConnection.
  const accessRaw = formData.get("default_access");
  const defaultAccess: AccessLevel =
    typeof accessRaw === "string" &&
    (ACCESS_LEVELS as readonly string[]).includes(accessRaw)
      ? (accessRaw as AccessLevel)
      : "read";

  const ctx = getMcpProxyContext();
  try {
    const result = await addDatabase(
      customer,
      connectionId,
      dbName,
      dsn,
      defaultAccess,
      ctx,
    );
    if (!result) notFound();
  } catch (err) {
    if (err instanceof DatabaseNameTaken) {
      throw new Error(`A database named "${err.takenName}" already exists.`);
    }
    throw err;
  }
  return { connectionId, name: dbName };
}
