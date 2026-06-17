import { eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { ulid } from "ulid";

import { customers, getDb, type Customer } from "@midplane-cloud/db";
import { member } from "@midplane-cloud/db/auth-schema";
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

  const { userId, orgId: sessionOrgId } = await getOrgContext();
  if (!userId) throw new Error("not authenticated");

  // The session's active org, or — for a fresh signup, or a returning user
  // whose new session has no active org set — the user's existing org, created
  // idempotently. Never mints a second org for the same user.
  const orgId =
    sessionOrgId ?? (await getOrCreateOrgForUser(userId, email, orgName));

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

// Resolve the user's organization, creating it on first onboarding. Idempotent
// per user: a Postgres advisory lock serializes concurrent fresh onboards (a
// double-submitted region form, two tabs) so they can't each create a DIFFERENT
// org — the first creates it; the rest see the membership and reuse it. One org
// == one customer.
//
// The lock must live inside a transaction: postgres-js pools connections, and
// only `db.transaction` pins one connection for the callback, so the
// xact-scoped advisory lock (auto-released on commit) is the pool-safe choice.
async function getOrCreateOrgForUser(
  userId: string,
  email: string,
  orgName?: string,
): Promise<string> {
  const orgId = await getDb(bootRegion()).transaction(async (tx) => {
    // Concurrent onboards of the same user block here until the holder commits.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`,
    );
    const existing = await tx
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, userId))
      .limit(1);
    if (existing[0]) return existing[0].organizationId;
    return createOrg(orgName?.trim() || suggestWorkspaceName(email));
  });

  // Make sure the session's active org matches the resolved org — covers the
  // reuse path, where the session may have had a null/stale active org.
  await getAuth().api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: await headers(),
  });
  return orgId;
}

// Create a Better Auth organization owned by the current user. The active-org
// write is handled by the caller so the create + reuse paths converge.
//
// Region is NOT written to org metadata — region routing uses the signed region
// cookie + the customers.region column, not an org-metadata claim.
async function createOrg(orgName: string): Promise<string> {
  const slugBase = slugifyWorkspaceName(orgName);
  const created = await getAuth().api.createOrganization({
    body: {
      name: orgName,
      slug: `${slugBase || "org"}-${ulid().slice(-10).toLowerCase()}`,
    },
    headers: await headers(),
  });
  if (!created) throw new Error("failed to create organization");
  return created.id;
}
