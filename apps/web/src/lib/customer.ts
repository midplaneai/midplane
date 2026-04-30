import { auth, currentUser } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";

import { customers, getDb, type Customer } from "@midplane-cloud/db";
import type { Region } from "@midplane-cloud/kms";

// Look up the Midplane customer for the current Clerk session, if it exists.
// Returns null when the Clerk user has signed in but hasn't picked a region
// yet — the dashboard route uses that to redirect to /signup/region.
export async function currentCustomer(): Promise<Customer | null> {
  const { userId } = await auth();
  if (!userId) return null;
  const db = getDb();
  const rows = await db
    .select()
    .from(customers)
    .where(eq(customers.clerkUserId, userId));
  return rows[0] ?? null;
}

// Create the customer row for a Clerk user, OR return the existing row if
// they've already signed up. Region is set on creation and immutable for V1.
//
// Race-safe: INSERT ... ON CONFLICT DO NOTHING means concurrent submits for
// the same Clerk user can't both succeed — one wins, the other returns no
// rows from .returning(), and we fall back to SELECT to fetch what the
// winner inserted. Without this, a double-clicked region form throws on
// the unique(clerk_user_id) constraint.
export async function upsertCustomerRegion(region: Region): Promise<Customer> {
  const { userId } = await auth();
  if (!userId) throw new Error("not signed in");
  const db = getDb();

  const user = await currentUser();
  const email =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses?.[0]?.emailAddress;
  if (!email) throw new Error("no email on Clerk user");

  const inserted = await db
    .insert(customers)
    .values({
      id: ulid(),
      clerkUserId: userId,
      email,
      region,
    })
    .onConflictDoNothing({ target: customers.clerkUserId })
    .returning();

  const winner = inserted[0];
  if (winner) return winner;

  // Conflict path: another transaction (or our own retry) already created
  // the row. Fetch and return it.
  const existing = await db
    .select()
    .from(customers)
    .where(eq(customers.clerkUserId, userId));
  const row = existing[0];
  if (!row) throw new Error("customer row vanished after onConflictDoNothing");
  return row;
}
