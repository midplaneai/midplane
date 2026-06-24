"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

// Self-serve billing controls, split one-button-per-component so they can sit in
// the plan-comparison table cells (one CTA per plan column). Thin wrappers over
// the @better-auth/stripe client: "Upgrade" starts a hosted Checkout session and
// "Manage billing" opens the hosted Customer Portal — both redirect the browser
// to Stripe on success, so there's no custom checkout/portal UI to build and the
// component just shows a pending label until the redirect (or an inline error if
// the call itself fails). The server component decides WHICH button each column
// renders (upgrade on the tiers above a free org; manage on the current paid
// tier) so we never open a second checkout for an org that already subscribes.
//
// customerType "organization" + referenceId = orgId: we bill the org, not the
// user. successUrl/cancelUrl/returnUrl point back at /billing. We pass no seat
// count — the plans are flat (a fixed monthly price per org, no seatPriceId), so
// there's no quantity to set; per-plan member caps are enforced separately (see
// lib/seats.ts), not through Stripe.

function useStripeAction() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(fn: () => Promise<{ error?: { message?: string } | null }>) {
    setError(null);
    startTransition(async () => {
      try {
        const { error } = await fn();
        if (error) {
          setError(error.message ?? "Something went wrong. Please try again.");
        }
        // On success the Stripe client redirects the browser to Checkout/Portal;
        // this component unmounts, so there's nothing to reset.
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
      }
    });
  }

  return { pending, error, run };
}

function ActionError({ message }: { message: string }) {
  return <p className="text-[11px] leading-tight text-destructive">{message}</p>;
}

export function UpgradeButton({
  orgId,
  tier,
  label,
}: {
  orgId: string;
  tier: "pro" | "team";
  label: string;
}) {
  const { pending, error, run } = useStripeAction();
  return (
    <div className="flex flex-col items-center gap-1.5">
      <Button
        size="sm"
        className="w-full"
        disabled={pending}
        onClick={() =>
          run(() =>
            authClient.subscription.upgrade({
              plan: tier,
              referenceId: orgId,
              customerType: "organization",
              successUrl: "/billing",
              cancelUrl: "/billing",
            }),
          )
        }
      >
        {pending ? "Redirecting…" : `Upgrade to ${label}`}
      </Button>
      {error ? <ActionError message={error} /> : null}
    </div>
  );
}

export function ManageBillingButton({ orgId }: { orgId: string }) {
  const { pending, error, run } = useStripeAction();
  return (
    <div className="flex flex-col items-center gap-1.5">
      <Button
        size="sm"
        variant="secondary"
        className="w-full"
        disabled={pending}
        onClick={() =>
          run(() =>
            authClient.subscription.billingPortal({
              referenceId: orgId,
              customerType: "organization",
              returnUrl: "/billing",
            }),
          )
        }
      >
        {pending ? "Opening…" : "Manage billing"}
      </Button>
      {error ? <ActionError message={error} /> : null}
    </div>
  );
}
