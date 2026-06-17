// Better Auth schema for midplane-cloud (the Clerk → Better Auth migration).
//
// These seven tables back Better Auth's core (user / session / account /
// verification) plus the `organization` plugin (organization / member /
// invitation, and the session.active_organization_id field).
//
// MAPPING RULE: the Drizzle adapter maps Better Auth's model FIELD names to
// the PROPERTY KEYS below, NOT to the SQL column names. So we keep camelCase
// keys (= Better Auth field names) while the columns stay snake_case to match
// the rest of this schema. These tables are handed to drizzleAdapter({ schema })
// in apps/web/src/lib/auth.ts.
//
// Kept in a separate module (not re-exported from the root index) so the
// generic names — user, account, member, session — don't pollute the
// `@midplane-cloud/db` surface; import them via `@midplane-cloud/db/auth-schema`.
//
// One organization == one Midplane customer (the same 1:1 invariant Clerk
// orgs held); the `customers` row links to it provider-neutrally in a later
// migration step. DDL lives in migrations/0022_better_auth.sql (hand-written,
// registered in meta/_journal.json — the drizzle-kit snapshot is frozen at
// 0006, so this schema is the read-side mirror, not the migration source).

import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// --- core --------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // @better-auth/stripe: the user's Stripe customer id. NULL for cloud orgs
  // (we bill the ORGANIZATION, not the user — see organization.stripeCustomerId
  // below) and always NULL in self-host (the stripe plugin isn't loaded). The
  // plugin's drizzle adapter still requires the field to exist on `user`.
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  // organization plugin: the org this session is currently acting as. One
  // org == one customer, so this is effectively the active tenant.
  activeOrganizationId: text("active_organization_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
  }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
    withTimezone: true,
  }),
  scope: text("scope"),
  idToken: text("id_token"),
  // Credential (email/password) hash for password accounts. NULL for OAuth.
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// --- organization plugin -----------------------------------------------------

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  // Arbitrary JSON-as-text bag Better Auth manages. We'll stash region here
  // in a later step (org metadata), distinct from the signed region cookie.
  metadata: text("metadata"),
  // @better-auth/stripe (organization mode): the org's Stripe customer id,
  // created the first time the org subscribes. One Midplane customer == one
  // organization, so billing is keyed here (customer-per-org). Always NULL in
  // self-host (the stripe plugin isn't loaded).
  stripeCustomerId: text("stripe_customer_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const member = pgTable("member", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  role: text("role"),
  status: text("status").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// --- stripe plugin -----------------------------------------------------------
//
// @better-auth/stripe's `subscription` model. The plugin owns every read/write
// here via the drizzle adapter; this declaration is the read-side mirror so the
// adapter resolves the model and our schema-shape stays honest (the migration
// 0025_stripe_billing.sql owns the DDL). Field PROPERTY KEYS are the Better Auth
// field names (camelCase); columns stay snake_case like the rest of the schema.
//
// referenceId is the Midplane orgId (customer-per-org, customerType
// "organization"). It is deliberately NOT unique and NOT a foreign key: the
// plugin reuses the same referenceId across a cancel→resubscribe cycle, and the
// column is polymorphic by design (user id in the default mode). The
// subscription is the plugin's bookkeeping; the entitlement source of truth the
// app reads is customers.plan, written from the plugin's subscription lifecycle
// hooks (see apps/web/src/lib/billing.ts).
export const subscription = pgTable(
  "subscription",
  {
    id: text("id").primaryKey(),
    // Plan name as defined in the stripe plugin config ("pro" | "team").
    plan: text("plan").notNull(),
    // The Midplane orgId this subscription belongs to. Not unique (resubscribe).
    referenceId: text("reference_id").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    // active | trialing | past_due | canceled | incomplete | ... (Stripe status).
    status: text("status").notNull().default("incomplete"),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    trialStart: timestamp("trial_start", { withTimezone: true }),
    trialEnd: timestamp("trial_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false),
    cancelAt: timestamp("cancel_at", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    seats: integer("seats"),
    billingInterval: text("billing_interval"),
    stripeScheduleId: text("stripe_schedule_id"),
  },
  (t) => ({
    referenceIdx: index("subscription_reference_id_idx").on(t.referenceId),
    stripeSubIdx: index("subscription_stripe_subscription_id_idx").on(
      t.stripeSubscriptionId,
    ),
  }),
);

// --- types -------------------------------------------------------------------

export type AuthUser = typeof user.$inferSelect;
export type AuthSession = typeof session.$inferSelect;
export type AuthAccount = typeof account.$inferSelect;
export type AuthOrganization = typeof organization.$inferSelect;
export type AuthMember = typeof member.$inferSelect;
export type AuthInvitation = typeof invitation.$inferSelect;
export type AuthSubscription = typeof subscription.$inferSelect;
