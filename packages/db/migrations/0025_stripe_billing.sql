-- Stripe billing (open-core P3). Two concerns:
--
--   1. customers.plan — the SUBSCRIPTION-BACKED plan. The single source of
--      truth resolvePlan() reads when no plan_override is set; written by the
--      @better-auth/stripe subscription lifecycle hooks (lib/billing.ts) as
--      subscriptions are created / updated / canceled / deleted. Defaults to
--      'free' (no subscription). plan_override still BEATS it (the manual lever).
--      TS enum only, no DB CHECK — mirrors plan_override and region.
--
--   2. @better-auth/stripe backing schema. The plugin manages a `subscription`
--      table and a stripe_customer_id on `user` + `organization` (customer-per-
--      org billing). The plugin's drizzle adapter owns every read/write; this
--      DDL just stands the columns/table up. referenceId holds the Midplane
--      orgId and is intentionally NOT unique / NOT a foreign key: the plugin
--      reuses it across a cancel→resubscribe cycle and the column is polymorphic
--      by design (user id in the plugin's default mode). Nullable stripe_customer_id
--      on user/organization — populated lazily on first subscribe.
--
-- Self-host never loads the stripe plugin (no Stripe env required to boot), so
-- these columns stay NULL and the subscription table stays empty there.
--
-- Hand-written; registered in meta/_journal.json (idx 25).

ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "plan" text NOT NULL DEFAULT 'free';
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "stripe_customer_id" text;
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "stripe_customer_id" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscription" (
  "id" text PRIMARY KEY NOT NULL,
  "plan" text NOT NULL,
  "reference_id" text NOT NULL,
  "stripe_customer_id" text,
  "stripe_subscription_id" text,
  "status" text NOT NULL DEFAULT 'incomplete',
  "period_start" timestamptz,
  "period_end" timestamptz,
  "trial_start" timestamptz,
  "trial_end" timestamptz,
  "cancel_at_period_end" boolean DEFAULT false,
  "cancel_at" timestamptz,
  "canceled_at" timestamptz,
  "ended_at" timestamptz,
  "seats" integer,
  "billing_interval" text,
  "stripe_schedule_id" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_reference_id_idx" ON "subscription" ("reference_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_stripe_subscription_id_idx" ON "subscription" ("stripe_subscription_id");
