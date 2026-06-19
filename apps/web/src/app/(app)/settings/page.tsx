import { and, desc, eq, gt } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getDb } from "@midplane-cloud/db";
import {
  invitation,
  member,
  organization,
  user,
} from "@midplane-cloud/db/auth-schema";

import { PageContainer, Topbar } from "@/components/layout/app-shell";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { RegionBadge } from "@/components/ui/region-badge";
import { currentCustomer } from "@/lib/customer";
import { isEmailConfigured } from "@/lib/email";
import { getOrgContext } from "@/lib/org-context";
import { resolvePlan, seatInviteBlock } from "@/lib/plan";
import { bootRegion } from "@/lib/region-context";
import { isSelfHost } from "@/lib/self-host";

import {
  MembersCard,
  type MemberView,
  type PendingInviteView,
} from "./members-card";
import { RenameWorkspaceForm } from "./rename-workspace-form";

// Workspace settings. Today: rename + the (immutable) data region. The future
// home for members / invites — the seat cap is already enforced on the invite
// path (lib/seats.ts) via the org plugin's membershipLimit.
export default async function SettingsPage() {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  const db = getDb(bootRegion());
  const orgRow = (
    await db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, customer.orgId))
  )[0];
  const currentName = orgRow?.name ?? "";

  // SSO is a cloud (ee) feature; self-host has no plans and never loads it, so
  // the link is hidden there. The /settings/sso page itself gates on the Team
  // entitlement (and shows an upgrade notice for plans without it).
  const showSso = !isSelfHost();

  // Members + invites. Cloud and self-host both: list current members, let an
  // owner/admin invite teammates and revoke pending invites. Cloud emails the
  // invite link (Resend) and gates on the plan's seat cap (Free = 1 = owner
  // only); self-host is uncapped and the owner shares the link out-of-band.
  let membersData: {
    members: MemberView[];
    pending: PendingInviteView[];
    canManage: boolean;
    seatLimitReached: boolean;
    emailDelivers: boolean;
  } | null = null;
  {
    const { userId } = await getOrgContext();
    const memberRows = await db
      .select({
        id: member.id,
        userId: member.userId,
        role: member.role,
        email: user.email,
        name: user.name,
      })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, customer.orgId))
      .orderBy(member.createdAt);

    const myRole = memberRows.find((r) => r.userId === userId)?.role;
    const canManage = myRole === "owner" || myRole === "admin";

    const pendingRows = canManage
      ? await db
          .select({
            id: invitation.id,
            email: invitation.email,
            expiresAt: invitation.expiresAt,
          })
          .from(invitation)
          .where(
            and(
              eq(invitation.organizationId, customer.orgId),
              eq(invitation.status, "pending"),
              gt(invitation.expiresAt, new Date()),
            ),
          )
          .orderBy(desc(invitation.createdAt))
      : [];

    // Seat pre-flight for the invite form (advisory; Better Auth enforces the
    // cap on accept). resolvePlan short-circuits self-host to uncapped seats.
    const { caps } = await resolvePlan();
    const seatLimitReached =
      canManage &&
      seatInviteBlock(
        { members: memberRows.length, pending: pendingRows.length },
        caps,
      ) !== null;

    membersData = {
      canManage,
      seatLimitReached,
      emailDelivers: !isSelfHost() && isEmailConfigured(),
      members: memberRows.map((r) => ({
        memberId: r.id,
        email: r.email,
        name: r.name,
        role: r.role,
        isYou: r.userId === userId,
      })),
      pending: pendingRows.map((r) => ({
        id: r.id,
        email: r.email,
        expiresLabel: `expires ${r.expiresAt.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}`,
      })),
    };
  }

  return (
    <>
      <Topbar>
        <Breadcrumb items={[{ label: "Settings" }]} />
      </Topbar>
      <PageContainer>
        <div className="mx-auto max-w-[760px]">
          <PageHeader
            title="Workspace"
            subtitle="Your workspace name and where its data lives."
          />

          <Card>
            <CardHeader>
              <CardTitle>name</CardTitle>
            </CardHeader>
            <CardContent>
              <RenameWorkspaceForm
                orgId={customer.orgId}
                currentName={currentName}
              />
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle>region</CardTitle>
            </CardHeader>
            <CardContent className="flex items-center gap-3 text-sm text-muted-foreground">
              <RegionBadge region={customer.region} />
              <span>
                Permanent — your audit log and encrypted credentials live here.
              </span>
            </CardContent>
          </Card>

          {membersData && (
            <Card className="mt-4">
              <CardHeader>
                <CardTitle>members</CardTitle>
              </CardHeader>
              <CardContent>
                <MembersCard
                  members={membersData.members}
                  pending={membersData.pending}
                  canManage={membersData.canManage}
                  seatLimitReached={membersData.seatLimitReached}
                  emailDelivers={membersData.emailDelivers}
                />
              </CardContent>
            </Card>
          )}

          {showSso && (
            <Card className="mt-4">
              <CardHeader>
                <CardTitle>single sign-on</CardTitle>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                <span>
                  Connect your identity provider so your team signs in with SAML.
                </span>
                <Link
                  href="/settings/sso"
                  className="shrink-0 font-medium text-foreground underline underline-offset-2"
                >
                  Configure
                </Link>
              </CardContent>
            </Card>
          )}
        </div>
      </PageContainer>
    </>
  );
}
