-- Per-agent least-privilege DB scope grants (P6.1, design:
-- docs/designs/credentials-and-scope-model.md §A + §C).
--
-- The OAuth bearer / API token authenticates the agent; this side table is the
-- access boundary on top of ownership: which connection_databases an agent may
-- reach, and at what access (read | write). The proxy resolves the grant set for
-- a credential, intersects it with the connection's DBs, and injects the
-- X-Midplane-Scope session header the engine enforces (subset gate + clamp
-- read_write→read where the grant says read). Absence of a row = that DB is NOT
-- in the agent's scope.
--
-- ONE table, polymorphic subject, so OAuth and headless PAT credentials share
-- one enforcement path. Exactly one subject is set per row:
--   - OAuth interactive: (client_id, user_id) — written at consent time. The
--     consent picker chooses DBs per (signed-in user, OAuth client).
--   - Headless PAT: mcp_token_id — written at token creation in the dashboard.
-- A CHECK enforces the exactly-one invariant; two partial unique indexes keep
-- one grant per (subject, database).
--
-- Keyed by connection_database_id (NOT (connection_id, name)): it's the stable
-- spawn/DSN/audit identity (the DSN env var + X-Midplane-Token-Id attribution
-- already key on it) and it survives a DB rename. ON DELETE CASCADE so a removed
-- DB, deregistered OAuth client, deleted user, or revoked PAT drops its grants.
--
-- Like mcp_tokens (and unlike audit_events_index), this carries NO row-level
-- security — it's keyed by connection_database_id / token / user ids and every
-- read/write path is ownership-gated in app code (the proxy resolves the
-- customer first; the consent + token-creation flows act as the signed-in user).
--
-- Hand-written; registered in meta/_journal.json (idx 28). "user" is a reserved
-- word, so it's quoted in the FK.

CREATE TABLE "mcp_scope_grants" (
  "id" text PRIMARY KEY NOT NULL,
  "connection_database_id" text NOT NULL,
  -- OAuth subject: (client_id, user_id), set at consent. NULL for PAT grants.
  "client_id" text,
  "user_id" text,
  -- Headless PAT subject: the mcp_tokens row, set at token creation. NULL for
  -- OAuth grants.
  "mcp_token_id" text,
  "access" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_scope_grants_access_check" CHECK (access IN ('read', 'write')),
  -- Exactly one subject: an OAuth (client_id + user_id) grant OR a PAT
  -- (mcp_token_id) grant — never both, never neither.
  CONSTRAINT "mcp_scope_grants_subject_check" CHECK (
    (client_id IS NOT NULL AND user_id IS NOT NULL AND mcp_token_id IS NULL)
    OR (client_id IS NULL AND user_id IS NULL AND mcp_token_id IS NOT NULL)
  )
);
--> statement-breakpoint

ALTER TABLE "mcp_scope_grants"
  ADD CONSTRAINT "mcp_scope_grants_connection_database_fk"
  FOREIGN KEY ("connection_database_id") REFERENCES "connection_databases"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint

-- client_id references oauth_application.client_id (a UNIQUE non-PK column).
ALTER TABLE "mcp_scope_grants"
  ADD CONSTRAINT "mcp_scope_grants_client_id_fk"
  FOREIGN KEY ("client_id") REFERENCES "oauth_application"("client_id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint

ALTER TABLE "mcp_scope_grants"
  ADD CONSTRAINT "mcp_scope_grants_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "user"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint

ALTER TABLE "mcp_scope_grants"
  ADD CONSTRAINT "mcp_scope_grants_mcp_token_id_fk"
  FOREIGN KEY ("mcp_token_id") REFERENCES "mcp_tokens"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint

-- One OAuth grant per (client, user, database). Partial: PAT rows (mcp_token_id
-- set) are excluded so their NULL (client_id, user_id) don't all collide. The
-- (client_id, user_id) prefix also serves the proxy's per-request lookup.
CREATE UNIQUE INDEX "mcp_scope_grants_oauth_uq"
  ON "mcp_scope_grants" ("client_id", "user_id", "connection_database_id")
  WHERE mcp_token_id IS NULL;
--> statement-breakpoint

-- One PAT grant per (token, database). The mcp_token_id prefix serves the
-- proxy's per-request lookup for the headless path.
CREATE UNIQUE INDEX "mcp_scope_grants_pat_uq"
  ON "mcp_scope_grants" ("mcp_token_id", "connection_database_id")
  WHERE mcp_token_id IS NOT NULL;
--> statement-breakpoint

-- Reverse lookup by database (grant listing / cleanup); CASCADE owns delete.
CREATE INDEX "mcp_scope_grants_cdb_idx"
  ON "mcp_scope_grants" ("connection_database_id");
