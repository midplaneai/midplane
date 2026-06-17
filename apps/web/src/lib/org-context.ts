import { auth, currentUser } from "@clerk/nextjs/server";

// Session IDENTITY for the current request: who is signed in, and which
// organization is active. Provider-neutral by design — Clerk `user_…` /
// `org_…` ids today; Better Auth ids after the auth migration, with NO
// call-site changes.
//
// THREE seams read the session, and they stay separate on purpose:
//   - identity (who / which org)  -> getOrgContext() / getActorEmail() (here)
//   - entitlements (plan / features) -> resolvePlan() / hasEntitlement() in lib/plan.ts
//   - region routing -> middleware + the signed region cookie
//
// Callers in request scope (server components, route handlers, server
// actions) MUST go through this instead of Clerk `auth()` directly, so the
// auth-backend swap changes ONE file's body, not ~24 call sites.
//
// NOT for middleware (Clerk injects its own `auth` there) and NOT for
// entitlements (use lib/plan.ts).

export interface OrgContext {
  /** Stable actor id, or null when unauthenticated. */
  userId: string | null;
  /** Active organization id (one org == one Midplane customer), or null when
   *  the signed-in user has no active org yet. */
  orgId: string | null;
}

/** Read the active session's identity. Behavior-preserving thin pass-through
 *  over Clerk `auth()` today; the auth migration swaps only this body. */
export async function getOrgContext(): Promise<OrgContext> {
  const { userId, orgId } = await auth();
  return { userId: userId ?? null, orgId: orgId ?? null };
}

/** The signed-in actor's primary email, or null. Heavier than
 *  getOrgContext() (a Clerk backend fetch via currentUser, not a JWT read),
 *  so it's a separate seam used only by the signup/region write path that
 *  seeds customers.email. Better Auth returns this straight off the session. */
export async function getActorEmail(): Promise<string | null> {
  const user = await currentUser();
  return (
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses?.[0]?.emailAddress ??
    null
  );
}
