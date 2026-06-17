import { eq } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getDb } from "@midplane-cloud/db";
import { organization } from "@midplane-cloud/db/auth-schema";

import { PageContainer, Topbar } from "@/components/layout/app-shell";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { RegionBadge } from "@/components/ui/region-badge";
import { currentCustomer } from "@/lib/customer";
import { bootRegion } from "@/lib/region-context";
import { isSelfHost } from "@/lib/self-host";

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
