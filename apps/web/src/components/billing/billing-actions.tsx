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
// renders (an upgrade button on the tiers ABOVE the current plan; manage on the
// current paid tier). For an org that already subscribes the "upgrade" is a
// SWITCH: the page passes the current Stripe subscription id, which the plugin
// requires to move the existing subscription to the new tier rather than open a
// second one and double-bill (the @better-auth/stripe contract). A free org
// passes no id, so the same button starts a fresh hosted Checkout.
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
          // Log the real error for debugging; show the user a sanitized line
          // (the upstream message can carry Stripe/account internals).
          console.error(`[billing] action "${key}" failed:`, error);
          setError({ key, message: friendlyBillingError(key) });
          setBusy(null);
        }
        // On success the Stripe client redirects the browser to Checkout/Portal;
        // these components unmount, so there's nothing to reset.
      } catch (e) {
        console.error(`[billing] action "${key}" threw:`, e);
        setError({ key, message: friendlyBillingError(key) });
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

/** The customer-facing message for a failed billing action. We deliberately do
 *  NOT surface the upstream (Stripe / plugin) error text: it leaks internals
 *  like portal-configuration ids, price ids, and subscription-item ids, which
 *  read as unprofessional at best and aid probing at worst. The raw error is
 *  logged to the console instead, so it's still there for debugging. Keyed off
 *  the action so the copy points at the right thing. */
function friendlyBillingError(key: string): string {
  if (key.startsWith("upgrade")) {
    return "We couldn't start that plan change. Please try again — if it keeps happening, contact support.";
  }
  return "We couldn't open billing. Please try again — if it keeps happening, contact support.";
}

function ActionError({ message }: { message: string }) {
  return <p className="text-[11px] leading-tight text-destructive">{message}</p>;
}

export function UpgradeButton({
  orgId,
  tier,
  label,
  subscriptionId,
}: {
  orgId: string;
  tier: "pro" | "team";
  label: string;
  /** The org's current Stripe subscription id, when it already subscribes. Its
   *  presence flips this from a fresh Checkout into a tier SWITCH — the plugin
   *  needs it to move the existing subscription instead of double-billing.
   *  Omitted (undefined) for a free org. */
  subscriptionId?: string;
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
              // Switch the existing subscription when one exists; start a fresh
              // Checkout otherwise. Passing this for a subscribed org is what
              // stops the plugin opening a second, parallel subscription.
              ...(subscriptionId ? { subscriptionId } : {}),
              // successUrl/cancelUrl drive the fresh-Checkout path (free org).
              // The SWITCH path runs through the Customer Portal update flow,
              // which returns to `returnUrl` (defaulting to "/" → dashboard), so
              // both must point at /billing to land back here either way.
              successUrl: "/billing",
              cancelUrl: "/billing",
              returnUrl: "/billing",
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
        variant="outline"
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
