import { and, eq, isNotNull } from "drizzle-orm";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getDb } from "@midplane-cloud/db";
import { account, member, organization } from "@midplane-cloud/db/auth-schema";

import { PageContainer, Topbar } from "@/components/layout/app-shell";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { getAuth } from "@/lib/auth";
import { hasLiveSubscription } from "@/lib/billing";
import { currentCustomer } from "@/lib/customer";
import {
  classifyAccountDeletion,
  type AccountDeletionPlan,
  type OrgRole,
} from "@/lib/org-roles";
import { bootRegion } from "@/lib/region-context";
import { isSelfHost } from "@/lib/self-host";

import { ChangePasswordForm } from "./change-password-form";
import { DeleteAccountForm } from "./delete-account-form";
import { SignOutButton } from "./sign-out-button";

// Personal account page — your individual sign-in, distinct from workspace
// settings (which is org-level: name, region, members, SSO). Reached from the
// sidebar/topbar account menu. Surfaces your identity + sign-out, a password
// change for credential users, and a danger zone whose shape follows
// classifyAccountDeletion (sole-owner → delete the workspace; owner-with-members
// → blocked with a pointer to settings; non-owner → leave). The actual deletion
// runs through Better Auth's deleteUser → the beforeDelete backstop in
// lib/workspace.ts, so this page can't be the only thing enforcing the rule.
export default async function AccountPage() {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup");

  const session = await getAuth().api.getSession({ headers: await headers() });
  const userId = session?.user.id ?? "";
  const email = session?.user.email ?? "";
  const name = session?.user.name ?? "";

  const db = getDb(bootRegion());
  const selfHost = isSelfHost();

  // Credential (password) account? OAuth-only users have no password to rotate.
  const hasPassword =
    userId.length > 0 &&
    (
      await db
        .select({ id: account.id })
        .from(account)
        .where(and(eq(account.userId, userId), isNotNull(account.password)))
        .limit(1)
    ).length > 0;

  // The danger-zone shape. Self-host hides it — it has one implicit owner whose
  // deletion would brick the instance (the beforeDelete hook also refuses it).
  let deletionPlan: AccountDeletionPlan | null = null;
  let workspaceName = "your workspace";
  if (!selfHost) {
    const members = await db
      .select({ userId: member.userId, role: member.role })
      .from(member)
      .where(eq(member.organizationId, customer.orgId));
    const myRole = members.find((m) => m.userId === userId)?.role as
      | OrgRole
      | undefined;
    const otherMemberCount = members.filter((m) => m.userId !== userId).length;
    const orgRow = (
      await db
        .select({ name: organization.name })
        .from(organization)
        .where(eq(organization.id, customer.orgId))
        .limit(1)
    )[0];
    workspaceName = orgRow?.name ?? workspaceName;
    if (myRole) {
      deletionPlan = classifyAccountDeletion({
        role: myRole,
        otherMemberCount,
      });
    }
  }

  // A sole owner can't delete while a subscription is live — they cancel their
  // plan in billing first (the beforeDelete backstop enforces the same gate).
  const subscriptionBlocked =
    deletionPlan === "delete-workspace" &&
    (await hasLiveSubscription(customer.orgId));

  return (
    <>
      <Topbar>
        <Breadcrumb
          items={[
            { label: "Settings", href: "/settings" },
            { label: "Account" },
          ]}
        />
      </Topbar>
      <PageContainer>
        <div className="mx-auto max-w-[760px]">
          <PageHeader
            title="Account"
            subtitle="Your personal sign-in — separate from workspace settings."
          />

          <Card>
            <CardHeader>
              <CardTitle>profile</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="flex flex-col gap-3">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-muted-foreground">name</span>
                  <span className="text-foreground">{name || "—"}</span>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-muted-foreground">email</span>
                  <span className="text-foreground">{email || "—"}</span>
                </div>
              </div>
              <div className="border-t border-border pt-3">
                <SignOutButton />
              </div>
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle>password</CardTitle>
            </CardHeader>
            <CardContent>
              {hasPassword ? (
                <ChangePasswordForm />
              ) : (
                <p className="text-sm text-muted-foreground">
                  You sign in with Google, so there’s no password to manage
                  here.
                </p>
              )}
            </CardContent>
          </Card>

          {deletionPlan && (
            <Card className="mt-4 border-[hsl(var(--deny)/0.4)]">
              <CardHeader>
                <CardTitle>danger zone</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {deletionPlan === "blocked-owner" ? (
                  <p className="text-muted-foreground">
                    You own{" "}
                    <span className="font-medium text-foreground">
                      {workspaceName}
                    </span>
                    , which has other members. To delete your account, first
                    hand off ownership or remove the other members in{" "}
                    <Link
                      href="/settings"
                      className="font-medium text-foreground underline underline-offset-2"
                    >
                      workspace settings
                    </Link>
                    .
                  </p>
                ) : deletionPlan === "delete-workspace" ? (
                  subscriptionBlocked ? (
                    <p className="text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {workspaceName}
                      </span>{" "}
                      has an active subscription. Cancel it in{" "}
                      <Link
                        href="/billing"
                        className="font-medium text-foreground underline underline-offset-2"
                      >
                        billing
                      </Link>{" "}
                      before deleting your account.
                    </p>
                  ) : (
                    <>
                      <p className="text-muted-foreground">
                        You’re the only member of{" "}
                        <span className="font-medium text-foreground">
                          {workspaceName}
                        </span>
                        . Deleting your account permanently deletes the
                        workspace and everything in it — projects, connected
                        databases, tokens, and audit history. This can’t be
                        undone.
                      </p>
                      <DeleteAccountForm
                        mode="delete-workspace"
                        workspaceName={workspaceName}
                        hasPassword={hasPassword}
                      />
                    </>
                  )
                ) : (
                  <>
                    <p className="text-muted-foreground">
                      Deleting your account removes you from{" "}
                      <span className="font-medium text-foreground">
                        {workspaceName}
                      </span>{" "}
                      and erases your personal sign-in. The workspace and its
                      data stay. This can’t be undone.
                    </p>
                    <DeleteAccountForm
                      mode="leave"
                      workspaceName={workspaceName}
                      hasPassword={hasPassword}
                    />
                  </>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </PageContainer>
    </>
  );
}
