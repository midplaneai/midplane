-- Pausable connections: a reversible kill switch. `paused_at` non-null means
-- the resolver rejects agent requests with a distinct 403 (enforced next to
-- the mcp_tokens.status='active' gate in resolveByToken) while the tokens,
-- URLs, and policy stay intact; clearing it restores service on the next
-- request. Cloud-only — the OSS engine is untouched (no image bump). Runs
-- per-region alongside every other connections-table change.
--
-- Also admits the actor-stamped CONNECTION_PAUSED / CONNECTION_RESUMED audit
-- events so the pause/resume rows persist and surface in the audit log (they
-- bucket under the existing config-event lens, same as REGION_CHANGED). The
-- DROP+ADD on the event_type CHECK mirrors 0016 / 0017.
--
-- Hand-written; registered in meta/_journal.json.

ALTER TABLE "connections" ADD COLUMN "paused_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "audit_events_index"
  DROP CONSTRAINT IF EXISTS "audit_events_index_event_type_check";
--> statement-breakpoint

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
    'REGION_CHANGED',
    'TOKEN_CREATED',
    'TOKEN_REVOKED',
    'CONNECTION_PAUSED',
    'CONNECTION_RESUMED'
  ));
