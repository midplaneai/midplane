import { redirect } from "next/navigation";

import { BillingActions } from "@/components/billing/billing-actions";
import { PageContainer, Topbar } from "@/components/layout/app-shell";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { billingPlans, isBillingConfigured } from "@/lib/billing";
import { currentCustomer } from "@/lib/customer";
import { getOrgContext } from "@/lib/org-context";
import { hasEntitlement, resolvePlan } from "@/lib/plan";
import { isSelfHost } from "@/lib/self-host";

// Plans & billing surface. Self-serve checkout + management run through Stripe's
// hosted Checkout / Customer Portal via the @better-auth/stripe plugin (see
// lib/billing.ts) — this page only decides what to offer and renders the
// buttons. Plan resolution + feature gate resolve server-side via the
// lib/plan.ts chokepoint.
//
// Three states for the plans card:
//   - self-host:        uncapped, no billing (hidden from nav; notice here).
//   - billing not set / plan_override set: current plan + "talk to us" (no
//                       self-serve — keyless dev, or a manually-managed plan).
//   - billing on:       Upgrade buttons (on free) or Manage billing (subscribed).

const SALES_EMAIL = "sales@midplane.ai";

export default async function BillingPage() {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  const { plan } = await resolvePlan();
  // Single feature-gating seam in lib/plan.ts: hasEntitlement("sso") is the
  // only SSO gate, so wiring SSO entitlement later touches that module, not
  // this page.
  const hasSso = await hasEntitlement("sso");

  const selfHost = isSelfHost();
  const billingOn = isBillingConfigured();
  // plan_override is the manual lever and beats the subscription; when set we
  // don't offer self-serve actions (they'd be overridden / confusing).
  const managedManually = Boolean(customer.planOverride);
  // customers.plan is subscription-backed; non-free ⇒ an active subscription
  // exists, so route changes/cancel through the Portal rather than a second
  // checkout.
  const hasActiveSub = customer.plan !== "free";

  let actions: React.ReactNode = null;
  if (billingOn && !selfHost && !managedManually) {
    const { orgId } = await getOrgContext();
    if (orgId) {
      const upgradePlans = hasActiveSub
        ? []
        : billingPlans().map((p) => ({ tier: p.tier, label: p.label }));
      actions = (
        <BillingActions
          orgId={orgId}
          upgradePlans={upgradePlans}
          canManage={hasActiveSub}
        />
      );
    }
  }

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
            <CardContent className="space-y-4 text-sm text-muted-foreground">
              {selfHost ? (
                <p>
                  This is a self-hosted instance — uncapped, with no billing.
                  Plans and limits apply to Midplane Cloud only.
                </p>
              ) : actions ? (
                <>
                  <p>
                    Pro and Team are billed per seat. Checkout and billing
                    management open securely on Stripe.
                  </p>
                  {actions}
                </>
              ) : managedManually ? (
                <p>
                  Your plan is managed directly by Midplane. To change it,{" "}
                  <a
                    href={`mailto:${SALES_EMAIL}`}
                    className="font-medium text-foreground underline underline-offset-2"
                  >
                    talk to us
                  </a>
                  .
                </p>
              ) : (
                <p>
                  Self-serve checkout isn&apos;t enabled on this instance. To
                  change your plan,{" "}
                  <a
                    href={`mailto:${SALES_EMAIL}`}
                    className="font-medium text-foreground underline underline-offset-2"
                  >
                    talk to us
                  </a>
                  .
                </p>
              )}
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
                  plan. Upgrade above to enable SAML projects for your
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
