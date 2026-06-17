-- Better Auth backing tables: core (user / session / account / verification)
-- + the organization plugin (organization / member / invitation, and
-- session.active_organization_id).
--
-- Stands up the Better Auth schema for the Clerk → Better Auth migration.
-- Born-open before launch: no users yet, so these start empty and coexist
-- with the still-live Clerk path until the auth backend is swapped. One
-- organization == one Midplane customer (the 1:1 invariant Clerk orgs held);
-- the customers row links to it provider-neutrally in a later step.
--
-- Columns are snake_case to match the rest of the schema; the Drizzle adapter
-- maps Better Auth field names to schema property keys, not columns (see
-- packages/db/src/auth-schema.ts). "user" is a reserved word, so every
-- identifier is quoted.
--
-- Hand-written; registered in meta/_journal.json.

CREATE TABLE "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "email_verified" boolean NOT NULL DEFAULT false,
  "image" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_email_unique" UNIQUE ("email")
);
--> statement-breakpoint
CREATE TABLE "organization" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "logo" text,
  "metadata" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_slug_unique" UNIQUE ("slug")
);
--> statement-breakpoint
CREATE TABLE "session" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "token" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "active_organization_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "session_token_unique" UNIQUE ("token"),
  CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id")
    REFERENCES "user"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "account" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "access_token_expires_at" timestamptz,
  "refresh_token_expires_at" timestamptz,
  "scope" text,
  "id_token" text,
  "password" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id")
    REFERENCES "user"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "member" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "role" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id")
    REFERENCES "user"("id") ON DELETE cascade,
  CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id")
    REFERENCES "organization"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "invitation" (
  "id" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "inviter_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "role" text,
  "status" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id")
    REFERENCES "user"("id") ON DELETE cascade,
  CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id")
    REFERENCES "organization"("id") ON DELETE cascade
);
