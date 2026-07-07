import { APIError } from "better-auth/api";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { ulid } from "ulid";

import { customers, getDb } from "@midplane-cloud/db";
import { invitation, member } from "@midplane-cloud/db/auth-schema";

import { bootRegion } from "./region-context.ts";
import {
  isSelfHost,
  SELF_HOST_CUSTOMER_ID,
  SELF_HOST_ORG_ID,
} from "./self-host.ts";

// Self-host single-tenant access control. SECURITY-CRITICAL.
//
// TWO boundaries work together (both no-op in the cloud):
//   - This SIGNUP gate controls who may CREATE AN ACCOUNT: the first signup
//     becomes the owner; later signups are rejected unless the email holds a
//     pending, owner-issued invitation.
//   - MEMBERSHIP controls who may READ tenant data: currentCustomer() resolves
//     the implicit customer only for an accepted member (or the claimed owner) —
//     see resolveSelfHostAccess below + customer.ts. A bare session is NOT
//     enough. So an invited user who signs up but never accepts — or whose
//     invite is revoked before acceptance — gets a login with NO tenant access,
//     and removing a member cuts access. Without this split, returning from the
//     gate would grant tenant access the moment signup succeeds, before
//     acceptInvitation runs and regardless of a later revoke.

/** Single-owner gate, with an exception for invited teammates. Called from the
 *  Better Auth `user.create.before` hook (self-host only).
 *
 *  Order matters:
 *   1. INVITED TEAMMATE — a pending, unexpired invitation for this email in the
 *      implicit org means the owner explicitly invited them. Allow the signup
 *      WITHOUT claiming owner; acceptInvitation then creates their member row
 *      (with the invite's role) and marks the invite accepted (single-use).
 *      Invitations can only be minted by an owner/admin (Better Auth enforces
 *      `invitation: ["create"]`), so this exception can't be self-issued to
 *      bypass the gate.
 *   2. OWNER CLAIM — otherwise, atomically claim the implicit customer's
 *      owner_email. The single-row UPDATE + WHERE serializes concurrent
 *      signups on the row lock (NOT a raceable count-then-create): the first
 *      sets owner_email and commits; a racing different-email signup blocks,
 *      re-reads the now-set value, updates zero rows, and is rejected. The
 *      `= email` arm lets the legitimate owner retry if their first attempt
 *      failed after the claim, so a transient error can't brick the instance.
 *
 *  The pending/unexpired check runs in code (not SQL) so it's explicit and
 *  unit-testable; acceptInvitation re-validates pending+unexpired+email
 *  authoritatively before it ever creates a member, so this is a gate, not the
 *  enforcement point. Allowing signup does NOT grant tenant access — that
 *  requires accepted membership (resolveSelfHostAccess), so an account created
 *  here is inert until acceptInvitation writes the member row. */
export async function enforceSelfHostSignupGate(email: string): Promise<void> {
  if (!isSelfHost()) return;
  const db = getDb(bootRegion());

  const candidates = await db
    .select({
      status: invitation.status,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, SELF_HOST_ORG_ID),
        sql`lower(${invitation.email}) = lower(${email})`,
      ),
    );
  const now = new Date();
  const hasValidInvite = candidates.some(
    (i) => i.status === "pending" && i.expiresAt > now,
  );
  if (hasValidInvite) return;

  let claimed = await claimOwner(db, email);

  // Defense in depth. A zero-row claim means ONE of two things that must NOT be
  // conflated:
  //   (a) a real second owner — the row EXISTS with a different owner_email set;
  //   (b) the implicit customer row was never seeded — an EMPTY database.
  // (a) is the gate doing its job; (b) is the P0 that bricks the FIRST signup.
  // (A present-but-UNCLAIMED row can't reach here: the claim's `owner_email IS
  // NULL` arm would have matched it, so a zero-row claim with the row present
  // always means owned-by-someone-else.)
  //
  // The row is normally seeded at boot by ensureImplicitCustomer()
  // (instrumentation.register). But if that hook didn't run — e.g. a build that
  // dropped instrumentation from the standalone output — the row is absent and a
  // genuinely first signup gets a spurious "already has an owner", bricking the
  // instance. Rather than hang a P0 invariant on build-tool file discovery,
  // self-heal case (b): when the row is absent, seed it (idempotent — the same
  // org + customer + Default project the boot hook seeds) and retry the SAME
  // atomic claim, turning "bricked" into "first request seeds". Case (a) skips
  // the reseed entirely (the row is present) and falls through to the throw, so
  // a real second owner is still rejected and the abusive reject path stays
  // cheap. The dynamic import keeps customer.ts off the static graph (it already
  // imports this file — resolveSelfHostAccess — so a static edge back would
  // cycle) and out of the hot path.
  if (claimed.length === 0) {
    const rowPresent =
      (
        await db
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.id, SELF_HOST_CUSTOMER_ID))
          .limit(1)
      ).length > 0;
    if (!rowPresent) {
      const { ensureImplicitCustomer } = await import("./customer.ts");
      await ensureImplicitCustomer();
      claimed = await claimOwner(db, email);
    }
  }

  if (claimed.length === 0) {
    throw new APIError("FORBIDDEN", {
      message:
        "This Midplane instance already has an owner. Ask the owner for an invitation link to join.",
    });
  }
}

/** The atomic owner claim: set owner_email on the implicit customer row iff it's
 *  still unclaimed OR already this email (the retry-safe arm). Returns the
 *  updated rows — zero means the row is missing or owned by someone else. Kept
 *  as one helper so the seed-and-retry path re-runs byte-identical SQL. */
async function claimOwner(
  db: ReturnType<typeof getDb>,
  email: string,
): Promise<Array<{ ownerEmail: string | null }>> {
  return db
    .update(customers)
    .set({ ownerEmail: email })
    .where(
      and(
        eq(customers.id, SELF_HOST_CUSTOMER_ID),
        or(
          isNull(customers.ownerEmail),
          eq(customers.ownerEmail, email),
        ),
      ),
    )
    .returning({ ownerEmail: customers.ownerEmail });
}

/** Link the OWNER as an `owner` member of the implicit org. Called from the
 *  Better Auth `user.create.after` hook (self-host only).
 *
 *  Only the owner is linked here — the account whose email the gate above just
 *  claimed. An invited teammate's member row is created by acceptInvitation
 *  with the INVITE's role; linking them here as `owner` would both
 *  over-privilege them and race acceptInvitation's createMember. The owner is
 *  identified by matching the now-claimed owner_email (committed by the
 *  before-hook in this same signup). The existence check keeps it idempotent. */
export async function linkSelfHostOwnerMember(user: {
  id: string;
  email: string;
}): Promise<void> {
  if (!isSelfHost()) return;
  const db = getDb(bootRegion());

  const claimed = await db
    .select({ ownerEmail: customers.ownerEmail })
    .from(customers)
    .where(eq(customers.id, SELF_HOST_CUSTOMER_ID));
  const ownerEmail = claimed[0]?.ownerEmail;
  if (!ownerEmail || ownerEmail.toLowerCase() !== user.email.toLowerCase()) {
    // Invited teammate (or pre-claim race) — acceptInvitation owns their row.
    return;
  }

  const existing = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.userId, user.id),
        eq(member.organizationId, SELF_HOST_ORG_ID),
      ),
    )
    .limit(1);
  if (existing.length === 0) {
    await db.insert(member).values({
      id: ulid(),
      userId: user.id,
      organizationId: SELF_HOST_ORG_ID,
      role: "owner",
    });
  }
}

/** Pure access decision for the self-host implicit tenant: granted to an
 *  ACCEPTED member, or to the claimed owner by identity. A bare session is not
 *  enough. The owner-by-identity arm is a safety net so a missing owner member
 *  row (e.g. a half-failed signup) can never lock the owner out of their own
 *  instance; for everyone else, the member row is the boundary. Used by
 *  currentCustomer() — kept pure so the boundary is unit-testable. */
export function resolveSelfHostAccess(opts: {
  isMember: boolean;
  sessionEmail: string | null;
  ownerEmail: string | null;
}): boolean {
  if (opts.isMember) return true;
  return (
    opts.sessionEmail != null &&
    opts.ownerEmail != null &&
    opts.sessionEmail.toLowerCase() === opts.ownerEmail.toLowerCase()
  );
}

/** Where to send a self-host user who is authenticated but NOT a member —
 *  signed up via an invite they haven't accepted, or whose invite was revoked.
 *  If a pending, unexpired invite still exists for their email, send them to
 *  accept it (the recovery path); otherwise they have no access — back to
 *  sign-in. Deliberately NOT /signup: that's cloud-only and would bounce
 *  to /dashboard, looping against the (app) layout's membership gate. */
export async function selfHostNonMemberRedirect(
  email: string | null,
): Promise<string> {
  if (!email) return "/sign-in";
  const db = getDb(bootRegion());
  const rows = await db
    .select({
      id: invitation.id,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, SELF_HOST_ORG_ID),
        sql`lower(${invitation.email}) = lower(${email})`,
      ),
    );
  const now = new Date();
  const pending = rows.find((r) => r.status === "pending" && r.expiresAt > now);
  return pending ? `/accept-invitation/${pending.id}` : "/sign-in";
}
