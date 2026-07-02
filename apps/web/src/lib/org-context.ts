import { eq } from "drizzle-orm";
import { headers } from "next/headers";

import { getDb } from "@midplane-cloud/db";
import { member } from "@midplane-cloud/db/auth-schema";

import { getAuth } from "./auth";
import { bootRegion } from "./region-context";

// Session IDENTITY for the current request: who is signed in, and which
// organization is active. Provider-neutral — Better Auth ids now (was Clerk).
//
// THREE seams read the session, kept separate on purpose:
//   - identity (who / which org)  -> getOrgContext() / getActorEmail() (here)
//   - entitlements (plan / features) -> resolvePlan() / hasEntitlement() in lib/plan.ts
//   - region routing -> middleware + the signed region cookie
//
// Callers in request scope (server components, route handlers, server actions)
// MUST go through this instead of the auth SDK directly.

export interface OrgContext {
  /** Stable actor id, or null when unauthenticated. */
  userId: string | null;
  /** Active organization id (one org == one Midplane customer), or null when
   *  the signed-in user has no active org yet (fresh signup, pre-region-pick). */
  orgId: string | null;
}

/** Read the active session's identity from Better Auth. orgId comes from the
 *  session's active organization (set on org creation / switch).
 *
 *  Fallback: a session can carry NO active org while the user IS a member of
 *  one. Better Auth's SSO flow creates the session (our session.create hook runs
 *  with no membership yet → null active org) and only THEN provisions the org
 *  membership, so a first SSO login lands with activeOrganizationId=null and
 *  would be bounced to /signup as un-onboarded. When the session active
 *  org is missing, we resolve it from the user's membership instead. Resolve-
 *  ONLY (no setActiveOrganization persist): getOrgContext runs during Server
 *  Component render, where writing a cookie throws — the session self-heals on
 *  the next sign-in (session.create sets it once the membership exists).
 *  Genuinely un-onboarded users (no membership) still resolve to null and get
 *  the region picker. Self-host is unaffected (session.create always pins the
 *  implicit org, so this branch never runs). */
export async function getOrgContext(): Promise<OrgContext> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  const userId = session?.user.id ?? null;
  let orgId = session?.session.activeOrganizationId ?? null;
  if (userId && !orgId) {
    const rows = await getDb(bootRegion())
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, userId))
      .limit(1);
    orgId = rows[0]?.organizationId ?? null;
  }
  return { userId, orgId };
}

/** The signed-in actor's email, or null. Read straight off the session user —
 *  used by the signup/region write path that seeds customers.email. */
export async function getActorEmail(): Promise<string | null> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  return session?.user.email ?? null;
}
