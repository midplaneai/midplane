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

import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// --- core --------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
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

// --- mcp plugin (OAuth 2.1 provider, shared OIDC-provider schema) ------------
//
// Backs the Better Auth `mcp` plugin (lib/auth.ts): the OAuth 2.1 / OIDC tables
// an MCP client (Claude, Cursor) drives — Dynamic Client Registration writes
// `oauthApplication`; the authorization-code+PKCE flow issues `oauthAccessToken`
// rows; `oauthConsent` records a user's grant. The plugin's internal model
// names are exactly these camelCase keys (oauthApplication / oauthAccessToken /
// oauthConsent), so the drizzleAdapter resolves them by key; columns stay
// snake_case to match the rest of the schema. DDL lives in
// migrations/0026_mcp_oauth.sql.
//
// `required` flags mirror better-auth/plugins/oidc-provider/schema: columns
// the plugin doesn't always populate (name/icon/metadata/client_secret/user_id)
// are nullable so Dynamic Client Registration can't fail on an omitted field.

export const oauthApplication = pgTable("oauth_application", {
  id: text("id").primaryKey(),
  // DCR `client_name` is optional, so this can be absent.
  name: text("name"),
  icon: text("icon"),
  // JSON-as-text bag the plugin manages.
  metadata: text("metadata"),
  clientId: text("client_id").notNull().unique(),
  // Empty string for public (PKCE) clients; a secret for confidential ones.
  clientSecret: text("client_secret"),
  redirectUrls: text("redirect_urls").notNull(),
  type: text("type").notNull(),
  disabled: boolean("disabled").notNull().default(false),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const oauthAccessToken = pgTable("oauth_access_token", {
  id: text("id").primaryKey(),
  accessToken: text("access_token").notNull().unique(),
  refreshToken: text("refresh_token").notNull().unique(),
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
  }).notNull(),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
    withTimezone: true,
  }).notNull(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthApplication.clientId, { onDelete: "cascade" }),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  // Space-separated granted scopes.
  scopes: text("scopes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const oauthConsent = pgTable("oauth_consent", {
  id: text("id").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthApplication.clientId, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  scopes: text("scopes").notNull(),
  consentGiven: boolean("consent_given").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// --- types -------------------------------------------------------------------

export type AuthUser = typeof user.$inferSelect;
export type AuthSession = typeof session.$inferSelect;
export type AuthAccount = typeof account.$inferSelect;
export type AuthOrganization = typeof organization.$inferSelect;
export type AuthMember = typeof member.$inferSelect;
export type AuthInvitation = typeof invitation.$inferSelect;
export type AuthOAuthApplication = typeof oauthApplication.$inferSelect;
export type AuthOAuthAccessToken = typeof oauthAccessToken.$inferSelect;
export type AuthOAuthConsent = typeof oauthConsent.$inferSelect;
