-- OSS 0.5.0 strict-mode tenant_scope: replace the flat
-- `tenant_scope_mappings` Record<table,column> with a structured
-- { column, overrides, exempt } envelope on the same JSONB column.
--
-- The wire shape change matches OSS 0.5.0's POST /admin/policy parser:
--   column    = universal default tenant column (NULL = legacy mode,
--               only `overrides` are enforced)
--   overrides = per-table column overrides (renamed from `mappings`)
--   exempt    = list of tables intentionally tenant-free (audit_log,
--               regions, etc.) — required to query an unscoped table
--               under strict mode
--
-- Backfill semantics: existing maps become `overrides` with `column=NULL`
-- and `exempt=[]`, which is byte-equivalent to today's behavior — the
-- engine reads it as legacy "only listed tables checked" mode. Cloud
-- writes `column != NULL` to opt a customer into strict mode; this
-- migration does NOT flip anyone over.
--
-- Default for new rows shifts from `{}` to the empty envelope so the
-- schema CHECK below catches anyone INSERTing the legacy shape.

ALTER TABLE "connection_databases"
  ALTER COLUMN "tenant_scope_mappings" DROP DEFAULT;
--> statement-breakpoint

-- Detect a legacy flat map vs. an already-migrated envelope. An object
-- that has the `overrides` key is treated as already in the new shape
-- (idempotent re-runs are a no-op); any other object is wrapped as
-- overrides with column=NULL.
UPDATE "connection_databases"
SET "tenant_scope_mappings" = jsonb_build_object(
  'column', NULL::text,
  'overrides', "tenant_scope_mappings",
  'exempt', '[]'::jsonb
)
WHERE NOT ("tenant_scope_mappings" ? 'overrides');
--> statement-breakpoint

ALTER TABLE "connection_databases"
  ALTER COLUMN "tenant_scope_mappings"
  SET DEFAULT '{"column":null,"overrides":{},"exempt":[]}'::jsonb;
--> statement-breakpoint

-- Sanity CHECK: the three keys must be present with the expected
-- top-level types (jsonb_typeof returns null when the key is missing,
-- 'null' for explicit NULL, 'string'/'object'/'array' for content).
-- Belt + suspenders — the cloud emits the right shape, the OSS engine
-- re-validates on parse, and this constraint catches any future
-- migration / backfill script that forgets a field.
ALTER TABLE "connection_databases"
  ADD CONSTRAINT "connection_databases_tenant_scope_shape_chk"
  CHECK (
    jsonb_typeof("tenant_scope_mappings" -> 'column') IN ('null', 'string')
    AND jsonb_typeof("tenant_scope_mappings" -> 'overrides') = 'object'
    AND jsonb_typeof("tenant_scope_mappings" -> 'exempt') = 'array'
  );
