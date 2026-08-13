-- Per-write-class rules: refuse / ask / allow for row changes, whole-table
-- writes, and schema changes.
--
-- The two stored configs keep their meaning — `guardrails` refuses, `approvals`
-- asks — and each grows a per-class vocabulary:
--   • guardrails.block_dml refuses row-scoped INSERT/UPDATE/DELETE. New, and
--     FALSE for every existing row: those databases were running row changes,
--     and a migration must not quietly stop them.
--   • approvals moves from one `writes` boolean to one flag per class. An
--     existing row's `writes` value is copied to all three, which is exactly
--     what that row's engine was enforcing.
--
-- The generated default statements are first; the backfill and the shape
-- constraints follow (CHECK constraints live outside the Drizzle snapshot, so
-- they are hand-written here).
ALTER TABLE "project_databases" ALTER COLUMN "guardrails" SET DEFAULT '{"block_unqualified_dml":true,"block_ddl":true,"block_dml":false}'::jsonb;--> statement-breakpoint
ALTER TABLE "project_databases" ALTER COLUMN "approvals" SET DEFAULT '{"row_changes":false,"whole_table_writes":false,"schema_changes":false,"expires_after_seconds":1800}'::jsonb;--> statement-breakpoint

-- Backfill: row changes stay allowed. `||` is a no-op for a row that somehow
-- already carries the key, so re-applying this is safe.
UPDATE "project_databases"
SET "guardrails" = "guardrails" || '{"block_dml":false}'::jsonb
WHERE NOT ("guardrails" ? 'block_dml');--> statement-breakpoint

-- Backfill: fan the single `writes` flag out to all three classes, preserving
-- the tuned expiry window. Rows already migrated (no `writes` key) are skipped.
UPDATE "project_databases"
SET "approvals" = jsonb_build_object(
  'row_changes', "approvals" -> 'writes',
  'whole_table_writes', "approvals" -> 'writes',
  'schema_changes', "approvals" -> 'writes',
  'expires_after_seconds', COALESCE("approvals" -> 'expires_after_seconds', '1800'::jsonb)
)
WHERE "approvals" ? 'writes';--> statement-breakpoint

-- Re-state the shape constraint over all three flags. Dropped and re-added
-- rather than amended because Postgres has no ALTER CONSTRAINT for a CHECK
-- expression. The backfill above guarantees every row satisfies it.
ALTER TABLE "project_databases" DROP CONSTRAINT IF EXISTS "project_databases_guardrails_shape_chk";--> statement-breakpoint
ALTER TABLE "project_databases" ADD CONSTRAINT "project_databases_guardrails_shape_chk" CHECK (
  ("guardrails" ?& ARRAY['block_unqualified_dml'::text, 'block_ddl'::text, 'block_dml'::text])
  AND jsonb_typeof("guardrails" -> 'block_unqualified_dml') = 'boolean'
  AND jsonb_typeof("guardrails" -> 'block_ddl') = 'boolean'
  AND jsonb_typeof("guardrails" -> 'block_dml') = 'boolean'
);--> statement-breakpoint

-- Same shape guarantee for approvals, which never had one. Now that the block
-- has three independent flags, a row missing one would read as "that class is
-- not held" — a silent weakening, and the one failure mode approvals cannot
-- afford. Cheaper to make it unrepresentable.
ALTER TABLE "project_databases" ADD CONSTRAINT "project_databases_approvals_shape_chk" CHECK (
  ("approvals" ?& ARRAY['row_changes'::text, 'whole_table_writes'::text, 'schema_changes'::text])
  AND jsonb_typeof("approvals" -> 'row_changes') = 'boolean'
  AND jsonb_typeof("approvals" -> 'whole_table_writes') = 'boolean'
  AND jsonb_typeof("approvals" -> 'schema_changes') = 'boolean'
);
