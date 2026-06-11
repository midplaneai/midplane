-- Connection-scoped audit. Stamp each indexed audit row with the parent
-- connection id so the audit log can filter to one connection and the
-- dashboard's per-card "last query" stat is truly per-connection (today it
-- fans in across same-named DBs — two connections each with a "main" DB
-- share a timestamp because the aggregate groups by DB name only).
--
-- The cloud indexer drains each engine container per-connection, so
-- connection_id is already in scope at the exact point it inserts audit
-- rows (writeBatch(connectionId, …)) — same as the cloud-only customer_id
-- / region fields the engine never emits. No OSS engine change, no image
-- bump.
--
-- Nullable + FK ON DELETE SET NULL (mirrors indexer_cursors.connection_id
-- from 0018): audit history MUST survive connection deletion for
-- compliance, so the row outlives the connection with connection_id
-- flipped to NULL — never CASCADE. Existing rows get NULL. The constraint
-- is created inline (Postgres auto-names it audit_events_index_connection_id_fkey),
-- the same shape 0018 used for indexer_cursors.
--
-- Partial index WHERE connection_id IS NOT NULL — the /audit connection
-- filter always supplies a concrete id and never scans the NULL bucket
-- (config events + pre-backfill rows carry NULL), so the predicate keeps
-- the index small. Mirrors the agent_name (0011) / mcp_token_id (0017)
-- partial indexes; Drizzle's index DSL can't express the WHERE, so this
-- migration owns it.
--
-- Backfill: existing query rows carry mcp_token_id, and mcp_tokens maps
-- token → connection, so we populate connection_id from that join. Config
-- events (no token) and any pre-0.6.0 rows stay NULL; new drains don't need
-- the backfill. mcp_tokens.connection_id is itself an ON DELETE CASCADE FK
-- to connections, so any still-extant token references a live connection —
-- the backfilled id can never dangle against the new FK.
--
-- Hand-written; registered in meta/_journal.json (idx 20). No snapshot file
-- (matches 0008–0019).

ALTER TABLE "audit_events_index"
  ADD COLUMN "connection_id" text
    REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint

CREATE INDEX "audit_customer_region_connection_ts_idx"
  ON "audit_events_index" ("customer_id", "region", "connection_id", "ts" DESC)
  WHERE connection_id IS NOT NULL;
--> statement-breakpoint

-- One-time backfill of historical rows from the token → connection map
-- (see header). Idempotent: re-running only touches rows still NULL.
UPDATE "audit_events_index" a
  SET connection_id = t.connection_id
  FROM "mcp_tokens" t
  WHERE a.mcp_token_id = t.id
    AND a.connection_id IS NULL;
