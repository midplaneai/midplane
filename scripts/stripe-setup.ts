#!/usr/bin/env bun
// Create (or find) the Stripe TEST products + per-seat prices the cloud billing
// flow needs, and print the env lines to paste into .env.local. Idempotent:
// prices are keyed by a stable lookup_key, so re-running reuses what exists
// instead of duplicating.
//
// Usage (from repo root):
//   STRIPE_SECRET_KEY=sk_test_... bun run scripts/stripe-setup.ts
//   # or, to read it from .env.local:
//   bun --env-file=.env.local run scripts/stripe-setup.ts
//
// Refuses a live key unless STRIPE_SETUP_ALLOW_LIVE=1 — this is a TEST-mode
// bootstrap. The unit_amounts below are placeholder test prices ($/seat/month);
// adjust them in the Stripe dashboard (or here) to the real numbers. Billing is
// per-seat: the price is per seat and the seat count is the checkout quantity.

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
  /** Placeholder TEST amount in cents, per seat, per month. */
  unitAmount: number;
  envVar: string;
}

const PLANS: PlanSpec[] = [
  {
    tier: "pro",
    productName: "Midplane Pro",
    lookupKey: "midplane_pro_monthly",
    unitAmount: 2000,
    envVar: "STRIPE_PRO_PRICE_ID",
  },
  {
    tier: "team",
    productName: "Midplane Team",
    lookupKey: "midplane_team_monthly",
    unitAmount: 5000,
    envVar: "STRIPE_TEAM_PRICE_ID",
  },
];

async function ensurePrice(plan: PlanSpec): Promise<string> {
  // Reuse an existing price with this lookup key if present (idempotent re-run).
  const existing = await stripe.prices.list({
    lookup_keys: [plan.lookupKey],
    active: true,
    limit: 1,
  });
  if (existing.data[0]) {
    console.error(
      `· ${plan.tier}: reusing existing price ${existing.data[0].id} (lookup_key=${plan.lookupKey})`,
    );
    return existing.data[0].id;
  }
  // Create the product + a per-seat monthly recurring price in one call.
  const price = await stripe.prices.create({
    currency: "usd",
    unit_amount: plan.unitAmount,
    recurring: { interval: "month" },
    lookup_key: plan.lookupKey,
    product_data: { name: plan.productName },
  });
  console.error(
    `· ${plan.tier}: created price ${price.id} ($${(plan.unitAmount / 100).toFixed(2)}/seat/mo)`,
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
