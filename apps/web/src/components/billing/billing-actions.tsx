"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

// Self-serve billing buttons. Thin wrapper over the @better-auth/stripe client:
// "Upgrade" starts a hosted Checkout session and "Manage billing" opens the
// hosted Customer Portal — both redirect the browser to Stripe on success, so
// there's no custom checkout/portal UI to build. The server component decides
// WHICH to show (upgrade tiers when on free; manage when already subscribed) so
// we never create a second subscription for an org that already has one.
//
// customerType "organization" + referenceId = orgId: we bill the org, not the
// user. successUrl/cancelUrl/returnUrl point back at /billing. We pass no seat
// count — the plans are flat (a fixed monthly price per org, no seatPriceId), so
// there's no quantity to set; per-plan member caps are enforced separately (see
// lib/seats.ts), not through Stripe.

interface UpgradePlan {
  tier: "pro" | "team";
  label: string;
}

export function BillingActions({
  orgId,
  upgradePlans,
  canManage,
}: {
  orgId: string;
  upgradePlans: UpgradePlan[];
  canManage: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run(key: string, fn: () => Promise<{ error?: { message?: string } | null }>) {
    setError(null);
    setBusy(key);
    startTransition(async () => {
      try {
        const { error } = await fn();
        if (error) {
          setError(error.message ?? "Something went wrong. Please try again.");
          setBusy(null);
        }
        // On success the Stripe client redirects the browser to Checkout/Portal;
        // this component unmounts, so there's nothing to reset.
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong.");
        setBusy(null);
      }
    });
  }

  function upgrade(tier: "pro" | "team") {
    run(`upgrade:${tier}`, () =>
      authClient.subscription.upgrade({
        plan: tier,
        referenceId: orgId,
        customerType: "organization",
        successUrl: "/billing",
        cancelUrl: "/billing",
      }),
    );
  }

  function manage() {
    run("manage", () =>
      authClient.subscription.billingPortal({
        referenceId: orgId,
        customerType: "organization",
        returnUrl: "/billing",
      }),
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {upgradePlans.map((p) => (
          <Button
            key={p.tier}
            size="sm"
            onClick={() => upgrade(p.tier)}
            disabled={pending}
          >
            {busy === `upgrade:${p.tier}` ? "Redirecting…" : `Upgrade to ${p.label}`}
          </Button>
        ))}
        {canManage && (
          <Button
            size="sm"
            variant="secondary"
            onClick={manage}
            disabled={pending}
          >
            {busy === "manage" ? "Opening…" : "Manage billing"}
          </Button>
        )}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
