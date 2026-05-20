-- mcp_url_auth_security (PR1 of N): introduce mcp_tokens — multi-token per
-- connection with prefix+CRC format, HMAC-SHA256(pepper) hashing at rest,
-- expiry, creator attribution, and revocation. The new shape replaces the
-- single plaintext mcp_token column on connections.
--
-- PR1 is strictly ADDITIVE: the new table is created and audit attribution
-- is wired, but `connections.mcp_token` stays in place and `indexer_cursors`
-- stays keyed on mcp_token. The actual drop + indexer re-key lands in PR2
-- alongside the proxy / spawner / indexer refactor that moves them onto
-- the new token model. The design doc (D5) contemplates a single
-- destructive migration, but the cloud code still threads mcpToken through
-- ~30 callers — splitting the cut avoids a typecheck-breaking intermediate
-- and keeps PR1 reviewable. The deferred drop is documented in the PR
-- summary so PR2 can pick it up.
--
-- Also note: the design sketched `connection_id text PRIMARY KEY REFERENCES
-- connections(id) ON DELETE SET NULL` on indexer_cursors, which is invalid
-- SQL (PRIMARY KEY implies NOT NULL; SET NULL would error at delete time).
-- PR2 will use a synthetic id PK + nullable connection_id with FK SET NULL
-- + partial unique index on connection_id.
--
-- Hand-written; registered in meta/_journal.json. Statements are split at
-- the breakpoint marker.

CREATE TABLE "mcp_tokens" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL,
  "name" text NOT NULL,
  "prefix" text NOT NULL,
  "last4" text NOT NULL,
  "token_hash" "bytea" NOT NULL,
  "pepper_kid" text NOT NULL,
  "created_by_user_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "last_used_ip" inet,
  "last_used_ua" text,
  "status" text DEFAULT 'active' NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_reason" text,
  CONSTRAINT "mcp_tokens_token_hash_uq" UNIQUE("token_hash"),
  CONSTRAINT "mcp_tokens_status_check"
    CHECK (status IN ('active','revoked','expired')),
  CONSTRAINT "mcp_tokens_name_per_connection_uq" UNIQUE("connection_id","name")
);
--> statement-breakpoint

ALTER TABLE "mcp_tokens"
  ADD CONSTRAINT "mcp_tokens_connection_fk"
  FOREIGN KEY ("connection_id") REFERENCES "connections"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint

CREATE INDEX "mcp_tokens_connection_status_idx"
  ON "mcp_tokens" ("connection_id", "status");
--> statement-breakpoint

-- Partial index: only `active` tokens with an expiry are interesting to
-- the sweeper (PR2). The predicate keeps the index small even on tables
-- dominated by never-expiring or already-revoked rows.
CREATE INDEX "mcp_tokens_expires_at_idx"
  ON "mcp_tokens" ("expires_at")
  WHERE expires_at IS NOT NULL AND status = 'active';
--> statement-breakpoint

-- Per-token audit attribution. PR2 wires the proxy to inject
-- X-Midplane-Token-Id and the OSS engine (lockstep change) stamps it on
-- every audit row from the session. NULL for cloud-emitted control-plane
-- events that aren't tied to a specific token, and for any in-flight
-- engine rows from before PR2 ships.
ALTER TABLE "audit_events_index"
  ADD COLUMN "mcp_token_id" text;
--> statement-breakpoint

ALTER TABLE "audit_events_index"
  ADD CONSTRAINT "audit_events_index_mcp_token_id_fk"
  FOREIGN KEY ("mcp_token_id") REFERENCES "mcp_tokens"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint

-- Compound partial index for the "show me everything token X did" view.
-- The predicate keeps the index size proportional to attributed rows
-- only, since most events in steady state will have a token_id.
CREATE INDEX "audit_customer_region_token_ts_idx"
  ON "audit_events_index" ("customer_id", "region", "mcp_token_id", "ts" DESC)
  WHERE mcp_token_id IS NOT NULL;
--> statement-breakpoint

-- Admit cloud-emitted token lifecycle events: TOKEN_CREATED on mint,
-- TOKEN_REVOKED on user-action revoke (or sweeper-driven expiry, which
-- writes the same row shape with reason='expired'). Each carries
-- actor_clerk_user_id and mcp_token_id so the audit log answers "who
-- minted/revoked which token, and when?".
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
    'TOKEN_REVOKED'
  ));
