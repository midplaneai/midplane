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

interface EnsuredPrice {
  priceId: string;
  /** The product the price hangs off — needed to allow this plan as a switch
   *  target in the Customer Portal configuration (see ensurePortalConfig). */
  productId: string;
}

async function ensurePrice(plan: PlanSpec): Promise<EnsuredPrice> {
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
    return { priceId: current.id, productId: productIdOf(current.product) };
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
  return { priceId: price.id, productId: productIdOf(price.product) };
}

/** A price's `product` is a string id unless expanded; we never expand, so this
 *  just narrows the union (and fails loud if Stripe ever hands back something
 *  unexpected). */
function productIdOf(product: string | Stripe.Product | Stripe.DeletedProduct): string {
  if (typeof product === "string") return product;
  return product.id;
}

/** Allow customers to switch between the flat tiers from the Customer Portal.
 *
 *  The @better-auth/stripe plugin switches a FLAT plan (one plain priceId, no
 *  seatPriceId / lineItems) by opening a Customer Portal `subscription_update_
 *  confirm` flow, NOT a direct subscription update. That flow runs against the
 *  account's DEFAULT portal configuration, which must list each tier's product
 *  as a switch target — otherwise Stripe rejects the change with "...does not
 *  include the price in features[subscription_update][products]". We configure
 *  that here so the in-app "Upgrade to Team" button works without a manual
 *  dashboard step, and re-runs keep it in sync. One Stripe account backs all
 *  regions (shared price ids), so a single default config covers prod too. */
async function ensurePortalConfig(entries: EnsuredPrice[]): Promise<void> {
  const products = entries.map((e) => ({
    product: e.productId,
    prices: [e.priceId],
  }));

  const configs = await stripe.billingPortal.configurations.list({ limit: 100 });
  const def =
    configs.data.find((c) => c.is_default) ??
    configs.data.find((c) => c.active) ??
    null;

  if (def) {
    await stripe.billingPortal.configurations.update(def.id, {
      features: {
        subscription_update: {
          enabled: true,
          default_allowed_updates: ["price"],
          proration_behavior: "create_prorations",
          products,
        },
      },
    });
    console.error(
      `· portal: enabled plan switching on default configuration ${def.id}`,
    );
    return;
  }

  // No configuration exists yet (the portal was never opened on this account).
  // The first configuration created via the API becomes the account default —
  // which is the one the plugin uses when it opens a portal session.
  const created = await stripe.billingPortal.configurations.create({
    business_profile: { headline: "Midplane" },
    features: {
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price"],
        proration_behavior: "create_prorations",
        products,
      },
      subscription_cancel: { enabled: true },
      payment_method_update: { enabled: true },
    },
  });
  console.error(
    `· portal: created default configuration ${created.id} with plan switching enabled`,
  );
}

const lines: string[] = [];
const ensured: EnsuredPrice[] = [];
for (const plan of PLANS) {
  const price = await ensurePrice(plan);
  ensured.push(price);
  lines.push(`${plan.envVar}=${price.priceId}`);
}

// Allow Pro<->Team switching from the Customer Portal — the path the in-app
// upgrade button drives for flat plans (see ensurePortalConfig).
await ensurePortalConfig(ensured);

console.error("\nPaste these into .env.local (and set them as Fly secrets in prod):\n");
// The env lines go to stdout so `... > /tmp/stripe.env` works; logs go to stderr.
console.log(lines.join("\n"));
console.error(
  "\nAlso set STRIPE_SECRET_KEY (this key) and STRIPE_WEBHOOK_SECRET.\n" +
    "For local webhook delivery:\n" +
    "  stripe listen --forward-to localhost:3000/api/auth/stripe/webhook\n" +
    "and copy the printed whsec_... into STRIPE_WEBHOOK_SECRET.",
);
