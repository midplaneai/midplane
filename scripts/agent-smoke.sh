#!/usr/bin/env bash
# Boot the production image + sidecar Postgres locally, print the three
# pasteable agent configs, then tail the audit log so you can watch your
# agent's traffic land in real time. Ctrl-C to clean up.
#
# Use case: you want to verify Cursor / Claude Code / Claude Desktop
# against a real Midplane container without standing up the hosted stack.
#
# Boot sequence (network, postgres, app, /health) is shared with
# scripts/test-image.sh via lib/image-boot.sh.

set -euo pipefail

cd "$(dirname "$0")/.."

# Friendlier names than the test-image defaults — these will show up in
# `docker ps` while the user is poking around.
export IMAGE="${IMAGE:-midplane/midplane:dev}"
export PG_NAME="${PG_NAME:-midplane-smoke-pg}"
export APP_NAME="${APP_NAME:-midplane-smoke-app}"
export NETWORK="${NETWORK:-midplane-smoke-net}"
export HOST_PORT="${HOST_PORT:-8080}"
export PG_DB="${PG_DB:-midplane_smoke}"

# shellcheck source=lib/image-boot.sh
source "$(dirname "$0")/lib/image-boot.sh"

trap cleanup_image_boot EXIT INT TERM
precleanup_image_boot

# Default: rebuild every run so a fresh checkout / branch switch is reflected
# in the verified image. The :dev tag is reused, so a stale cached image from
# a different commit would otherwise verify silently. Set MIDPLANE_REUSE_IMAGE=1
# to skip the rebuild when iterating fast on docs / scripts.
if [ "${MIDPLANE_REUSE_IMAGE:-0}" = "1" ]; then
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "[agent-smoke] MIDPLANE_REUSE_IMAGE=1 but $IMAGE not found locally; building..."
    docker build -f docker/Dockerfile -t "$IMAGE" .
    echo
  else
    echo "[agent-smoke] MIDPLANE_REUSE_IMAGE=1; reusing existing $IMAGE (no rebuild)."
    echo
  fi
else
  echo "[agent-smoke] building $IMAGE from current checkout..."
  docker build -f docker/Dockerfile -t "$IMAGE" .
  echo
fi

boot_postgres_sidecar

# Seed a tiny demo schema so list_tables / describe_table / SELECT … FROM users
# return something interesting in the agent UI. Denial paths don't depend on
# this — they fail at parse/policy time before touching Postgres.
echo "[agent-smoke] seeding demo schema (users, posts)..."
docker exec -i "$PG_NAME" psql -h 127.0.0.1 -U postgres -d "$PG_DB" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE TABLE users (
  id         serial PRIMARY KEY,
  email      text NOT NULL,
  org_id     int  NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE posts (
  id      serial PRIMARY KEY,
  user_id int  NOT NULL REFERENCES users(id),
  title   text NOT NULL,
  body    text
);
INSERT INTO users (email, org_id) VALUES
  ('alice@acme.test', 42),
  ('bob@acme.test',   99);
INSERT INTO posts (user_id, title, body) VALUES
  (1, 'hello',        'first post'),
  (2, 'no writes',    'read-only by default');
SQL

boot_midplane_app

ENDPOINT="http://localhost:$HOST_PORT/mcp"
DESKTOP_PATH='~/Library/Application Support/Claude/claude_desktop_config.json'

cat <<EOF

=============================================================
  Midplane is up at $ENDPOINT
  Audit log:    $DATA_DIR/audit.db
  Demo schema:  public.users (4 cols, 2 rows), public.posts (4 cols, 2 rows)
=============================================================

PASTE INTO YOUR AGENT
─────────────────────

Cursor  (~/.cursor/mcp.json):

  {
    "mcpServers": {
      "midplane": { "url": "$ENDPOINT" }
    }
  }

Claude Code  (CLI):

  claude mcp add --transport http midplane $ENDPOINT

Claude Desktop  ($DESKTOP_PATH):

  {
    "mcpServers": {
      "midplane": {
        "command": "npx",
        "args": ["-y", "mcp-remote", "$ENDPOINT"]
      }
    }
  }

  (Custom Connectors UI requires HTTPS and rejects http://localhost; the
   config-file shim above is the only working path for local self-host.
   Restart Claude Desktop after editing.)

─────────────────────
Tailing audit events. Run a query in your agent and watch it land here.
Ctrl-C to stop and clean up containers.

EOF

# Wait for SQLite to be created on first audit write, then poll for new rows.
LAST_ID=""
while true; do
  if [ -f "$DATA_DIR/audit.db" ]; then
    if [ -z "$LAST_ID" ]; then
      WHERE="1=1"
    else
      WHERE="id > '$LAST_ID'"
    fi
    # ULID ids sort lexicographically by creation time, so id ordering ==
    # ts ordering. Trim sql_text to keep one row per line readable.
    rows=$(sqlite3 -separator $'\t' "$DATA_DIR/audit.db" \
      "SELECT id, datetime(ts/1000, 'unixepoch'), event_type, query_id, SUBSTR(payload, 1, 200) \
       FROM audit_events WHERE $WHERE ORDER BY id;")
    if [ -n "$rows" ]; then
      echo "$rows" | while IFS=$'\t' read -r id ts event_type query_id payload; do
        printf '[%s] %-9s qid=%s %s\n' "$ts" "$event_type" "${query_id:0:8}" "$payload"
        LAST_ID="$id"
      done
      LAST_ID=$(echo "$rows" | tail -n1 | cut -f1)
    fi
  fi
  sleep 1
done
