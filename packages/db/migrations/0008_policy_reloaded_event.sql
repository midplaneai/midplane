-- Widen audit_events_index.event_type CHECK to admit POLICY_RELOADED, the
-- new event the OSS engine emits on a successful POST /admin/policy
-- hot-swap (cloud-driven via setTableAccess). Without this, the indexer's
-- INSERT path would 23514 on every successful policy hot-reload and
-- silently park the cursor.
--
-- Hand-written; registered in meta/_journal.json.

ALTER TABLE audit_events_index
  DROP CONSTRAINT IF EXISTS audit_events_index_event_type_check;
--> statement-breakpoint

ALTER TABLE audit_events_index
  ADD CONSTRAINT audit_events_index_event_type_check
  CHECK (event_type IN ('ATTEMPTED', 'DECIDED', 'EXECUTED', 'FAILED', 'POLICY_RELOADED'));
