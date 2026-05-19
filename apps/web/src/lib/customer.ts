import { auth, currentUser } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";

import { customers, getDb, type Customer } from "@midplane-cloud/db";
import type { Region } from "@midplane-cloud/kms";
import { bootRegion } from "./region-context.ts";

// Look up the Midplane customer for the current Clerk session, if it exists.
// Returns null when:
//   - the Clerk user has signed in but their session has no active org yet
//     (Clerk dashboard config force-creates one on signup, so this should
//     be a transient state during the very first request after signup), OR
//   - they have an active org but haven't picked a region yet (post-signup,
//     pre-region-selection — the dashboard route uses this to redirect to
//     /signup/region).
//
// One Midplane customer == one Clerk organization. Org members are the
// actors who can sign in on its behalf.
export async function currentCustomer(): Promise<Customer | null> {
  const { orgId } = await auth();
  if (!orgId) return null;
  // Each regional app is single-region (MIDPLANE_REGION env var, enforced
  // by env-var locality on DATABASE_URL_<REGION>). Read from this app's DB;
  // middleware redirects cross-region requests before they reach here.
  const db = getDb(bootRegion());
  const rows = await db
    .select()
    .from(customers)
    .where(eq(customers.clerkOrgId, orgId));
  return rows[0] ?? null;
}

// Create the customer row for the current Clerk org, OR return the existing
// row if one's already been created. Region is set on creation and immutable
// for V1.
//
// Race-safe: INSERT ... ON CONFLICT DO NOTHING means concurrent submits for
// the same Clerk org can't both succeed — one wins, the other returns no
// rows from .returning(), and we fall back to SELECT to fetch what the
// winner inserted. Without this, a double-clicked region form throws on
// the unique(clerk_org_id) constraint.
export async function upsertCustomerRegion(region: Region): Promise<Customer> {
  const { orgId } = await auth();
  if (!orgId) throw new Error("no active organization");

  // Pick the DB for the region the user is signing up for, not the region
  // this process happens to be running in. Picker submission must originate
  // on the matching regional app (apex form-action redirects there before
  // calling this), so `getDb(region)` will succeed; calling it from the
  // wrong-region app throws "DATABASE_URL_<REGION> not set" — hard failure,
  // not silent cross-region read.
  const db = getDb(region);

  // We seed customers.email from the human who first picked the region for
  // the org — used for the workspace label in AppShell + receipts. The org
  // itself doesn't carry a billing email yet (Clerk Billing wires that
  // separately when we turn it on).
  const user = await currentUser();
  const email =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses?.[0]?.emailAddress;
  if (!email) throw new Error("no email on Clerk user");

  const inserted = await db
    .insert(customers)
    .values({
      id: ulid(),
      clerkOrgId: orgId,
      email,
      region,
    })
    .onConflictDoNothing({ target: customers.clerkOrgId })
    .returning();

  const winner = inserted[0];
  if (!winner) {
    // Conflict path: another transaction (or our own retry) already created
    // the row. Fetch and return it.
    const existing = await db
      .select()
      .from(customers)
      .where(eq(customers.clerkOrgId, orgId));
    const row = existing[0];
    if (!row)
      throw new Error("customer row vanished after onConflictDoNothing");
    // Defensive: if the existing row is for a different region (caller
    // double-submitted a different pick), reject loudly — region is
    // immutable per 0001_constraints.sql, but the wrong-region request
    // shouldn't silently succeed by returning the existing row.
    if (row.region !== region) {
      throw new Error(
        `org already has customer row in ${row.region}; cannot rewrite to ${region}`,
      );
    }
    await writeClerkOrgRegionMetadata(orgId, region);
    return row;
  }

  await writeClerkOrgRegionMetadata(orgId, region);
  return winner;
}

// Write region to Clerk organization publicMetadata so the JWT carries it
// for the next request. Failure here leaves the DB customer row consistent
// but the org metadata stale — the backfill script catches that case on
// its next run, and middleware emits region.null_metadata for the gap.
async function writeClerkOrgRegionMetadata(
  orgId: string,
  region: Region,
): Promise<void> {
  const { clerkClient } = await import("@clerk/nextjs/server");
  const client = await clerkClient();
  await client.organizations.updateOrganizationMetadata(orgId, {
    publicMetadata: { region },
  });
}
