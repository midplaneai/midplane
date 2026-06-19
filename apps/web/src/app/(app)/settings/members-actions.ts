"use server";

import { and, eq, gt } from "drizzle-orm";
import { headers } from "next/headers";

import { getDb } from "@midplane-cloud/db";
import {
  invitation,
  member,
  organization,
  user,
} from "@midplane-cloud/db/auth-schema";

import { getAuth } from "@/lib/auth";
import { isEmailConfigured, sendOrgInvitationEmail } from "@/lib/email";
import { getActorEmail, getOrgContext } from "@/lib/org-context";
import { resolvePlan, seatInviteBlock } from "@/lib/plan";
import { bootRegion } from "@/lib/region-context";
import { isSelfHost } from "@/lib/self-host";

// Teammate invites. The owner/admin creates an invitation; the invited teammate
// opens the accept link (/accept-invitation/<id>) and joins.
//
//  - SELF-HOST: no email is sent (keyless, no SMTP) — createInvite returns the
//    LINK and the owner shares it out-of-band.
//  - CLOUD: createInvite emails the link via Resend right here (not the Better
//    Auth plugin callback) so it can report the TRUE delivery result; the link
//    is still returned as a copyable fallback. Invites are a paid-plan
//    capability — Free's seat cap is 1 (owner only).
//
// Both actions re-check owner/admin on the server (defense in depth, mirroring
// settings/sso/actions.ts): Better Auth also enforces the org permission, but a
// server action is independently reachable. Reached from a client component
// (members-card.tsx) that reads the returned state, so these RETURN errors, they
// don't throw.

async function requireManager(): Promise<
  { orgId: string; userId: string } | { error: string }
> {
  const { userId, orgId } = await getOrgContext();
  if (!userId || !orgId) return { error: "You’re not signed in." };
  const role = (
    await getDb(bootRegion())
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
  )[0]?.role;
  if (role !== "owner" && role !== "admin") {
    return { error: "Only an owner or admin can manage teammates." };
  }
  return { orgId, userId };
}

/** Build the copyable accept link from this instance's origin. */
function inviteLink(invitationId: string): string {
  const base = (process.env.BETTER_AUTH_URL ?? "").replace(/\/$/, "");
  return `${base}/accept-invitation/${invitationId}`;
}

/** Send the invite email (cloud) and report whether it ACTUALLY went out.
 *  Best-effort: any failure (Resend outage, lookup miss) is logged and returns
 *  false so the caller can tell the owner to share the copyable link instead of
 *  claiming a delivery that didn't happen. Only called behind isEmailConfigured(). */
async function deliverInviteEmail(args: {
  to: string;
  orgId: string;
  inviterId: string;
  link: string;
}): Promise<boolean> {
  try {
    const db = getDb(bootRegion());
    const orgRow = (
      await db
        .select({ name: organization.name })
        .from(organization)
        .where(eq(organization.id, args.orgId))
        .limit(1)
    )[0];
    const inviterRow = (
      await db
        .select({ name: user.name, email: user.email })
        .from(user)
        .where(eq(user.id, args.inviterId))
        .limit(1)
    )[0];
    await sendOrgInvitationEmail({
      to: args.to,
      orgName: orgRow?.name ?? "your workspace",
      inviterName: inviterRow?.name ?? null,
      inviterEmail: inviterRow?.email ?? args.to,
      inviteLink: args.link,
    });
    return true;
  } catch (e) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "invite.email_failed",
        orgId: args.orgId,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    return false;
  }
}

export async function createInvite(
  email: string,
): Promise<{ link?: string; emailed?: boolean; error?: string }> {
  const gate = await requireManager();
  if ("error" in gate) return { error: gate.error };

  const trimmed = email.trim();
  if (!trimmed) return { error: "Enter an email address." };

  const cloud = !isSelfHost();

  // Cloud-only pre-flight: self-invite, existing-account, and seat-cap guards.
  // Self-host is uncapped and single-region, so none apply (the seat cap also
  // short-circuits to Infinity there — lib/seats.ts).
  if (cloud) {
    const db = getDb(bootRegion());

    const actorEmail = await getActorEmail();
    if (actorEmail && actorEmail.toLowerCase() === trimmed.toLowerCase()) {
      return { error: "You’re already in this workspace." };
    }

    // Tier 1 supports inviting a NEW teammate only. An email that already has a
    // Midplane account in THIS region would, on accept, become a second org
    // membership — which the one-user→one-org model doesn't support yet (no org
    // switcher, arbitrary active org). Block it with a clear message rather than
    // create a half-broken state. (A cross-region existing account isn't visible
    // from this regional DB; that case falls through and creates a separate
    // regional account on accept.)
    const existing = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, trimmed.toLowerCase()))
      .limit(1);
    if (existing.length > 0) {
      return {
        error:
          "That email already has a Midplane account. Inviting an existing account to another workspace isn’t supported yet.",
      };
    }

    // Seat cap: count members + pending invites against the plan cap. The
    // membershipLimit org hook is the authoritative enforcer on accept; this is
    // the friendlier pre-flight so we don't mint an invite that can't be used.
    const members = await db
      .select({ id: member.id })
      .from(member)
      .where(eq(member.organizationId, gate.orgId));
    const pending = await db
      .select({ id: invitation.id })
      .from(invitation)
      .where(
        and(
          eq(invitation.organizationId, gate.orgId),
          eq(invitation.status, "pending"),
          gt(invitation.expiresAt, new Date()),
        ),
      );
    const { caps } = await resolvePlan();
    if (
      seatInviteBlock(
        { members: members.length, pending: pending.length },
        caps,
      )
    ) {
      return {
        error:
          "You’ve reached your plan’s member limit. Upgrade your plan to invite more teammates.",
      };
    }
  }

  let created: { id: string };
  try {
    created = await getAuth().api.createInvitation({
      body: { email: trimmed, role: "member", organizationId: gate.orgId },
      headers: await headers(),
    });
  } catch (e) {
    // Better Auth throws an APIError with a human message (already a member,
    // already invited, invalid email, seat limit, …) — surface it rather than a
    // raw 500.
    return {
      error:
        e instanceof Error && e.message
          ? e.message
          : "Couldn’t create the invitation.",
    };
  }

  const link = inviteLink(created.id);

  // Cloud: send the email ourselves so `emailed` reflects ACTUAL delivery, not
  // just "email is configured". On failure the owner shares the link instead.
  const emailed =
    cloud && isEmailConfigured()
      ? await deliverInviteEmail({
          to: trimmed,
          orgId: gate.orgId,
          inviterId: gate.userId,
          link,
        })
      : false;

  return { link, emailed };
}

export async function revokeInvite(
  invitationId: string,
): Promise<{ error?: string }> {
  const gate = await requireManager();
  if ("error" in gate) return { error: gate.error };

  try {
    await getAuth().api.cancelInvitation({
      body: { invitationId },
      headers: await headers(),
    });
    return {};
  } catch (e) {
    return {
      error:
        e instanceof Error && e.message
          ? e.message
          : "Couldn’t revoke the invitation.",
    };
  }
}
