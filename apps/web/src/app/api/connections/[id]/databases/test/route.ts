// POST /api/connections/:id/databases/test  — pre-submit DSN reachability
// probe used by the add-database inline form on the dashboard.
//
// The customer pastes a candidate DSN; we verify ownership of the parent
// connection (so this isn't a free anonymous reachability service), then
// open a single short-lived Postgres connection from the cloud server
// against the pasted DSN and return {ok, error?}. Nothing is persisted.
//
// Why ownership-gate but not name-scope: the new DB doesn't exist yet,
// so there's no `name` to scope on; the parent id gives us
// region-correctness and a cheap auth gate without requiring the form
// to commit before testing.
//
// 404 on foreign-row, mirroring the rest of the connections API. Auth
// failures still return 401 — same shape as the sibling routes.

import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { connections, getDb } from "@midplane-cloud/db";

import { isValidDsn } from "@/lib/connections";
import { currentCustomer } from "@/lib/customer";
import { pingDsn } from "@/lib/ping-dsn";

const TestBody = z.object({
  dsn: z.string().refine(isValidDsn, {
    message: "must be a postgres:// or postgresql:// URL",
  }),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const customer = await currentCustomer();
  if (!customer) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }
  const { id } = await params;

  let raw: unknown;
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    raw = await req.json();
  } else {
    const form = await req.formData();
    raw = Object.fromEntries(form.entries());
  }
  const parsed = TestBody.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Ownership gate — same leakage shape as the rest of the connections API.
  const db = getDb();
  const owned = await db
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.id, id), eq(connections.customerId, customer.id)))
    .limit(1);
  if (owned.length === 0) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const result = await pingDsn(parsed.data.dsn);
  return Response.json(result);
}
