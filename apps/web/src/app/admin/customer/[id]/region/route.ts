// Staff escape hatch: change a customer's region.
//
// V1 same-region only — cross-region region change requires the V2 data
// move (dump from EU Neon, re-encrypt under US KMS, load to US Neon,
// delete). This endpoint refuses cross-region writes with a 400 + V2
// message; staff who need that flow have to wait for V2.
//
// Auth: env var allowlist MIDPLANE_STAFF_USER_IDS (comma-separated Clerk
// user IDs). Midplane staff are not customer org members, so org-role
// checks don't apply — user-level allowlist is correct. Fail-closed
// (env var unset or empty → no staff identity exists, every call 403s).
//
// Audit: emitConfigAuditRow with REGION_CHANGED event. Same RLS-safe
// pattern (SET LOCAL app.customer_id) as POLICY_CHANGED.
//
// Rate limit: 10 changes / hour / staff actor. In-process Map, bounded
// by actor count; sufficient for a single-machine regional control plane.
//
// Session refresh: best-effort revokeSession enumeration across the
// target org's members. Clerk has no atomic org-wide revoke; race window
// for in-flight sessions is acceptable for this rare audited action.

import { eq } from "drizzle-orm";
import { z } from "zod";

import { customers, getDb } from "@midplane-cloud/db";

import { getOrgContext } from "@/lib/org-context";
import { bootRegion } from "@/lib/region-context";

const Body = z.object({
  region: z.enum(["eu", "us"]),
});

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const recentChanges = new Map<string, number[]>();

function staffAllowlist(): Set<string> {
  const raw = process.env.MIDPLANE_STAFF_USER_IDS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

function checkRateLimit(actor: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const prior = (recentChanges.get(actor) ?? []).filter((t) => t > cutoff);
  if (prior.length >= RATE_LIMIT_MAX) {
    recentChanges.set(actor, prior);
    return false;
  }
  prior.push(now);
  recentChanges.set(actor, prior);
  return true;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { userId } = await getOrgContext();
  if (!userId) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  const allow = staffAllowlist();
  if (!allow.has(userId)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  if (!checkRateLimit(userId)) {
    return Response.json(
      { error: "rate limit exceeded (10/hour)" },
      { status: 429 },
    );
  }

  const { id } = await params;
  const raw = await req.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const newRegion = parsed.data.region;

  const appRegion = bootRegion();
  const db = getDb(appRegion);
  const rows = await db
    .select()
    .from(customers)
    .where(eq(customers.id, id))
    .limit(1);
  const customer = rows[0];

  if (!customer) {
    // Customer not present in this regional DB. Could be a foreign-region
    // customer (legitimate: V2 cross-region change not supported) or a
    // typo. Return 404 — leakage shape matches the rest of the API and
    // doesn't disclose existence in the other region.
    return Response.json({ error: "not found" }, { status: 404 });
  }

  if (customer.region === newRegion) {
    return Response.json(
      { ok: true, message: "no change — region already matches" },
      { status: 200 },
    );
  }

  // Cross-region change requires the V2 data move. V1 refuses.
  //
  // When V2 lands, this branch becomes the data-move call site:
  //   1. emitConfigAuditRow(customer, { eventType: "REGION_CHANGED", ... })
  //      writes the audit row against the current region's DB.
  //   2. The V2 data-move job runs (dump from EU Neon → re-encrypt under
  //      US KMS → load into US Neon → delete from EU Neon).
  //   3. Best-effort revokeSession across the target org's members forces
  //      a fresh JWT with the updated org publicMetadata.region.
  return Response.json(
    {
      error: "cross-region region change requires V2 data migration",
      currentRegion: customer.region,
      requestedRegion: newRegion,
    },
    { status: 400 },
  );
}
