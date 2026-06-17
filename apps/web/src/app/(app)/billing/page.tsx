import { redirect } from "next/navigation";

import { PageContainer, Topbar } from "@/components/layout/app-shell";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { currentCustomer } from "@/lib/customer";
import { hasEntitlement, resolvePlan } from "@/lib/plan";

// Plans & billing surface. Self-serve checkout (Stripe) lands in a later
// phase; until then every org is on Free and plan changes are handled
// manually. We show the current plan, the SSO entitlement row, and the
// "talk to us" path for custom asks PRICING.md keeps off the self-serve matrix.
//
// Server component: plan resolution + feature gate resolve server-side via the
// lib/plan.ts chokepoint.

const SALES_EMAIL = "sales@midplane.ai";

export default async function BillingPage() {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  const { plan } = await resolvePlan();
  // Single feature-gating seam in lib/plan.ts: hasEntitlement("sso") is the
  // only SSO gate, so wiring SSO entitlement later touches that module, not
  // this page. No billing wired yet, so it's false today.
  const hasSso = await hasEntitlement("sso");

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

          <Card>
            <CardHeader>
              <CardTitle>plans</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              <p>
                Self-serve plans and checkout are coming soon. To change your
                plan today,{" "}
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
