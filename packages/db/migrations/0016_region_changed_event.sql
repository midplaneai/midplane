-- Admit REGION_CHANGED to audit_events_index event_type. Cloud-emitted
-- (by the staff /admin/customer/:id/region endpoint and by the one-time
-- Clerk region backfill), carries actor_clerk_user_id so the audit log
-- answers "who changed this customer's region, and when?".
--
-- Region change in V1 is staff-only and same-region-only (cross-region
-- requires a V2 data move). The audit row sits in the customer's regional
-- Neon, alongside their other events.
--
-- DROP + ADD pattern mirrors 0015. Hand-written; registered in meta/_journal.json.

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
    'TENANT_SCOPE_CHANGED',
    'REGION_CHANGED'
  ));
