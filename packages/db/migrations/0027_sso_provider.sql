-- SSO/SAML (P5, Enterprise Edition): the Better Auth `sso` plugin
-- (@better-auth/sso) lets an organization federate sign-in to its own SAML 2.0
-- (or OIDC) identity provider. The plugin is loaded ONLY in the ee build
-- (MIDPLANE_EE=1) and the surface is gated per-org on the Team plan
-- (hasEntitlement("sso")); self-host and keyless cloud never load it. This
-- migration stands up the one storage table the plugin drives.
--
-- Fields mirror the documented `ssoProvider` model (better-auth.com/docs/plugins/
-- sso#schema). The Drizzle adapter maps the plugin's camelCase model fields to
-- the property keys in packages/db/src/auth-schema.ts, NOT to these column names;
-- columns stay snake_case to match the rest of the schema. Like the other Better
-- Auth tables (0022 / 0026) this carries NO row-level security — it's auth
-- storage keyed by user/org ids, not customer_id-scoped tenant data. SAML
-- replay protection reuses the existing `verification` table, so no extra table.
--
-- created_at/updated_at are operational columns (defaulted) — the plugin model
-- doesn't include them, and the adapter only reads/writes its own fields, so the
-- extra columns are invisible to it. domain_verified is present but unused in V1
-- (the plugin's domainVerification option is off); kept so turning it on later
-- needs no migration.
--
-- Hand-written; registered in meta/_journal.json (idx 27). "user" / "organization"
-- are quoted in the FKs.

CREATE TABLE IF NOT EXISTS "sso_provider" (
  "id" text PRIMARY KEY NOT NULL,
  "issuer" text NOT NULL,
  "domain" text NOT NULL,
  "oidc_config" text,
  "saml_config" text,
  "user_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "organization_id" text,
  "domain_verified" boolean,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sso_provider_provider_id_unique" UNIQUE ("provider_id"),
  CONSTRAINT "sso_provider_user_id_user_id_fk" FOREIGN KEY ("user_id")
    REFERENCES "user"("id") ON DELETE cascade,
  CONSTRAINT "sso_provider_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id")
    REFERENCES "organization"("id") ON DELETE cascade
);
--> statement-breakpoint
-- Sign-in matches a provider by email domain; the org-settings surface lists a
-- provider by its org. provider_id already has a unique index from the constraint.
CREATE INDEX IF NOT EXISTS "sso_provider_domain_idx" ON "sso_provider" ("domain");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sso_provider_organization_id_idx"
  ON "sso_provider" ("organization_id");
