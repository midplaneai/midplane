-- Audit mirror: stamp each indexed row with the OSS-side database name so
-- the dashboard can filter audit events by DB. Single-DB connections (and
-- pre-multi-DB rows already in Postgres) get 'main' via the column default.
-- The OSS 0.2.0 audit pull endpoint sends `database` per-row when the
-- engine is configured with a `databases:` block; the cloud indexer
-- defaults to 'main' on rows that omit it (legacy single-DB containers).
--
-- Composite index on (customer_id, region, database, ts DESC) supports the
-- forthcoming "filter by DB" UI without scanning the existing
-- (customer_id, region, ts) index for a per-DB subset.
--
-- Hand-written; registered manually in meta/_journal.json.

ALTER TABLE "audit_events_index"
  ADD COLUMN "database" text DEFAULT 'main' NOT NULL;
--> statement-breakpoint

CREATE INDEX "audit_customer_region_database_ts_idx"
  ON "audit_events_index" ("customer_id", "region", "database", "ts" DESC);
