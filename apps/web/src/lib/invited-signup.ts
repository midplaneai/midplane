import { and, gt, eq, sql } from "drizzle-orm";

import { getDb } from "@midplane-cloud/db";
import { invitation } from "@midplane-cloud/db/auth-schema";

import { bootRegion } from "./region-context";

// Was this signup reached by accepting an emailed invitation?
//
// Used to pre-verify invited teammates. The invitation link is delivered to the
// address and is tied to it (acceptInvitation re-checks the match), so someone
// signing up against a pending invite has ALREADY demonstrated control of the
// mailbox. Making them then click a second link in a second email to prove the
// same thing is a redundant round trip on the highest-intent path we have — and
// one where the invite mail and the verification mail race each other into the
// same inbox, which reads as broken.
//
// This is a convenience exemption, NOT an authorization decision: it only sets
// `emailVerified`. Actual tenant access still requires acceptInvitation to
// write the member row, which independently re-validates that the invitation is
// pending, unexpired, and addressed to this email. A forged claim here would
// therefore grant nothing.

/** True when `email` has at least one pending, unexpired invitation in this
 *  region's database. Case-insensitive on the address, matching how
 *  acceptInvitation and the self-host gate compare it. Best-effort: callers
 *  treat a throw as "not invited" rather than failing the signup. */
export async function hasPendingInvitation(email: string): Promise<boolean> {
  const db = getDb(bootRegion());
  const rows = await db
    .select({ id: invitation.id })
    .from(invitation)
    .where(
      and(
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
        sql`lower(${invitation.email}) = lower(${email})`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
