import { stripe as stripePlugin } from "@better-auth/stripe";
import { and, eq } from "drizzle-orm";
import Stripe from "stripe";

import { customers, getDb } from "@midplane-cloud/db";
import {
  member,
  organization,
  subscription as subscriptionTable,
} from "@midplane-cloud/db/auth-schema";

import { isOwnerRole } from "./org-roles.ts";
import type { Plan } from "./plan.ts";
import { bootRegion } from "./region-context.ts";
import { isSelfHost } from "./self-host.ts";

// Stripe billing wiring (open-core P3). The @better-auth/stripe plugin owns the
// hard parts — hosted Checkout, the Customer Portal, the webhook
// (/api/auth/stripe/webhook) with signature verification, and the `subscription`
// bookkeeping table. This module is the thin Midplane-specific layer around it:
//
//   - billing config gate (cloud-only, all env present) + lazy Stripe client,
//   - the plan→price map, shared by the plugin and the /billing UI,
//   - planFromSubscription(): the pure status→tier mapping (the heart of the
//     upgrade/downgrade/cancel/past_due transitions + idempotency),
//   - syncOrgPlanFromSubscription(): writes customers.plan from a subscription —
//     wired into the plugin's lifecycle hooks so the webhook is the sole writer
//     of the entitlement source of truth resolvePlan() reads,
//   - buildStripePlugins(): returns the configured plugin, or [] when billing is
//     off (self-host, or keyless dev) so those builds boot Stripe-free,
//   - reconcileOrgPlan(): the drift/backfill backstop (poll Stripe → customers.plan).
//
// Self-host NEVER loads the plugin and requires no Stripe env: isSelfHost()
// short-circuits isBillingConfigured() to false before any env read.

// --- env + client -----------------------------------------------------------

/** The four cloud-only Stripe vars. Documented in .env.example; presence is
 *  asserted in assertBootEnv ONLY when billing is meant to be on (see there). */
interface StripeEnv {
  secretKey: string;
  webhookSecret: string;
  proPriceId: string;
  teamPriceId: string;
}

type EnvLike = Record<string, string | undefined>;

function readStripeEnv(env: EnvLike = process.env): Partial<StripeEnv> {
  return {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    proPriceId: env.STRIPE_PRO_PRICE_ID,
    teamPriceId: env.STRIPE_TEAM_PRICE_ID,
  };
}

/** True when this process should run billing: the CLOUD build with all four
 *  Stripe vars set. Self-host is always false (and never reads the env), so the
 *  plugin stays unloaded and no Stripe key is required to boot. Keyless cloud
 *  dev is also false, so a laptop with no Stripe vars boots and runs the rest of
 *  the app untouched (the /billing page degrades to "talk to us"). */
export function isBillingConfigured(env: EnvLike = process.env): boolean {
  if (isSelfHost()) return false;
  const e = readStripeEnv(env);
  return Boolean(e.secretKey && e.webhookSecret && e.proPriceId && e.teamPriceId);
}

/** The validated env, or throw — only call behind isBillingConfigured(). */
function requireStripeEnv(): StripeEnv {
  const e = readStripeEnv();
  if (!e.secretKey || !e.webhookSecret || !e.proPriceId || !e.teamPriceId) {
    throw new Error(
      "Stripe billing env incomplete (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / STRIPE_PRO_PRICE_ID / STRIPE_TEAM_PRICE_ID)",
    );
  }
  return e as StripeEnv;
}

let stripeClient: Stripe | null = null;

/** The process-wide Stripe client, constructed on first use. apiVersion is left
 *  to the SDK's pinned default. Only reachable when billing is configured. */
export function getStripeClient(): Stripe {
  return (stripeClient ??= new Stripe(requireStripeEnv().secretKey));
}

// --- plan ↔ price map --------------------------------------------------------

/** The self-serve, subscription-billed tiers, in display order. `free` is the
 *  absence of a subscription (no Stripe price), so it isn't here — a downgrade
 *  flips customers.plan back to 'free'. Both tiers are flat: one fixed monthly
 *  price per org (quantity 1), independent of member count. Per-plan member caps
 *  are enforced separately via organization.membershipLimit (lib/seats.ts). */
export interface BillingPlan {
  /** Matches the lib/plan.ts Plan tier and the plugin's plan `name`. */
  tier: Exclude<Plan, "free">;
  label: string;
  priceId: string;
}

/** Built from env; only call behind isBillingConfigured(). Shared by the plugin
 *  config and the /billing UI so the tier list can't drift between them. */
export function billingPlans(): BillingPlan[] {
  const e = requireStripeEnv();
  return [
    { tier: "pro", label: "Pro", priceId: e.proPriceId },
    { tier: "team", label: "Team", priceId: e.teamPriceId },
  ];
}

// --- status → tier mapping (pure) -------------------------------------------

// Only these Stripe subscription statuses grant the paid tier. Everything else
// — past_due, canceled, unpaid, incomplete(_expired), paused — resolves to free.
// We never clawback resources on the downgrade; only new creates gate (see
// lib/plan.ts), so dropping a past_due org to free just blocks NEW projects/
// tokens until payment is fixed; existing ones keep serving.
const ENTITLED_STATUSES: ReadonlySet<string> = new Set(["active", "trialing"]);

/** Map a Stripe subscription (status + plan name) to a Midplane tier. Pure and
 *  idempotent: the same (status, planName) always yields the same tier, which is
 *  why replaying a webhook event causes no state change — the write is a
 *  state-set, not a delta. Unknown/paid-but-unentitled → 'free'. */
export function planFromSubscription(
  status: string,
  planName: string | null | undefined,
): Plan {
  if (!ENTITLED_STATUSES.has(status)) return "free";
  if (planName === "team") return "team";
  if (planName === "pro") return "pro";
  // Active subscription on an unknown plan name — fail closed to free rather
  // than guess a tier.
  return "free";
}

// --- writing customers.plan --------------------------------------------------

/** Write the resolved tier to customers.plan for an org. Idempotent state-set
 *  (UPDATE ... WHERE org_id), so a replayed event re-writes the same value with
 *  no observable change. A delivery for an org not in THIS regional DB updates
 *  zero rows — a harmless no-op (each org's customer row is region-resident). */
export async function writeOrgPlan(orgId: string, plan: Plan): Promise<void> {
  await getDb(bootRegion())
    .update(customers)
    .set({ plan })
    .where(eq(customers.orgId, orgId));
}

/** Derive the tier from a subscription and persist it to customers.plan. Wired
 *  into the plugin's create/update/cancel/delete hooks so the webhook is the
 *  sole writer. `referenceId` is the orgId (customer-per-org). */
async function syncOrgPlanFromSubscription(args: {
  referenceId: string;
  planName: string | null | undefined;
  status: string;
}): Promise<void> {
  const plan = planFromSubscription(args.status, args.planName);
  await writeOrgPlan(args.referenceId, plan);
  console.log(
    JSON.stringify({
      level: "info",
      event: "billing.plan_sync",
      orgId: args.referenceId,
      status: args.status,
      planName: args.planName ?? null,
      resolvedPlan: plan,
    }),
  );
}

// --- reconciliation / backfill ----------------------------------------------

/** Drift backstop: read the org's authoritative subscription state from the
 *  plugin's local `subscription` table and rewrite customers.plan. A future
 *  cron can sweep all customers through this to repair any webhook miss or
 *  out-of-order delivery; resolvePlan() always reads the reconciled value. We
 *  read the local table (kept current by the plugin's webhook) rather than
 *  re-listing Stripe so this stays a cheap single-DB sweep — escalate to a
 *  Stripe API list only if the local table itself is suspected stale. */
export async function reconcileOrgPlan(orgId: string): Promise<Plan> {
  const rows = await getDb(bootRegion())
    .select({
      plan: subscriptionTable.plan,
      status: subscriptionTable.status,
    })
    .from(subscriptionTable)
    .where(eq(subscriptionTable.referenceId, orgId));
  // Pick the entitled subscription if any (the plugin allows only one active/
  // trialing per referenceId), else fall through to free.
  const entitled = rows.find((r) => ENTITLED_STATUSES.has(r.status));
  const plan = entitled
    ? planFromSubscription(entitled.status, entitled.plan)
    : "free";
  await writeOrgPlan(orgId, plan);
  return plan;
}

// --- teardown ----------------------------------------------------------------

/** Cancel every live Stripe subscription for an org — called when the whole
 *  workspace is being deleted (lib/workspace.ts), so the customer stops being
 *  billed the moment their data goes away. Immediate cancellation (not
 *  cancel-at-period-end): the workspace and its data are destroyed now, so
 *  there's nothing left to keep paying for.
 *
 *  Best-effort and self-contained: a no-op when billing is off (self-host /
 *  keyless dev) or the org never subscribed (no Stripe customer). Scoped to the
 *  org's OWN stripeCustomerId, so it can only ever touch that org's
 *  subscriptions. The local `subscription` rows are deleted by the workspace
 *  teardown alongside the org; we don't wait on the cancel webhook to round-trip
 *  (the rows are about to vanish regardless). */
export async function cancelOrgSubscriptions(orgId: string): Promise<void> {
  if (!isBillingConfigured()) return;
  const orgRow = (
    await getDb(bootRegion())
      .select({ stripeCustomerId: organization.stripeCustomerId })
      .from(organization)
      .where(eq(organization.id, orgId))
      .limit(1)
  )[0];
  if (!orgRow?.stripeCustomerId) return;

  const stripe = getStripeClient();
  const subs = await stripe.subscriptions.list({
    customer: orgRow.stripeCustomerId,
    status: "all",
    limit: 100,
  });
  for (const sub of subs.data) {
    // Already-dead subscriptions can't be cancelled again — skip to avoid a
    // Stripe error. Everything still live (active/trialing/past_due/...) gets
    // cancelled immediately.
    if (sub.status === "canceled" || sub.status === "incomplete_expired") {
      continue;
    }
    await stripe.subscriptions.cancel(sub.id).catch((err) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "billing.cancel_on_teardown_failed",
          orgId,
          subscriptionId: sub.id,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    });
  }
}

// --- the plugin --------------------------------------------------------------

/** The configured @better-auth/stripe plugin, or [] when billing is off. Spread
 *  into the plugins array in lib/auth.ts AFTER organization() and BEFORE
 *  nextCookies(). Customer-per-org (organization mode), referenceId = orgId,
 *  flat per-org pricing.
 *
 *  Each plan is registered with a plain `priceId` and NO `seatPriceId`, so the
 *  plugin bills a flat, fixed-quantity (1) subscription per org — one monthly
 *  price regardless of how many members the org has. (Setting seatPriceId is what
 *  turns on the plugin's per-seat mode, where the Stripe quantity tracks the
 *  member count; we deliberately don't.) So we never pass `seats` from the client
 *  either. Per-plan MEMBER CAPS are a separate concern, enforced on the invite
 *  path via organization.membershipLimit (lib/seats.ts) with no Stripe coupling —
 *  the price is flat; the cap just bounds head count per tier.
 *
 *  Self-host / keyless dev: returns [] so the plugin never loads and no Stripe
 *  env is required to boot. */
export function buildStripePlugins(): ReturnType<typeof stripePlugin>[] {
  if (!isBillingConfigured()) return [];
  const env = requireStripeEnv();
  const plans = billingPlans();

  return [
    stripePlugin({
      stripeClient: getStripeClient(),
      stripeWebhookSecret: env.webhookSecret,
      // We bill the ORGANIZATION, not the user, and create the Stripe customer
      // lazily on first subscribe — so signup makes no Stripe call.
      createCustomerOnSignUp: false,
      organization: { enabled: true },
      subscription: {
        enabled: true,
        // Flat plans: a plain priceId with no seatPriceId bills a fixed-quantity
        // (1) subscription per org — one monthly price, member-count-independent
        // (see the doc comment above). Member caps live in lib/seats.ts.
        plans: plans.map((p) => ({
          name: p.tier,
          priceId: p.priceId,
        })),
        // Only the org's OWNER may manage its billing — admins manage the
        // workspace but not the money. referenceId is the orgId; verify the
        // acting user actually holds the owner role in the org.
        authorizeReference: async ({ user, referenceId }) => {
          const rows = await getDb(bootRegion())
            .select({ role: member.role })
            .from(member)
            .where(
              and(
                eq(member.userId, user.id),
                eq(member.organizationId, referenceId),
              ),
            );
          return isOwnerRole(rows[0]?.role);
        },
        // The four transitions that move customers.plan. Each derives the tier
        // from the subscription's current (status, plan) and writes it — see
        // syncOrgPlanFromSubscription. onSubscriptionCancel fires on the
        // pending-cancel transition while status is still active/trialing, so we
        // KEEP the tier until the subscription actually ends (deleted).
        onSubscriptionComplete: async ({ subscription, stripeSubscription }) => {
          await syncOrgPlanFromSubscription({
            referenceId: subscription.referenceId,
            planName: subscription.plan,
            status: stripeSubscription.status,
          });
        },
        onSubscriptionCreated: async ({ subscription, stripeSubscription }) => {
          await syncOrgPlanFromSubscription({
            referenceId: subscription.referenceId,
            planName: subscription.plan,
            status: stripeSubscription.status,
          });
        },
        onSubscriptionUpdate: async ({ subscription, stripeSubscription }) => {
          await syncOrgPlanFromSubscription({
            referenceId: subscription.referenceId,
            planName: subscription.plan,
            status: stripeSubscription.status,
          });
        },
        onSubscriptionCancel: async ({ subscription, stripeSubscription }) => {
          await syncOrgPlanFromSubscription({
            referenceId: subscription.referenceId,
            planName: subscription.plan,
            status: stripeSubscription.status,
          });
        },
        onSubscriptionDeleted: async ({ subscription, stripeSubscription }) => {
          await syncOrgPlanFromSubscription({
            referenceId: subscription.referenceId,
            planName: subscription.plan,
            status: stripeSubscription.status,
          });
        },
      },
    }),
  ];
}
