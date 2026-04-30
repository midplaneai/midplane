-- ENABLE ROW LEVEL SECURITY in 0001_constraints.sql gates table access for
-- non-owners — but the migration runs as the database owner, which bypasses
-- RLS by default. Without FORCE ROW LEVEL SECURITY, every cloud-side query
-- (the dashboard, the indexer) running as the same Neon role would silently
-- read across customers.
--
-- The audit isolation E2E (e2e/audit-isolation.e2e.ts) catches this if it
-- regresses. Hand-written; registered in meta/_journal.json.

ALTER TABLE audit_events_index FORCE ROW LEVEL SECURITY;
