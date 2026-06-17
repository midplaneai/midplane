import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { ulid } from "ulid";

import { customers, getDb, type Customer } from "@midplane-cloud/db";
import type { Region } from "@midplane-cloud/kms";
import { getAuth } from "./auth.ts";
import { getActorEmail, getOrgContext } from "./org-context.ts";
import { bootRegion } from "./region-context.ts";
import {
  slugifyWorkspaceName,
  suggestWorkspaceName,
} from "./workspace-name.ts";

// Look up the Midplane customer for the current session's active org, if it
// exists. Returns null when the signed-in user has no active org yet (fresh
// signup, before the region picker creates one) or has an org but no customer
// row yet — the dashboard route uses null to redirect to /signup/region.
//
// One Midplane customer == one organization. Org members are the actors who
// can sign in and act on its behalf.
export async function currentCustomer(): Promise<Customer | null> {
  const { orgId } = await getOrgContext();
  if (!orgId) return null;
  // Each regional app is single-region (MIDPLANE_REGION env var, enforced
  // by env-var locality on DATABASE_URL_<REGION>). Read from this app's DB;
  // middleware redirects cross-region requests before they reach here.
  const db = getDb(bootRegion());
  const rows = await db
    .select()
    .from(customers)
    .where(eq(customers.orgId, orgId));
  return rows[0] ?? null;
}

// Create the customer row for the current org, OR return the existing row if
// one's already been created. Region is set on creation and immutable for V1.
//
// Better Auth (unlike Clerk) does NOT auto-create an organization on signup,
// so a fresh user reaches the region picker with no active org. We create it
// here — the signup-completion step — keeping the one-org-one-customer
// invariant, then write the customer row against the chosen region's DB.
//
// Race-safe: INSERT ... ON CONFLICT DO NOTHING means concurrent submits for
// the same org can't both succeed — one wins, the other returns no rows from
// .returning(), and we fall back to SELECT to fetch what the winner inserted.
export async function upsertCustomerRegion(
  region: Region,
  orgName?: string,
): Promise<Customer> {
  // We seed customers.email from the human who first picked the region — used
  // for receipts and the customers row.
  const email = await getActorEmail();
  if (!email) throw new Error("no email on session user");

  let { orgId } = await getOrgContext();
  if (!orgId) {
    // The org name comes from the signup form (a smart default the user can
    // edit). Fall back to the derived suggestion if it's blank.
    orgId = await createActiveOrg(orgName?.trim() || suggestWorkspaceName(email));
  }

  // Pick the DB for the region the user is signing up for, not the region this
  // process happens to run in. Picker submission must originate on the matching
  // regional app (apex form-action redirects there), so getDb(region) succeeds;
  // calling it from the wrong-region app throws "DATABASE_URL_<REGION> not set"
  // — hard failure, not a silent cross-region read.
  const db = getDb(region);

  const inserted = await db
    .insert(customers)
    .values({
      id: ulid(),
      orgId: orgId,
      email,
      region,
    })
    .onConflictDoNothing({ target: customers.orgId })
    .returning();

  const winner = inserted[0];
  if (!winner) {
    // Conflict path: another transaction (or our own retry) already created
    // the row. Fetch and return it.
    const existing = await db
      .select()
      .from(customers)
      .where(eq(customers.orgId, orgId));
    const row = existing[0];
    if (!row)
      throw new Error("customer row vanished after onConflictDoNothing");
    // Defensive: region is immutable per 0001_constraints.sql; a double-submit
    // for a different region must reject loudly, not silently return the
    // existing row.
    if (row.region !== region) {
      throw new Error(
        `org already has customer row in ${row.region}; cannot rewrite to ${region}`,
      );
    }
    return row;
  }

  return winner;
}

// Create a Better Auth organization for the current user and make it the
// active org on the session. One org == one customer, so there's never
// another to choose. The active-org write means getOrgContext().orgId resolves
// it on the next request; even if the cookie refresh lags, getSession reads
// activeOrganizationId from the session row in the DB.
//
// Region is NOT written to org metadata — region routing uses the signed
// region cookie + the customers.region column, not an org-metadata claim.
async function createActiveOrg(orgName: string): Promise<string> {
  const auth = getAuth();
  const reqHeaders = await headers();
  const slugBase = slugifyWorkspaceName(orgName);
  const created = await auth.api.createOrganization({
    body: {
      name: orgName,
      slug: `${slugBase || "org"}-${ulid().slice(-10).toLowerCase()}`,
    },
    headers: reqHeaders,
  });
  if (!created) throw new Error("failed to create organization");
  await auth.api.setActiveOrganization({
    body: { organizationId: created.id },
    headers: reqHeaders,
  });
  return created.id;
}
