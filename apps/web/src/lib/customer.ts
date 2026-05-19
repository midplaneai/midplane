import { auth, currentUser } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";

import { customers, getDb, type Customer } from "@midplane-cloud/db";
import type { Region } from "@midplane-cloud/kms";

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
  const db = getDb();
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
  const db = getDb();

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
  if (winner) return winner;

  // Conflict path: another transaction (or our own retry) already created
  // the row. Fetch and return it.
  const existing = await db
    .select()
    .from(customers)
    .where(eq(customers.clerkOrgId, orgId));
  const row = existing[0];
  if (!row) throw new Error("customer row vanished after onConflictDoNothing");
  return row;
}
