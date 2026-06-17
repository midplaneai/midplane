"use server";

import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";

import { getDb } from "@midplane-cloud/db";
import { member } from "@midplane-cloud/db/auth-schema";

import { getAuth } from "@/lib/auth";
import { getOrgContext } from "@/lib/org-context";
import { bootRegion } from "@/lib/region-context";
import { isSelfHost } from "@/lib/self-host";

// Teammate invites for self-host. The owner creates an invitation and shares
// the returned LINK out-of-band — no email is sent (see the organization()
// plugin config in lib/auth.ts: no sendInvitationEmail).
//
// Both actions re-check owner/admin on the server (defense in depth, mirroring
// settings/sso/actions.ts): Better Auth also enforces the org permission, but a
// server action is independently reachable. Self-host-scoped for now — the
// cloud invite model (existing users, their own orgs) is a follow-up; the
// accept route generalizes, the management surface here does not yet.
// Reached from a client component (members-card.tsx) that reads the returned
// state, so these RETURN errors, they don't throw.

async function requireManager(): Promise<
  { orgId: string } | { error: string }
> {
  if (!isSelfHost()) return { error: "Invites aren’t available here." };
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
  return { orgId };
}

/** Build the copyable accept link from this instance's origin. */
function inviteLink(invitationId: string): string {
  const base = (process.env.BETTER_AUTH_URL ?? "").replace(/\/$/, "");
  return `${base}/accept-invitation/${invitationId}`;
}

export async function createInvite(
  email: string,
): Promise<{ link?: string; error?: string }> {
  const gate = await requireManager();
  if ("error" in gate) return { error: gate.error };

  const trimmed = email.trim();
  if (!trimmed) return { error: "Enter an email address." };

  try {
    const invitation = await getAuth().api.createInvitation({
      body: { email: trimmed, role: "member", organizationId: gate.orgId },
      headers: await headers(),
    });
    return { link: inviteLink(invitation.id) };
  } catch (e) {
    // Better Auth throws an APIError with a human message (already a member,
    // already invited, invalid email, …) — surface it rather than a raw 500.
    return {
      error:
        e instanceof Error && e.message
          ? e.message
          : "Couldn’t create the invitation.",
    };
  }
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
