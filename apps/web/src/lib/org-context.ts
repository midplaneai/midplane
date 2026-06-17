import { headers } from "next/headers";

import { getAuth } from "./auth";

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
 *  session's active organization (set on org creation / switch). */
export async function getOrgContext(): Promise<OrgContext> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  return {
    userId: session?.user.id ?? null,
    orgId: session?.session.activeOrganizationId ?? null,
  };
}

/** The signed-in actor's email, or null. Read straight off the session user —
 *  used by the signup/region write path that seeds customers.email. */
export async function getActorEmail(): Promise<string | null> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  return session?.user.email ?? null;
}
