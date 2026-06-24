import { redirect } from "next/navigation";

import {
  ManageBillingButton,
  UpgradeButton,
} from "@/components/billing/billing-actions";
import { PlanComparison } from "@/components/billing/plan-comparison";
import { UsageMeter } from "@/components/billing/usage-meter";
import { PageContainer, Topbar } from "@/components/layout/app-shell";
import { RestrictedNotice } from "@/components/restricted-notice";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { getSubscriptionSummary, isBillingConfigured } from "@/lib/billing";
import { currentCustomer } from "@/lib/customer";
import { isOwner } from "@/lib/org-auth";
import { hasEntitlement, resolvePlan, type Plan } from "@/lib/plan";
import { getPlanUsage } from "@/lib/projects";
import { countOrgSeats } from "@/lib/seats";
import { isSelfHost } from "@/lib/self-host";

// Plans & billing surface. Self-serve checkout + management run through Stripe's
// hosted Checkout / Customer Portal via the @better-auth/stripe plugin (see
// lib/billing.ts) — this page only decides what to offer and renders the
// buttons. Plan resolution + feature gate resolve server-side via the
// lib/plan.ts chokepoint.
//
// Layout (cloud): a usage card (this org's consumption vs its caps) → a plans
// card (Free/Pro/Team comparison with the current tier highlighted + the
// action area) → SSO + custom cards. Invoices, receipts, and payment methods
// stay in Stripe's Customer Portal (the "Manage billing" button), so we render
// the renewal date inline but build no money-management UI of our own.
//
// Three states for the action area inside the plans card:
//   - billing on + no manual override: Upgrade buttons (on free) OR a renewal
//                       line + Manage billing (subscribed).
//   - plan_override set: plan is managed directly → "talk to us" (no self-serve,
//                       which would be overridden / confusing).
//   - billing not configured: keyless dev / unconfigured cloud → "talk to us".
// Self-host is uncapped with no billing, so it gets its own minimal surface.

const SALES_EMAIL = "sales@midplane.ai";

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function BillingPage() {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  // Billing is OWNER-ONLY — admins manage the workspace but not the money.
  // Mirror the nav (which shows Billing only to the owner) and gate the route
  // itself, since the Stripe plugin's authorizeReference only guards the
  // checkout/portal calls, not this page's plan surface.
  if (!(await isOwner())) return <RestrictedNotice label="Plans & billing" />;

  const { plan, caps } = await resolvePlan();
  // Single feature-gating seam in lib/plan.ts: hasEntitlement("sso") is the
  // only SSO gate, so wiring SSO entitlement later touches that module, not
  // this page.
  const hasSso = await hasEntitlement("sso");

  // Self-host: uncapped, no billing, no plans. Keep this surface minimal — the
  // comparison table / usage meters are a cloud-billing construct.
  if (isSelfHost()) {
    return (
      <>
        <Topbar>
          <Breadcrumb items={[{ label: "Billing" }]} />
        </Topbar>
        <PageContainer>
          <div className="mx-auto max-w-[960px]">
            <PageHeader title="Plans & billing" />
            <Card>
              <CardHeader>
                <CardTitle>plans</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                <p>
                  This is a self-hosted instance — uncapped, with no billing.
                  Plans and limits apply to Midplane Cloud only.
                </p>
              </CardContent>
            </Card>
            {ssoCard(hasSso)}
            {customCard()}
          </div>
        </PageContainer>
      </>
    );
  }

  const billingOn = isBillingConfigured();
  // plan_override is the manual lever and beats the subscription; when set we
  // don't offer self-serve actions (they'd be overridden / confusing).
  const managedManually = Boolean(customer.planOverride);
  // customers.plan is subscription-backed; non-free ⇒ an active subscription
  // exists, so route changes/cancel through the Portal rather than a second
  // checkout.
  const hasActiveSub = customer.plan !== "free";

  // Current consumption vs the active plan's caps. The numbers are advisory
  // pre-flight reads (the locked DB checks gate the actual creates/invites);
  // seats counts members + pending invites to match seatInviteBlock.
  const [usage, seats, summary] = await Promise.all([
    getPlanUsage(customer),
    countOrgSeats(customer.orgId),
    billingOn && hasActiveSub
      ? getSubscriptionSummary(customer.orgId)
      : Promise.resolve(null),
  ]);

  // Self-serve upgrade (hosted Checkout) is offered only to a free org with
  // billing configured; subscribers change/cancel through the Customer Portal
  // ("Manage billing"), and manually-managed / billing-off orgs go through sales.
  const canUpgrade = billingOn && !managedManually && !hasActiveSub;
  const canManage = billingOn && !managedManually && hasActiveSub;

  // One CTA per plan column: "Manage billing" / "current plan" on the active
  // tier, an upgrade button on the tiers above a free org, nothing otherwise.
  const ctas: Partial<Record<Plan, React.ReactNode>> = {};
  for (const p of ["free", "pro", "team"] as const) {
    if (p === plan) {
      ctas[p] = canManage ? (
        <ManageBillingButton orgId={customer.orgId} />
      ) : (
        <span className="block text-center font-mono text-[11px] lowercase tracking-[0.04em] text-subtle">
          current plan
        </span>
      );
    } else if (canUpgrade && p !== "free") {
      ctas[p] = (
        <UpgradeButton
          orgId={customer.orgId}
          tier={p}
          label={p === "pro" ? "Pro" : "Team"}
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
              <CardTitle>usage</CardTitle>
            </CardHeader>
            <CardContent>
              <UsageMeter
                rows={[
                  { label: "projects", used: usage.projects, cap: caps.projects },
                  { label: "mcp tokens", used: usage.tokens, cap: caps.tokens },
                  {
                    label: "seats",
                    used: seats.members + seats.pending,
                    cap: caps.seats,
                  },
                ]}
                retentionDays={caps.auditRetentionDays}
              />
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle>plans</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <PlanComparison currentPlan={plan} ctas={ctas} />

              <div className="border-t border-card pt-5 text-sm text-muted-foreground">
                {canUpgrade ? (
                  <p>
                    Pro and Team are billed at a flat monthly price; checkout and
                    billing management open securely on Stripe.
                  </p>
                ) : canManage ? (
                  <p>{renewalLine(summary)}</p>
                ) : managedManually ? (
                  <p>
                    Your plan is managed directly by Midplane. To change it,{" "}
                    <TalkToUs />.
                  </p>
                ) : (
                  <p>
                    Self-serve checkout isn&apos;t enabled on this instance. To
                    change your plan, <TalkToUs />.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {ssoCard(hasSso)}
          {customCard()}
        </div>
      </PageContainer>
    </>
  );
}

/** The renewal / cancellation / trial sentence for a subscribed org. Built from
 *  the local subscription bookkeeping (no Stripe call); the date is bolded only
 *  in the cancel case, which is the one the owner needs to act on. */
function renewalLine(
  summary: Awaited<ReturnType<typeof getSubscriptionSummary>>,
): React.ReactNode {
  if (summary?.status === "trialing" && summary.trialEnd) {
    return <>Your trial ends {formatDate(summary.trialEnd)}.</>;
  }
  if (summary?.cancelAtPeriodEnd && summary.currentPeriodEnd) {
    return (
      <>
        Your plan is set to cancel on{" "}
        <strong className="font-medium text-foreground">
          {formatDate(summary.currentPeriodEnd)}
        </strong>
        . You keep access until then; reactivate any time from Manage billing.
      </>
    );
  }
  if (summary?.currentPeriodEnd) {
    return <>Your plan renews on {formatDate(summary.currentPeriodEnd)}.</>;
  }
  return <>Your subscription is active. Manage it on Stripe.</>;
}

function TalkToUs() {
  return (
    <a
      href={`mailto:${SALES_EMAIL}`}
      className="font-medium text-foreground underline underline-offset-2"
    >
      talk to us
    </a>
  );
}

function ssoCard(hasSso: boolean) {
  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>single sign-on (saml)</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        {hasSso ? (
          <p>
            SSO/SAML is included on your plan. Configure your identity provider
            from your organization&apos;s security settings.
          </p>
        ) : (
          <p>
            SSO/SAML is available on the{" "}
            <strong className="font-medium text-foreground">Team</strong> plan.
            Upgrade to enable SAML projects for your organization.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function customCard() {
  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>need something custom?</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        <p>
          BYOK, a dedicated region, custom retention, or SOC 2 / HIPAA artifacts
          — <TalkToUs />.
        </p>
      </CardContent>
    </Card>
  );
}
