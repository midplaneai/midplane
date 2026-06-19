// GET /api/projects/:id/scan?db=<name> — PII exposure scan (design D1).
//
// Introspects information_schema for the database's columns and returns the
// ones that look like personal data (name + type heuristics — NO customer row
// values are ever read), plus the database's current column_masks so the page
// can render flagged-but-unmasked vs already-masked.
//
// Auth + failure posture mirror the sibling /tables route: session via
// currentCustomer, ownership-checked (404 with the standard leakage shape on a
// foreign/unknown row), and a soft 200 `{ columns: [], error }` when KMS or the
// introspection is unhappy — the scan is informational, not a gate.

import {
  parseColumnMasksOrThrow,
  type ColumnMasksConfig,
} from "@midplane-cloud/db";

import { currentCustomer } from "@/lib/customer";
import { requireManagerRest } from "@/lib/org-auth";
import {
  DEFAULT_DATABASE_NAME,
  getProjectWithDatabaseAndCredential,
  isValidDatabaseName,
} from "@/lib/projects";
import { getMcpProxyContext } from "@/lib/mcp-proxy";
import { scanPiiColumns, type ScannedColumn } from "@/lib/scan-pii-columns";

interface OkBody {
  columns: ScannedColumn[];
  scannedColumns: number;
  /** The DB's current masks, so the page marks already-masked columns. */
  columnMasks: ColumnMasksConfig;
}

interface SoftErrorBody {
  columns: [];
  scannedColumns: 0;
  columnMasks: ColumnMasksConfig;
  error: "credential_unavailable" | "introspection_failed";
  message?: string;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const customer = await currentCustomer();
  if (!customer) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }
  // Owner/admin only — the UI mounts the scan behind canManage, and this handler
  // decrypts the DB credential and returns schema + masking-policy details. A
  // signed-in member who is intentionally blocked from this surface must not be
  // able to reach it by calling the route directly. Gate BEFORE any credential
  // resolution or introspection.
  const gate = await requireManagerRest();
  if (gate instanceof Response) return gate;
  const { id } = await params;

  const url = new URL(req.url);
  const dbParam = url.searchParams.get("db") ?? DEFAULT_DATABASE_NAME;
  if (!isValidDatabaseName(dbParam)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const result = await getProjectWithDatabaseAndCredential(customer, id, dbParam);
  if (!result) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const { project: proj, database } = result;

  // The persisted policy is the source of truth for "already masked", validated
  // the same way the spawner reads it (so a malformed row can't crash the page).
  const columnMasks = parseColumnMasksOrThrow(database.columnMasks);

  const ctx = getMcpProxyContext();
  const decrypt = await ctx.resolver.resolve({
    projectDatabase: database,
    region: proj.region,
    customerId: proj.customerId,
  });
  if (!decrypt.ok) {
    const body: SoftErrorBody = {
      columns: [],
      scannedColumns: 0,
      columnMasks,
      error: "credential_unavailable",
    };
    return Response.json(body, { status: 200 });
  }

  try {
    const scan = await scanPiiColumns(decrypt.plaintext);
    const body: OkBody = {
      columns: scan.columns,
      scannedColumns: scan.scannedColumns,
      columnMasks,
    };
    return Response.json(body, {
      status: 200,
      headers: { "cache-control": "private, max-age=10" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[GET /api/projects/[id]/scan] introspection failed", err);
    const body: SoftErrorBody = {
      columns: [],
      scannedColumns: 0,
      columnMasks,
      error: "introspection_failed",
      message,
    };
    return Response.json(body, { status: 200 });
  }
}
