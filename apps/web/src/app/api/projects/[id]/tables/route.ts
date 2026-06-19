// GET /api/projects/:id/tables?q=<substring>&db=<name> — table-name
// suggestions for the permission-grid autocomplete on the per-DB page,
// and the table source for the policy test panel's probe matrix.
//
// Auth: session via currentCustomer; ownership-checked against
// projects.customer_id. Same 404-on-foreign-row leakage shape as the
// other project routes — never confirm or deny existence.
//
// Side effects: opens one short-lived Postgres project to the
// customer's own database (DSN resolved through DsnResolver, so KMS gets
// a cache hit on the second call). Read-only — only information_schema
// is touched.
//
// Cache: private max-age=10 keyed on the full URL (including ?q). The
// dashboard hits this once per debounced keystroke; the cache makes
// re-focusing an input without typing a no-op.
//
// Failure mode: this route is a UX nicety. If KMS is unhappy, the DSN is
// unreachable, or the introspection times out, return a 200 with
// `{ tables: [], error: "..." }` so the dashboard can show an inline
// "couldn't reach DB — type names manually" hint and still let the user
// save a policy. Hard 4xx is reserved for auth / not-found.

import { currentCustomer } from "@/lib/customer";
import { requireManagerRest } from "@/lib/org-auth";
import {
  DEFAULT_DATABASE_NAME,
  getProjectWithDatabaseAndCredential,
  isValidDatabaseName,
} from "@/lib/projects";
import { listTables } from "@/lib/list-tables";
import { getMcpProxyContext } from "@/lib/mcp-proxy";

const MAX_QUERY_LENGTH = 64;
// Default stays at the autocomplete page size; the test panel asks for
// more (?limit=) so its truncation facts are honest on wide schemas —
// without this, a 200-table db introspects exactly 50 names and the
// panel claims full coverage (codex review P2).
const MAX_LIMIT = 250;

interface OkBody {
  tables: string[];
}

interface SoftErrorBody {
  tables: [];
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
  // Owner/admin only — table-name suggestions and the test-panel matrix are
  // manager surfaces in the UI; this handler decrypts the DB credential and
  // introspects the schema, so a member must not reach it directly. Gate
  // BEFORE any credential resolution. (Sibling of the scan route's gate.)
  const gate = await requireManagerRest();
  if (gate instanceof Response) return gate;
  const { id } = await params;

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, MAX_QUERY_LENGTH);
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit =
    Number.isInteger(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, MAX_LIMIT)
      : undefined; // listTables default (autocomplete page size)

  // Per-db since the projects-ux PR (was main-db-only under PR-A's
  // single-DB scope). `db` defaults to "main" so pre-existing callers
  // keep working; an invalid or unknown name 404s with the same
  // leakage shape as a foreign project id.
  const dbParam = url.searchParams.get("db") ?? DEFAULT_DATABASE_NAME;
  if (!isValidDatabaseName(dbParam)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  // Uses the credential-bearing variant because the DSN ciphertext is
  // required input to DsnResolver.resolve below.
  const result = await getProjectWithDatabaseAndCredential(
    customer,
    id,
    dbParam,
  );
  if (!result) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const { project: conn, database } = result;

  const ctx = getMcpProxyContext();
  const decrypt = await ctx.resolver.resolve({
    projectDatabase: database,
    region: conn.region,
    customerId: conn.customerId,
  });
  if (!decrypt.ok) {
    const body: SoftErrorBody = {
      tables: [],
      error: "credential_unavailable",
    };
    return Response.json(body, { status: 200 });
  }

  try {
    const result = await listTables(decrypt.plaintext, { q, limit });
    const body: OkBody = { tables: result.tables };
    return Response.json(body, {
      status: 200,
      // Safe to share across the customer's tabs but not across customers;
      // the URL is per-project-id + per-q so private cache is correct.
      headers: { "cache-control": "private, max-age=10" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[GET /api/projects/[id]/tables] introspection failed", err);
    const body: SoftErrorBody = {
      tables: [],
      error: "introspection_failed",
      message,
    };
    return Response.json(body, { status: 200 });
  }
}
