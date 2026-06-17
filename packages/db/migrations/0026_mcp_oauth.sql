-- MCP OAuth at launch (P6): the Better Auth `mcp` plugin turns the control
-- plane into an OAuth 2.1 provider for MCP clients (Claude, Cursor). This adds
-- the three OAuth/OIDC storage tables the plugin drives and extends mcp_tokens
-- so per-agent audit attribution survives the URL-token → OAuth-bearer switch.
--
-- Tables match better-auth/plugins/oidc-provider/schema (the mcp plugin reuses
-- it). Columns are snake_case to match the rest of the schema; the Drizzle
-- adapter maps the plugin's camelCase model fields to the property keys in
-- packages/db/src/auth-schema.ts, not to these column names. Like the other
-- Better Auth tables (0022) these carry NO row-level security — they're auth
-- storage, not customer-scoped tenant data.
--
-- Hand-written; registered in meta/_journal.json (idx 26). "user" is a reserved
-- word, so it's quoted in the FKs.

-- --- oauth_application: registered MCP clients (Dynamic Client Registration) ---
CREATE TABLE "oauth_application" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text,
  "icon" text,
  "metadata" text,
  "client_id" text NOT NULL,
  "client_secret" text,
  "redirect_urls" text NOT NULL,
  "type" text NOT NULL,
  "disabled" boolean NOT NULL DEFAULT false,
  "user_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "oauth_application_client_id_unique" UNIQUE ("client_id"),
  CONSTRAINT "oauth_application_user_id_user_id_fk" FOREIGN KEY ("user_id")
    REFERENCES "user"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "oauth_application_user_id_idx" ON "oauth_application" ("user_id");
--> statement-breakpoint

-- --- oauth_access_token: issued access + refresh tokens -----------------------
CREATE TABLE "oauth_access_token" (
  "id" text PRIMARY KEY NOT NULL,
  "access_token" text NOT NULL,
  "refresh_token" text NOT NULL,
  "access_token_expires_at" timestamptz NOT NULL,
  "refresh_token_expires_at" timestamptz NOT NULL,
  "client_id" text NOT NULL,
  "user_id" text,
  "scopes" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "oauth_access_token_access_token_unique" UNIQUE ("access_token"),
  CONSTRAINT "oauth_access_token_refresh_token_unique" UNIQUE ("refresh_token"),
  CONSTRAINT "oauth_access_token_client_id_fk" FOREIGN KEY ("client_id")
    REFERENCES "oauth_application"("client_id") ON DELETE cascade,
  CONSTRAINT "oauth_access_token_user_id_user_id_fk" FOREIGN KEY ("user_id")
    REFERENCES "user"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "oauth_access_token_client_id_idx"
  ON "oauth_access_token" ("client_id");
--> statement-breakpoint
CREATE INDEX "oauth_access_token_user_id_idx"
  ON "oauth_access_token" ("user_id");
--> statement-breakpoint

-- --- oauth_consent: per-(user, client) consent record -------------------------
CREATE TABLE "oauth_consent" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL,
  "user_id" text NOT NULL,
  "scopes" text NOT NULL,
  "consent_given" boolean NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "oauth_consent_client_id_fk" FOREIGN KEY ("client_id")
    REFERENCES "oauth_application"("client_id") ON DELETE cascade,
  CONSTRAINT "oauth_consent_user_id_user_id_fk" FOREIGN KEY ("user_id")
    REFERENCES "user"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "oauth_consent_client_id_idx" ON "oauth_consent" ("client_id");
--> statement-breakpoint
CREATE INDEX "oauth_consent_user_id_idx" ON "oauth_consent" ("user_id");
--> statement-breakpoint

-- --- mcp_tokens: admit OAuth attribution rows ---------------------------------
-- The OAuth bearer authenticates the agent's USER; the engine still needs a
-- stable per-agent id to stamp as mcp_token_id (audit attribution). The MCP-
-- OAuth proxy path mints exactly one attribution row per (connection, OAuth
-- client) with kind='oauth'. These carry no HMAC secret, so token_hash and
-- pepper_kid become nullable; the URL resolver (resolveByToken) keeps matching
-- only kind='url' rows. 'url' default keeps every existing row unchanged.
ALTER TABLE "mcp_tokens" ALTER COLUMN "token_hash" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_tokens" ALTER COLUMN "pepper_kid" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD COLUMN "kind" text NOT NULL DEFAULT 'url';
--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD COLUMN "client_id" text;
--> statement-breakpoint
ALTER TABLE "mcp_tokens"
  ADD CONSTRAINT "mcp_tokens_kind_check" CHECK (kind IN ('url', 'oauth'));
--> statement-breakpoint

-- One attribution row per (connection, OAuth client). The partial predicate
-- keeps the URL tokens (client_id IS NULL) out of the constraint, and makes
-- the proxy's mint-or-get idempotent under concurrent first-use.
CREATE UNIQUE INDEX "mcp_tokens_oauth_client_idx"
  ON "mcp_tokens" ("connection_id", "client_id")
  WHERE kind = 'oauth';
