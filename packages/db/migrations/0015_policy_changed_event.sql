-- Admit cloud-emitted audit events: POLICY_CHANGED (counterpart to the
-- engine's POLICY_RELOADED) and TENANT_SCOPE_CHANGED. The dashboard
-- writes one of these directly into audit_events_index whenever
-- setTableAccess / setTenantScope succeeds — each carries
-- actor_clerk_user_id so the audit log answers "who changed the
-- policy?" / "who reconfigured tenant isolation?" without needing the
-- OSS engine to thread an actor through /admin/policy.
--
-- Two events per hot-reload by design:
--   - POLICY_CHANGED / TENANT_SCOPE_CHANGED (cloud, with actor) — intent + identity
--   - POLICY_RELOADED                        (engine, no actor)  — engine-side confirmation
--
-- Hand-written; registered in meta/_journal.json.

ALTER TABLE audit_events_index
  DROP CONSTRAINT IF EXISTS audit_events_index_event_type_check;
--> statement-breakpoint

ALTER TABLE audit_events_index
  ADD CONSTRAINT audit_events_index_event_type_check
  CHECK (event_type IN (
    'ATTEMPTED',
    'DECIDED',
    'EXECUTED',
    'FAILED',
    'POLICY_RELOADED',
    'POLICY_CHANGED',
    'TENANT_SCOPE_CHANGED'
  ));
