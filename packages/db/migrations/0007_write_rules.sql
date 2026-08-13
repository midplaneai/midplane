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
--     what that row's engine was enforcing. `writes` is KEPT alongside them
--     (expand/contract) so a rollback to pre-split app code still reads the
--     right posture instead of "no approvals".
--
-- The generated default statements are first; the backfill and the shape
-- constraints follow (CHECK constraints live outside the Drizzle snapshot, so
-- they are hand-written here).
ALTER TABLE "project_databases" ALTER COLUMN "guardrails" SET DEFAULT '{"block_unqualified_dml":true,"block_ddl":true,"block_dml":false}'::jsonb;--> statement-breakpoint
ALTER TABLE "project_databases" ALTER COLUMN "approvals" SET DEFAULT '{"row_changes":false,"whole_table_writes":false,"schema_changes":false,"expires_after_seconds":1800,"writes":false}'::jsonb;--> statement-breakpoint

-- Backfill: row changes stay allowed. `||` is a no-op for a row that somehow
-- already carries the key, so re-applying this is safe.
UPDATE "project_databases"
SET "guardrails" = "guardrails" || '{"block_dml":false}'::jsonb
WHERE NOT ("guardrails" ? 'block_dml');--> statement-breakpoint

-- Backfill: fan the single `writes` flag out to all three classes, preserving
-- the tuned expiry window.
--
-- EXPAND, not replace: `writes` is KEPT alongside the class keys. This is the
-- expand half of expand/contract, and it is what makes a rollback safe — an app
-- version that predates the split reads only `writes`, so dropping it here
-- would leave a rolled-back deployment reading "no approvals" and running
-- writes that had been held. New code prefers the class keys and only falls
-- back to `writes` when they are absent, so carrying both is unambiguous.
-- A later release contracts it away once no rollback target reads it.
UPDATE "project_databases"
SET "approvals" = "approvals" || jsonb_build_object(
  'row_changes', "approvals" -> 'writes',
  'whole_table_writes', "approvals" -> 'writes',
  'schema_changes', "approvals" -> 'writes',
  'expires_after_seconds', COALESCE("approvals" -> 'expires_after_seconds', '1800'::jsonb)
)
WHERE "approvals" ? 'writes'
  AND NOT ("approvals" ? 'row_changes');--> statement-breakpoint

-- Rows that somehow carry the class keys but no `writes` (e.g. written by new
-- code between this migration's two halves) get the mirror derived back.
UPDATE "project_databases"
SET "approvals" = "approvals" || jsonb_build_object(
  'writes',
  to_jsonb(
    ("approvals" -> 'row_changes')::boolean
    OR ("approvals" -> 'whole_table_writes')::boolean
    OR ("approvals" -> 'schema_changes')::boolean
  )
)
WHERE ("approvals" ? 'row_changes') AND NOT ("approvals" ? 'writes');--> statement-breakpoint

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
--
-- The legacy branch is the other half of expand/contract: during a rolling
-- deploy an old instance can still write `{writes, expires_after_seconds}`, and
-- rejecting that would 500 its save rather than degrade. Either shape is
-- readable — new code seeds the classes from `writes` when they're absent — so
-- accepting both is safe for the compatibility window. The contract migration
-- drops the legacy branch.
ALTER TABLE "project_databases" ADD CONSTRAINT "project_databases_approvals_shape_chk" CHECK (
  (
    ("approvals" ?& ARRAY['row_changes'::text, 'whole_table_writes'::text, 'schema_changes'::text])
    AND jsonb_typeof("approvals" -> 'row_changes') = 'boolean'
    AND jsonb_typeof("approvals" -> 'whole_table_writes') = 'boolean'
    AND jsonb_typeof("approvals" -> 'schema_changes') = 'boolean'
  )
  OR (
    ("approvals" ? 'writes') AND jsonb_typeof("approvals" -> 'writes') = 'boolean'
  )
);
