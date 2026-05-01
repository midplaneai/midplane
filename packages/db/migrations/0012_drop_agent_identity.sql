-- Drop legacy agent_identity column. Migration 0011 added agent_name +
-- agent_version + agent_intent + intent_source and kept this column as a
-- one-release back-compat receiver: pre-bump OSS containers were still
-- emitting `agent_identity` (always NULL in production data) and the
-- indexer copied it into agent_name when the new fields were absent.
--
-- OSS 0.3.0 drops `agent_identity` from the audit-row payload entirely
-- (in-place SQLite migration on the engine side; audit_events.schema_version
-- bumped 1→2). All cloud-spawned containers now run 0.3.0 — see the image
-- pin bump in spawner-fly.ts / spawner-docker.ts in the same change. The
-- column has therefore only ever held NULLs in our DB and is safe to drop
-- without data loss.
--
-- The indexer's writeBatch path drops the agentIdentity write in lockstep
-- with this migration; agent_name comes directly from row.agent_name with
-- no fallback. Coordinated deploy is required: cloud + OSS image roll
-- together so there is no window where the indexer would try to write a
-- column that no longer exists.
--
-- Hand-written; registered manually in meta/_journal.json.

ALTER TABLE "audit_events_index"
  DROP COLUMN "agent_identity";
