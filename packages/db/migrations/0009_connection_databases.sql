-- Multi-DB support: split per-credential state into a child table so one
-- connection (= one MCP token / URL) can front N Postgres DBs through the
-- OSS 0.2.0 native multi-DB engine. Pre-launch destructive migration —
-- existing rows are migrated 1:1 with child name='main' and the moved
-- columns are dropped from connections in the same migration.
--
-- Hand-written; registered manually in meta/_journal.json. Statements are
-- split at the breakpoint marker.

CREATE TABLE "connection_databases" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL,
  "name" text NOT NULL,
  "encrypted_dsn" "bytea" NOT NULL,
  "kms_key_id" text NOT NULL,
  "table_access" jsonb DEFAULT '{"default":"deny","tables":{}}'::jsonb NOT NULL,
  "tenant_scope_mappings" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "rotated_at" timestamp with time zone,
  "last_kms_success_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "connection_databases_connection_name_uq" UNIQUE("connection_id","name")
);
--> statement-breakpoint

ALTER TABLE "connection_databases"
  ADD CONSTRAINT "connection_databases_connection_fk"
  FOREIGN KEY ("connection_id") REFERENCES "connections"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint

CREATE INDEX "connection_databases_connection_id_idx"
  ON "connection_databases" ("connection_id");
--> statement-breakpoint

-- Backfill: one child row per existing connection, name='main', credentials
-- copied verbatim. The child id is generated as 32-char uppercase hex
-- (gen_random_uuid stripped of dashes, then uppercased) so it does not
-- collide with the parent ULID and — critically — matches the OSS
-- env-interpolation regex [A-Z_][A-Z0-9_]*. The cloud spawner derives
-- MIDPLANE_DSN_<id> env vars from this id and references them in YAML
-- via ${...}; lowercase letters or hyphens (i.e. raw UUIDs) would fail
-- to substitute on engine boot and brick the migrated connection. New
-- rows created in TS code use ulid() which is also regex-safe; the
-- column is text and nothing parses the specific format.
INSERT INTO "connection_databases" (
  "id",
  "connection_id",
  "name",
  "encrypted_dsn",
  "kms_key_id",
  "table_access",
  "tenant_scope_mappings",
  "rotated_at",
  "last_kms_success_at",
  "created_at"
)
SELECT
  upper(replace(gen_random_uuid()::text, '-', '')),
  "id",
  'main',
  "encrypted_dsn",
  "kms_key_id",
  "table_access",
  '{}'::jsonb,
  "rotated_at",
  "last_kms_success_at",
  "created_at"
FROM "connections";
--> statement-breakpoint

-- Drop moved columns from connections. The parent now holds only identity
-- (id, customer_id, region, name, mcp_token, created_at).
ALTER TABLE "connections" DROP COLUMN "encrypted_dsn";
--> statement-breakpoint
ALTER TABLE "connections" DROP COLUMN "kms_key_id";
--> statement-breakpoint
ALTER TABLE "connections" DROP COLUMN "rotated_at";
--> statement-breakpoint
ALTER TABLE "connections" DROP COLUMN "last_kms_success_at";
--> statement-breakpoint
ALTER TABLE "connections" DROP COLUMN "table_access";
