-- Dangerous-statement guardrails (OSS 0.9.0): per-DB categorical blocks
-- that fire regardless of table_access / tenant_scope —
--
--   block_unqualified_dml   DELETE / UPDATE with no WHERE clause
--   block_ddl               DROP / TRUNCATE / ALTER (CREATE stays allowed)
--
-- Default both-on for new AND existing rows, mirroring the engine's
-- omitted-section posture ("an agent can't nuke prod" out of the box).
-- Note this is a behavior change for rows whose tables are read_write:
-- no-WHERE DML / DDL on them was previously decided by table_access alone
-- and will now deny until the owner opts out per flag.
--
-- Also admits the actor-stamped GUARDRAILS_CHANGED audit event (buckets
-- under the existing config-event lens, same as TENANT_SCOPE_CHANGED).
-- The DROP+ADD on the event_type CHECK mirrors 0019.
--
-- Hand-written; registered in meta/_journal.json.

ALTER TABLE "connection_databases"
  ADD COLUMN "guardrails" jsonb NOT NULL
  DEFAULT '{"block_unqualified_dml":true,"block_ddl":true}'::jsonb;
--> statement-breakpoint

-- Sanity CHECK: both flags present and boolean. Belt + suspenders — the
-- cloud validates every write and the OSS engine re-validates on parse;
-- this catches a future migration / backfill script that forgets a field.
-- The `?&` key-presence guard is load-bearing: `->` on a missing key
-- yields SQL NULL, jsonb_typeof(NULL) is NULL, and a CHECK evaluating to
-- NULL is SATISFIED — without `?&`, '{}' would pass and the constraint
-- wouldn't catch the exact forgotten-field case it exists for.
ALTER TABLE "connection_databases"
  ADD CONSTRAINT "connection_databases_guardrails_shape_chk"
  CHECK (
    "guardrails" ?& array['block_unqualified_dml', 'block_ddl']
    AND jsonb_typeof("guardrails" -> 'block_unqualified_dml') = 'boolean'
    AND jsonb_typeof("guardrails" -> 'block_ddl') = 'boolean'
  );
--> statement-breakpoint

ALTER TABLE "audit_events_index"
  DROP CONSTRAINT IF EXISTS "audit_events_index_event_type_check";
--> statement-breakpoint

-- NOT VALID skips re-validating existing rows. The new IN-list is a
-- strict superset of 0019's (adds only GUARDRAILS_CHANGED), so every
-- existing row is already known-valid and the full-table scan the bare
-- ADD CONSTRAINT would run — under ACCESS EXCLUSIVE on the busiest
-- write-path table — is provably redundant. New writes are checked
-- regardless. (0016/0017/0019 paid the scan; stop doing that.)
ALTER TABLE "audit_events_index"
  ADD CONSTRAINT "audit_events_index_event_type_check"
  CHECK (event_type IN (
    'ATTEMPTED',
    'DECIDED',
    'EXECUTED',
    'FAILED',
    'POLICY_RELOADED',
    'POLICY_CHANGED',
    'TENANT_SCOPE_CHANGED',
    'GUARDRAILS_CHANGED',
    'REGION_CHANGED',
    'TOKEN_CREATED',
    'TOKEN_REVOKED',
    'CONNECTION_PAUSED',
    'CONNECTION_RESUMED'
  )) NOT VALID;
