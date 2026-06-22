#!/usr/bin/env bun
// Create (or find) the Stripe TEST products + flat monthly prices the cloud
// billing flow needs, and print the env lines to paste into .env.local.
// Idempotent: a re-run reuses the existing price when its amount/currency/
// interval still match. If the amount changed (Stripe prices are immutable), it
// mints a corrected price and transfers the stable lookup_key onto it, so a
// stale price from an earlier run never silently pins the old number.
//
// Usage (from repo root):
//   STRIPE_SECRET_KEY=sk_test_... bun run scripts/stripe-setup.ts
//   # or, to read it from .env.local:
//   bun --env-file=.env.local run scripts/stripe-setup.ts
//
// Refuses a live key unless STRIPE_SETUP_ALLOW_LIVE=1 — this is a TEST-mode
// bootstrap. The unit_amounts below mirror the PRICING.md flat prices ($49 Pro,
// $399 Team); adjust them in the Stripe dashboard (or here) to the real numbers.
// Billing is FLAT: each price is a plain monthly recurring price registered with
// no seatPriceId, so the @better-auth/stripe plugin bills one fixed-quantity (1)
// subscription per org regardless of member count (see apps/web/src/lib/billing.ts).

import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("STRIPE_SECRET_KEY is not set. See the usage header.");
  process.exit(1);
}
const isTestKey = key.includes("_test_");
if (!isTestKey && process.env.STRIPE_SETUP_ALLOW_LIVE !== "1") {
  console.error(
    "Refusing to run: STRIPE_SECRET_KEY is not a test key. This script is a\n" +
      "TEST-mode bootstrap. Set STRIPE_SETUP_ALLOW_LIVE=1 to override (you almost\n" +
      "certainly do not want to).",
  );
  process.exit(1);
}

const stripe = new Stripe(key);

interface PlanSpec {
  /** Matches the lib/plan.ts tier + the @better-auth/stripe plan name. */
  tier: "pro" | "team";
  productName: string;
  lookupKey: string;
  /** Flat monthly amount in cents (per org, member-count-independent). */
  unitAmount: number;
  envVar: string;
}

const PLANS: PlanSpec[] = [
  {
    tier: "pro",
    productName: "Midplane Pro",
    lookupKey: "midplane_pro_monthly",
    unitAmount: 4900,
    envVar: "STRIPE_PRO_PRICE_ID",
  },
  {
    tier: "team",
    productName: "Midplane Team",
    lookupKey: "midplane_team_monthly",
    unitAmount: 39900,
    envVar: "STRIPE_TEAM_PRICE_ID",
  },
];

async function ensurePrice(plan: PlanSpec): Promise<string> {
  // Find the current active price for this stable lookup key. Stripe prices are
  // IMMUTABLE — unit_amount/currency/interval can't be edited after creation —
  // so we may only REUSE one whose numbers already match the spec. Reusing by
  // lookup key alone would silently pin a stale price (e.g. the old $20/$50
  // per-seat amounts) and never apply a changed unit_amount.
  const existing = await stripe.prices.list({
    lookup_keys: [plan.lookupKey],
    active: true,
    limit: 1,
  });
  const current = existing.data[0];
  if (
    current &&
    current.unit_amount === plan.unitAmount &&
    current.currency === "usd" &&
    current.recurring?.interval === "month"
  ) {
    console.error(
      `· ${plan.tier}: reusing existing price ${current.id} ($${(plan.unitAmount / 100).toFixed(2)}/mo, lookup_key=${plan.lookupKey})`,
    );
    return current.id;
  }

  // No price yet, or the existing one is stale. Mint a fresh one;
  // transfer_lookup_key moves the stable key OFF the stale price onto this one
  // (deactivating the old), so the next run's active-lookup query resolves to
  // the corrected price and the env var below points at the right ID. Reuse the
  // existing product when replacing, so re-runs don't pile up duplicate products.
  const productRef =
    current && typeof current.product === "string"
      ? { product: current.product }
      : { product_data: { name: plan.productName } };
  const params: Stripe.PriceCreateParams = {
    currency: "usd",
    unit_amount: plan.unitAmount,
    recurring: { interval: "month" },
    lookup_key: plan.lookupKey,
    transfer_lookup_key: Boolean(current),
    ...productRef,
  };
  const price = await stripe.prices.create(params);
  console.error(
    current
      ? `· ${plan.tier}: replaced stale price → ${price.id} ($${(plan.unitAmount / 100).toFixed(2)}/mo); transferred lookup_key=${plan.lookupKey}`
      : `· ${plan.tier}: created price ${price.id} ($${(plan.unitAmount / 100).toFixed(2)}/mo)`,
  );
  return price.id;
}

const lines: string[] = [];
for (const plan of PLANS) {
  const priceId = await ensurePrice(plan);
  lines.push(`${plan.envVar}=${priceId}`);
}

console.error("\nPaste these into .env.local (and set them as Fly secrets in prod):\n");
// The env lines go to stdout so `... > /tmp/stripe.env` works; logs go to stderr.
console.log(lines.join("\n"));
console.error(
  "\nAlso set STRIPE_SECRET_KEY (this key) and STRIPE_WEBHOOK_SECRET.\n" +
    "For local webhook delivery:\n" +
    "  stripe listen --forward-to localhost:3000/api/auth/stripe/webhook\n" +
    "and copy the printed whsec_... into STRIPE_WEBHOOK_SECRET.",
);
