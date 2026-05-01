-- Audit mirror: capture agent identity (split into name + version) and
-- the agent's natural-language intent for each query.
--
-- Today `agent_identity` is a single text column that the OSS engine
-- always sends as NULL — nothing reads MCP `clientInfo` and stamps it
-- on emitted rows. The forthcoming OSS bump (tracked alongside this
-- migration) will populate three new fields:
--
--   agent_name      — clientInfo.name      (e.g., "claude-code")
--   agent_version   — clientInfo.version   (e.g., "0.42.1")
--   agent_intent    — free-text task description, ≤ 500 chars
--   intent_source   — which channel the intent came from
--
-- Why split name + version: every modern observability schema separates
-- them (OpenTelemetry semconv, Datadog APM, Sentry release/env). Combined
-- User-Agent-style strings kill grouping ("everything claude-code did")
-- and version filtering ("calls from < 0.40, the build with the leak").
-- MCP gives us structured data via `clientInfo: { name, version }`, so
-- there's no reason to stringly-concatenate it.
--
-- Why intent_source: the OSS reads intent from three channels in priority
-- order — MCP `_meta.intent`, SQL comment hint, HTTP header. Stamping the
-- channel on the row lets the dashboard distinguish "explicit, structured"
-- from "best-effort fallback" and nudge customers toward _meta.intent.
--
-- agent_identity stays for one release as a back-compat receiver: legacy
-- OSS images pre-bump still send it, and the indexer copies into
-- agent_name when the new fields are absent. A follow-up migration drops
-- the column once 100% of containers are on the new image.
--
-- Hand-written; registered manually in meta/_journal.json.

ALTER TABLE "audit_events_index"
  ADD COLUMN "agent_name" text,
  ADD COLUMN "agent_version" text,
  ADD COLUMN "agent_intent" text,
  ADD COLUMN "intent_source" text;
--> statement-breakpoint

ALTER TABLE "audit_events_index"
  ADD CONSTRAINT "audit_events_index_intent_source_check"
  CHECK (
    "intent_source" IS NULL
    OR "intent_source" IN ('mcp_meta', 'sql_comment', 'http_header')
  );
--> statement-breakpoint

-- Cap intent length at the database boundary too. The OSS truncates at
-- 500 before emitting; this guards against a malformed row claiming
-- otherwise.
ALTER TABLE "audit_events_index"
  ADD CONSTRAINT "audit_events_index_agent_intent_len_check"
  CHECK ("agent_intent" IS NULL OR char_length("agent_intent") <= 500);
--> statement-breakpoint

-- Filter-by-agent on the audit log: (customer, region, agent_name, ts DESC)
-- supports the forthcoming AGENT filter chip without scanning the existing
-- (customer, region, ts) index. Skipped when agent_name IS NULL — rows
-- without an identified agent don't participate in the filter and the
-- partial keeps the index small during the rollout window when most rows
-- still come back null.
CREATE INDEX "audit_customer_region_agent_ts_idx"
  ON "audit_events_index" ("customer_id", "region", "agent_name", "ts" DESC)
  WHERE "agent_name" IS NOT NULL;
