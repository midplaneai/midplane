"use client";

import { createContext, useContext, useState, useTransition } from "react";

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
// The buttons SHARE one in-flight state through BillingActionsProvider: starting
// any action disables ALL of them (and the runner ignores a second start), so a
// user can't click Pro then Team before the first redirect lands and create two
// competing checkout sessions. Each button is a separate component, so the shared
// state has to live in context, not local useState.
//
// customerType "organization" + referenceId = orgId: we bill the org, not the
// user. successUrl/cancelUrl/returnUrl point back at /billing. We pass no seat
// count — the plans are flat (a fixed monthly price per org, no seatPriceId), so
// there's no quantity to set; per-plan member caps are enforced separately (see
// lib/seats.ts), not through Stripe.

interface BillingActionState {
  /** The action key currently redirecting to Stripe, or null when idle. While
   *  non-null EVERY billing button is disabled. */
  busy: string | null;
  /** Inline error from the last failed action, tagged with the button it
   *  belongs to so only that cell renders it. */
  error: { key: string; message: string } | null;
  run: (
    key: string,
    fn: () => Promise<{ error?: { message?: string } | null }>,
  ) => void;
}

const BillingActionContext = createContext<BillingActionState | null>(null);

export function BillingActionsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(
    null,
  );

  function run(
    key: string,
    fn: () => Promise<{ error?: { message?: string } | null }>,
  ) {
    // Guard: one billing action at a time. `disabled` already blocks the UI, but
    // this closes the click-before-rerender race so two checkout sessions can
    // never start.
    if (busy) return;
    setError(null);
    setBusy(key);
    startTransition(async () => {
      try {
        const { error } = await fn();
        if (error) {
          setError({
            key,
            message: error.message ?? "Something went wrong. Please try again.",
          });
          setBusy(null);
        }
        // On success the Stripe client redirects the browser to Checkout/Portal;
        // these components unmount, so there's nothing to reset.
      } catch (e) {
        setError({
          key,
          message: e instanceof Error ? e.message : "Something went wrong.",
        });
        setBusy(null);
      }
    });
  }

  return (
    <BillingActionContext.Provider value={{ busy, error, run }}>
      {children}
    </BillingActionContext.Provider>
  );
}

function useBillingActions(): BillingActionState {
  const ctx = useContext(BillingActionContext);
  if (!ctx) {
    throw new Error(
      "billing buttons must be rendered inside <BillingActionsProvider>",
    );
  }
  return ctx;
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
  const { busy, error, run } = useBillingActions();
  const key = `upgrade:${tier}`;
  return (
    <div className="flex flex-col items-center gap-1.5">
      <Button
        size="sm"
        className="w-full"
        disabled={busy !== null}
        onClick={() =>
          run(key, () =>
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
        {busy === key ? "Redirecting…" : `Upgrade to ${label}`}
      </Button>
      {error?.key === key ? <ActionError message={error.message} /> : null}
    </div>
  );
}

export function ManageBillingButton({ orgId }: { orgId: string }) {
  const { busy, error, run } = useBillingActions();
  const key = "manage";
  return (
    <div className="flex flex-col items-center gap-1.5">
      <Button
        size="sm"
        variant="secondary"
        className="w-full"
        disabled={busy !== null}
        onClick={() =>
          run(key, () =>
            authClient.subscription.billingPortal({
              referenceId: orgId,
              customerType: "organization",
              returnUrl: "/billing",
            }),
          )
        }
      >
        {busy === key ? "Opening…" : "Manage billing"}
      </Button>
      {error?.key === key ? <ActionError message={error.message} /> : null}
    </div>
  );
}
