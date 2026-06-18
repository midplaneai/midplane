import { eq } from "drizzle-orm";

import { customers, getDb } from "@midplane-cloud/db";

import { CAPS, SELF_HOST_CAPS, type Plan } from "./plan.ts";
import { bootRegion } from "./region-context.ts";
import { isSelfHost } from "./self-host.ts";

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
  // Self-host is uncapped (SELF_HOST_CAPS.seats = Infinity) — mirrors
  // resolvePlan()'s self-host short-circuit. WITHOUT this the implicit
  // customer row resolves to `free` (no plan/override seeded), capping seats at
  // 1, which would make acceptInvitation reject the SECOND member and brick the
  // teammate invite flow. Returned before any DB read, like resolvePlan().
  if (isSelfHost()) return SELF_HOST_CAPS.seats;

  const db = getDb(bootRegion());
  const rows = await db
    .select({ planOverride: customers.planOverride, plan: customers.plan })
    .from(customers)
    .where(eq(customers.orgId, orgId));
  const row = rows[0];
  const plan: Plan = row?.planOverride ?? row?.plan ?? "free";
  return CAPS[plan].seats;
}
