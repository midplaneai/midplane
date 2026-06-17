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

// The self-host signup gate + its invited-teammate exception. SECURITY-CRITICAL.
//
// Self-host is single-tenant: currentCustomer() resolves ANY authenticated
// account to the one implicit customer, so whoever can SIGN UP can read the
// whole tenant's audit data. Signup is therefore the data-isolation boundary —
// not membership (membership only backs the member list / roles / seat count).
// These two hooks own that boundary; both no-op in the cloud.

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
 *  enforcement point. */
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

  const claimed = await db
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
  if (claimed.length === 0) {
    throw new APIError("FORBIDDEN", {
      message:
        "This Midplane instance already has an owner. Ask the owner for an invitation link to join.",
    });
  }
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
