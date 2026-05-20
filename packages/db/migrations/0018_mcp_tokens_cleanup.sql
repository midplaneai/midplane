-- mcp_url_auth_security (PR2): drop the legacy single-token column on
-- connections and re-key indexer_cursors onto connection_id.
--
-- PR1 was deliberately additive so PR2 could pick up the destructive
-- cleanup as part of the proxy/spawner/indexer cutover. After this
-- migration:
--   - connections.mcp_token is gone (the new mcp_tokens table is the
--     source of truth, multi-token per connection, hashed at rest).
--   - indexer_cursors is keyed on a synthetic ULID with a nullable
--     connection_id FK ON DELETE SET NULL — so a cursor row outlives
--     its connection while the engine drains a backlog, then a future
--     sweeper deletes orphan cursors. The partial unique index keeps
--     "one active cursor per connection" while allowing many orphan
--     cursors (NULL connection_id) to coexist.
--
-- The design doc originally sketched `connection_id text PRIMARY KEY
-- REFERENCES connections(id) ON DELETE SET NULL` which is invalid
-- (PRIMARY KEY implies NOT NULL; SET NULL would error). The corrected
-- shape below is the synthetic id PK + nullable connection_id FK +
-- partial unique index.
--
-- Pre-launch wipe (D5): there are no production rows to migrate.
-- Dev/staging Neon DBs are wiped; any local connection needs to be
-- re-created after deploy. The codebase has no real customers yet.
--
-- Hand-written; registered in meta/_journal.json. Statements are split
-- at the breakpoint marker.

ALTER TABLE "connections" DROP COLUMN "mcp_token";
--> statement-breakpoint

ALTER TABLE "indexer_cursors" DROP CONSTRAINT "indexer_cursors_pkey";
--> statement-breakpoint

ALTER TABLE "indexer_cursors" DROP COLUMN "mcp_token";
--> statement-breakpoint

-- Synthetic ULID PK; new cursor rows get a ulid() at insert time. The
-- previous schema used the plaintext token as PK; now the token doesn't
-- exist on the row at all (audit attribution flows from the OSS engine
-- via mcp_token_id on audit_events_index, not from the cursor table).
ALTER TABLE "indexer_cursors"
  ADD COLUMN "id" text PRIMARY KEY;
--> statement-breakpoint

-- Nullable connection_id with FK ON DELETE SET NULL: when the connection
-- is hard-deleted, the cursor row's connection_id flips to NULL and the
-- row lingers until the indexer finishes draining the engine's backlog
-- and a future sweeper cleans it up. The cursor never holds a dangling
-- FK reference; orphan rows are tolerated by design.
ALTER TABLE "indexer_cursors"
  ADD COLUMN "connection_id" text
    REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint

-- Partial unique index: "one active cursor per connection." Orphan
-- cursors (NULL connection_id) are exempt from the constraint, so any
-- number of in-flight drains for deleted connections can coexist
-- without colliding on the live cursor for a still-extant connection.
CREATE UNIQUE INDEX "indexer_cursors_connection_id_uq"
  ON "indexer_cursors" ("connection_id")
  WHERE connection_id IS NOT NULL;
