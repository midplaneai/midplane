// POST /api/projects/:id/databases/test  — pre-submit DSN reachability
// probe used by the add-database inline form on the dashboard.
//
// The customer pastes a candidate DSN; we verify ownership of the parent
// project (so this isn't a free anonymous reachability service), then
// open a single short-lived Postgres project from the cloud server
// against the pasted DSN and return {ok, error?}. Nothing is persisted.
//
// Why ownership-gate but not name-scope: the new DB doesn't exist yet,
// so there's no `name` to scope on; the parent id gives us
// region-correctness and a cheap auth gate without requiring the form
// to commit before testing.
//
// 404 on foreign-row, mirroring the rest of the projects API. Auth
// failures still return 401 — same shape as the sibling routes.

import { getOrgContext } from "@/lib/org-context";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { projects, getDb } from "@midplane-cloud/db";

import { isValidDsn } from "@/lib/projects";
import { currentCustomer } from "@/lib/customer";
import { pingDsnGuarded } from "@/lib/ping-guard";
import { getPostHog } from "@/lib/posthog";
import {
  checkRateLimit,
  PING_TEST_RATE_LIMIT,
  pingTestKey,
} from "@/lib/rate-limit";

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
  const { userId } = await getOrgContext();
  const { id } = await params;

  // Shared budget with the raw-DSN surface — one key per customer
  // across all ping endpoints (definitions live in lib/rate-limit.ts).
  const limited = checkRateLimit(pingTestKey(customer.id), PING_TEST_RATE_LIMIT);
  if (!limited.ok) {
    return Response.json(
      { error: "too many tests — try again shortly" },
      {
        status: 429,
        headers: { "retry-after": String(limited.retryAfterS) },
      },
    );
  }

  // Malformed bodies are a 400, never a 500 — same contract as the
  // raw-DSN sibling (both surfaces share TestDsnButton).
  let raw: unknown;
  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      raw = await req.json();
    } else {
      const form = await req.formData();
      raw = Object.fromEntries(form.entries());
    }
  } catch {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  const parsed = TestBody.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Ownership gate — same leakage shape as the rest of the projects API.
  const db = getDb(customer.region);
  const owned = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.customerId, customer.id)))
    .limit(1);
  if (owned.length === 0) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  // Guarded since the projects-ux PR: this route previously pinged
  // arbitrary pasted DSNs with only an ownership gate — an internal-
  // network reachability oracle for any signed-in customer.
  const result = await pingDsnGuarded(parsed.data.dsn);

  if (userId) {
    getPostHog()?.capture({
      distinctId: userId,
      event: "database_test_run",
      properties: {
        project_id: id,
        region: customer.region,
        success: result.ok,
      },
    });
  }

  return Response.json(result);
}
