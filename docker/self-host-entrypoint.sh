#!/bin/sh
# Entrypoint for the self-host image (Dockerfile.self-host): apply pending
# database migrations, then hand off to the web server (the image CMD).
#
# Migrations run on every boot and are idempotent — Drizzle applies only journal
# entries newer than the last applied row. If the DB is unreachable or a
# migration fails, midplane-migrate exits non-zero and `set -e` aborts here, so
# the container fails loudly instead of serving against a half-migrated database.
set -e

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[self-host] FATAL: DATABASE_URL is not set." >&2
  echo "[self-host] Point it at your Postgres. The bundled compose sets it to the" >&2
  echo "[self-host] in-network 'postgres' service; run ./bin/self-host up to start." >&2
  exit 1
fi

echo "[self-host] applying database migrations…"
midplane-migrate
echo "[self-host] migrations OK — starting web server"

exec "$@"
