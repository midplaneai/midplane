import { PricingTable } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import { PageContainer, Topbar } from "@/components/layout/app-shell";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { currentCustomer } from "@/lib/customer";
import { resolvePlan } from "@/lib/plan";

// Plans & billing surface. Clerk Billing owns the plan/price catalog and the
// checkout flow — <PricingTable for="organization"> renders the org's plans
// and drives subscribe/upgrade. We add the current-plan line, the SSO
// entitlement row (gated on the Clerk `sso` feature), and the "talk to us"
// path for custom asks PRICING.md keeps off the self-serve matrix.
//
// Server component: <PricingTable> is a Clerk client island; everything else
// (plan resolution, feature gate) resolves server-side from the session.

const SALES_EMAIL = "sales@midplane.com";

export default async function BillingPage() {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  const { plan } = await resolvePlan();
  const { has } = await auth();
  // Server-side entitlement check, ORG-SCOPED. `org:sso` binds to the active
  // organization's subscription — an unscoped `sso` would also match a
  // user-scoped feature with that slug (Clerk merges both scopes), wrongly
  // showing the org as SSO-entitled. The dashboard feature slug stays `sso`.
  const hasSso = has({ feature: "org:sso" });

  return (
    <>
      <Topbar>
        <Breadcrumb items={[{ label: "Billing" }]} />
      </Topbar>
      <PageContainer>
        <div className="mx-auto max-w-[960px]">
          <PageHeader
            title="Plans & billing"
            subtitle={
              <>
                Your organization is on the{" "}
                <strong className="font-medium capitalize text-foreground">
                  {plan}
                </strong>{" "}
                plan. Plan changes take effect on your next request.
              </>
            }
          />

          <PricingTable for="organization" />

          <Card className="mt-8">
            <CardHeader>
              <CardTitle>single sign-on (saml)</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {hasSso ? (
                <p>
                  SSO/SAML is included on your plan. Configure your identity
                  provider from your organization&apos;s security settings.
                </p>
              ) : (
                <p>
                  SSO/SAML is available on the{" "}
                  <strong className="font-medium text-foreground">Team</strong>{" "}
                  plan. Upgrade above to enable SAML connections for your
                  organization.
                </p>
              )}
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle>need something custom?</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              <p>
                BYOK, a dedicated region, custom retention, or SOC 2 / HIPAA
                artifacts —{" "}
                <a
                  href={`mailto:${SALES_EMAIL}`}
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  talk to us
                </a>
                .
              </p>
            </CardContent>
          </Card>
        </div>
      </PageContainer>
    </>
  );
}
