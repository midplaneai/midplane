import { eq } from "drizzle-orm";

import { customers, getDb } from "@midplane-cloud/db";

import { CAPS, type Plan } from "./plan.ts";
import { bootRegion } from "./region-context.ts";

// Seat cap (max org members) for an organization, resolved from its customer's
// plan. Wired into Better Auth's organization.membershipLimit so the invite/add
// path enforces the per-plan limit — membershipLimit is otherwise a single
// static number, not per-plan.
//
// Resolves the plan by ORG id (not the session): one org == one customer, whose
// row lives in this regional DB. Mirrors resolvePlan()'s precedence —
// plan_override (the manual lever) beats the subscription-backed plan; absent
// both, free. No customer row yet (org created, region not yet picked) → the
// free seat cap, the safe floor.
export async function seatCapForOrg(orgId: string): Promise<number> {
  const db = getDb(bootRegion());
  const rows = await db
    .select({ planOverride: customers.planOverride, plan: customers.plan })
    .from(customers)
    .where(eq(customers.orgId, orgId));
  const row = rows[0];
  const plan: Plan = row?.planOverride ?? row?.plan ?? "free";
  return CAPS[plan].seats;
}
