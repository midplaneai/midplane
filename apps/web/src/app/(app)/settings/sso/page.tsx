import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { getDb } from "@midplane-cloud/db";
import { ssoProvider } from "@midplane-cloud/db/auth-schema";

import { PageContainer, Topbar } from "@/components/layout/app-shell";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { currentCustomer } from "@/lib/customer";
import { hasEntitlement } from "@/lib/plan";
import { bootRegion } from "@/lib/region-context";
import { isSelfHost } from "@/lib/self-host";

import { SsoSettings, type SsoProviderView } from "./sso-settings";

// Organization security → SAML single sign-on. An Enterprise (ee) feature gated
// on hasEntitlement("sso"): the ee build switch AND the Team plan. Self-host has
// no plans and never loads the ee plugin, so the surface is absent there.
export default async function SsoSettingsPage() {
  // Not a self-host concept (uncapped core, no ee plugin loaded).
  if (isSelfHost()) notFound();

  const customer = await currentCustomer();
  if (!customer) redirect("/signup");

  const entitled = await hasEntitlement("sso");

  const header = (
    <>
      <Topbar>
        <Breadcrumb
          items={[{ label: "Settings", href: "/settings" }, { label: "SSO" }]}
        />
      </Topbar>
    </>
  );

  if (!entitled) {
    return (
      <>
        {header}
        <PageContainer>
          <div className="mx-auto max-w-[760px]">
            <PageHeader
              title="Single sign-on"
              subtitle="Federate sign-in to your identity provider with SAML."
            />
            <Card>
              <CardHeader>
                <CardTitle>saml</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                <p>
                  SSO/SAML is available on the{" "}
                  <strong className="font-medium text-foreground">Team</strong>{" "}
                  plan.{" "}
                  <Link
                    href="/billing"
                    className="font-medium text-foreground underline underline-offset-2"
                  >
                    Upgrade
                  </Link>{" "}
                  to connect your identity provider.
                </p>
              </CardContent>
            </Card>
          </div>
        </PageContainer>
      </>
    );
  }

  const baseUrl = process.env.BETTER_AUTH_URL ?? "";
  const providerId = `saml-${customer.orgId}`;
  const acsUrl = `${baseUrl}/api/auth/sso/saml2/sp/acs/${providerId}`;
  const metadataUrl = `${baseUrl}/api/auth/sso/saml2/sp/metadata?providerId=${providerId}`;

  const rows = await getDb(bootRegion())
    .select({
      providerId: ssoProvider.providerId,
      domain: ssoProvider.domain,
      issuer: ssoProvider.issuer,
      domainVerified: ssoProvider.domainVerified,
    })
    .from(ssoProvider)
    .where(eq(ssoProvider.organizationId, customer.orgId))
    .limit(1);
  const current: SsoProviderView | null = rows[0] ?? null;

  return (
    <>
      {header}
      <PageContainer>
        <div className="mx-auto max-w-[760px]">
          <PageHeader
            title="Single sign-on"
            subtitle="Federate sign-in to your identity provider with SAML."
          />
          <Card>
            <CardHeader>
              <CardTitle>saml project</CardTitle>
            </CardHeader>
            <CardContent>
              <SsoSettings
                orgId={customer.orgId}
                providerId={providerId}
                acsUrl={acsUrl}
                metadataUrl={metadataUrl}
                audience={baseUrl}
                current={current}
              />
            </CardContent>
          </Card>
        </div>
      </PageContainer>
    </>
  );
}
