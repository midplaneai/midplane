-- Midplane V1 audit log schema (locked 2026-04-29 from /plan-eng-review T2 + Day 0 spike).
-- Append-only events. Same shape on SQLite (local durable buffer / self-host) and Postgres (hosted index).
-- Year-2 hash-chain compliance fields are forward-compatible (added later as nullable columns).

-- ============================================================================
-- LOCAL SQLite — running inside each Midplane process via bun:sqlite
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_events (
  id              TEXT    PRIMARY KEY,           -- ULID; sortable by creation time
  query_id        TEXT    NOT NULL,              -- ULID; groups all events of one query
  tenant_id       TEXT    NOT NULL,              -- '__self_host__' for OSS, customer ULID for hosted
  database        TEXT    NOT NULL DEFAULT '__default__', -- DB name from `databases:` YAML or '__default__' for legacy single-DB
  agent_name      TEXT,                          -- MCP clientInfo.name (e.g. "claude-code"); NULL for non-MCP callers
  agent_version   TEXT,                          -- MCP clientInfo.version (e.g. "0.42.1"); NULL for non-MCP callers
  agent_intent    TEXT,                          -- per-call free-text task description (≤ 500 chars); required tool arg on `query`, NULL on schema-browsing tools and POLICY_RELOADED
  mcp_token_id    TEXT,                          -- cloud-injected ULID identifying the MCP token that initialized this session (`X-Midplane-Token-Id` header at MCP initialize). NULL when the header was absent or malformed, and on all non-MCP callers (admin endpoints, audit pull, POLICY_RELOADED).
  ts              INTEGER NOT NULL,              -- ms epoch (use unixepoch * 1000 for ts in Postgres mirror)
  event_type      TEXT    NOT NULL,              -- ATTEMPTED | DECIDED | EXECUTED | FAILED | POLICY_RELOADED
  payload         TEXT    NOT NULL,              -- JSON; shape determined by event_type (see audit-types.ts)
  schema_version  INTEGER NOT NULL DEFAULT 3     -- bump on row-shape break; indexer reads multiple versions. v1: pre-0.3 (no agent_*/intent fields). v2: 0.3.x (agent_name+version+intent+intent_source). v3: 0.4.x (intent_source dropped, single structured intent arg). The 0.6.0 mcp_token_id addition is additive-nullable — no schema_version bump, v3 readers ignore the extra column.
  -- Hash-chain extension (added in V2 for compliance buyer):
  -- prev_hash    TEXT,                           -- SHA-256 of previous row's (id || payload)
  -- signature    TEXT                            -- HMAC-SHA-256 of (id || prev_hash || payload) with per-tenant key
);

CREATE INDEX IF NOT EXISTS idx_audit_query_id   ON audit_events(query_id);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_ts  ON audit_events(tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_type_ts    ON audit_events(event_type, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_db_ts      ON audit_events(database, ts DESC);

-- WAL mode for concurrent reads while a single writer commits. Single writer per Midplane
-- process is the audit pipeline; the indexer (or local read tooling) is the only reader.
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;        -- WAL mode makes NORMAL safe; FULL adds latency without durability gain
PRAGMA foreign_keys = OFF;          -- no FKs; relations are by query_id convention only
PRAGMA temp_store = MEMORY;

-- ============================================================================
-- HOSTED Postgres mirror — Neon multi-AZ. Same schema + customer_id + indexes.
-- Engine writes to Postgres synchronously (per eng review T5 write-through).
-- SQLite is the local fallback queue when Postgres is unavailable.
-- ============================================================================

-- (run in cloud DB)
-- CREATE TABLE audit_events_index (
--   id              TEXT        PRIMARY KEY,
--   customer_id     TEXT        NOT NULL,            -- Midplane customer (ULID); not the same as tenant_id
--   tenant_id       TEXT        NOT NULL,            -- customer's internal tenant scope (e.g. their org_id)
--   database        TEXT        NOT NULL DEFAULT '__default__',  -- DB name from `databases:` YAML
--   query_id        TEXT        NOT NULL,
--   agent_name      TEXT,                            -- MCP clientInfo.name
--   agent_version   TEXT,                            -- MCP clientInfo.version
--   agent_intent    TEXT,                            -- per-call task description (≤ 500 chars)
--   mcp_token_id    TEXT,                            -- ULID identifying the cloud-issued MCP token this session was opened with (cloud-side FK to mcp_tokens). NULL on non-MCP callers + POLICY_RELOADED.
--   ts              TIMESTAMPTZ NOT NULL,
--   event_type      TEXT        NOT NULL CHECK (event_type IN ('ATTEMPTED','DECIDED','EXECUTED','FAILED','POLICY_RELOADED')),
--   payload         JSONB       NOT NULL,
--   schema_version  INTEGER     NOT NULL DEFAULT 3
-- );
-- CREATE INDEX ON audit_events_index (customer_id, ts DESC);
-- CREATE INDEX ON audit_events_index (customer_id, event_type, ts DESC);
-- CREATE INDEX ON audit_events_index (query_id);
-- CREATE INDEX ON audit_events_index (customer_id, agent_name, ts DESC);  -- group/filter by agent in the audit UI
-- CREATE INDEX ON audit_events_index ((payload->>'sql_fingerprint')) WHERE event_type = 'ATTEMPTED';
-- ALTER TABLE audit_events_index ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY tenant_isolation ON audit_events_index USING (customer_id = current_setting('app.customer_id'));

-- ============================================================================
-- Retention (V1: simple eligibility flag in SQLite; deletion via daily cron).
-- ============================================================================

-- Retention policy (Free tier): SQLite rows eligible for delete after Postgres ack + 24h grace.
-- Hosted Free retains 7 days in Postgres; Pro 90 days; Team 1 year.
-- Daily VACUUM at 03:00 UTC.
-- Implementation: a `retention_eligible_at` column added in V1.5 if needed; for V1, derive from ts.
