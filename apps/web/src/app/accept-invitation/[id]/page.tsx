import { eq } from "drizzle-orm";

import { getDb } from "@midplane-cloud/db";
import { invitation, organization } from "@midplane-cloud/db/auth-schema";

import { BrandLockup } from "@/components/layout/brand-mark";
import { EmptyState } from "@/components/ui/empty-state";
import { getActorEmail } from "@/lib/org-context";
import { bootRegion } from "@/lib/region-context";

import { AcceptInvite } from "./accept-invite";

// Teammate invite-accept landing. Reachable PRE-AUTH (middleware PUBLIC prefix)
// so an invited, not-yet-registered teammate can open the link the owner shared
// out-of-band, sign up with the invited email, and join — no email is ever
// sent. We read the invitation straight from the DB (not auth.api.getInvitation,
// which requires a matching session — the chicken/egg an unauthed landing can't
// satisfy) only to RENDER the right state; acceptInvitation re-validates
// pending + unexpired + email-match authoritatively before adding the member.
//
// Self-host is the in-scope target (the owner-issued, single-tenant invite).
// The page itself is provider-neutral — the natural seam for a future cloud
// invite model — but only self-host mints invitations today, so it's inert in
// the cloud (no valid invite id exists there).
export default async function AcceptInvitationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDb(bootRegion());

  const inv = (
    await db
      .select({
        email: invitation.email,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        organizationId: invitation.organizationId,
      })
      .from(invitation)
      .where(eq(invitation.id, id))
  )[0];

  const valid =
    inv && inv.status === "pending" && inv.expiresAt > new Date();

  const shell = (children: React.ReactNode) => (
    <main className="flex min-h-screen flex-col">
      <header className="border-b border-border px-10 py-5">
        <BrandLockup />
      </header>
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        {children}
      </div>
    </main>
  );

  if (!valid) {
    return shell(
      <div className="w-full max-w-[400px]">
        <EmptyState
          title="This invitation link is no longer valid"
          description="It may have expired or already been used. Ask your workspace owner for a fresh invite link."
        />
      </div>,
    );
  }

  const orgName =
    (
      await db
        .select({ name: organization.name })
        .from(organization)
        .where(eq(organization.id, inv.organizationId))
    )[0]?.name ?? "your workspace";

  const signedInEmail = await getActorEmail();

  return shell(
    <AcceptInvite
      invitationId={id}
      email={inv.email}
      orgName={orgName}
      signedInEmail={signedInEmail}
    />,
  );
}
