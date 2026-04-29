#!/usr/bin/env bash
# Local end-to-end test for the production Docker image.
#
# Mirrors examples/smoketest/run.sh shape, but exercises the real V1 stack:
#   1. Build docker/Dockerfile
#   2. Boot a postgres:16-alpine sidecar on a private network
#   3. Boot midplaneai/midplane against the sidecar with a mounted /data volume
#   4. Wait for /health
#   5. Run the MCP trial battery (scripts/test-image-client.ts)
#   6. Assert audit_events rows > 0 in the host-side audit.db
#
# CI doesn't run this — it's a free-spend local gate before opening the PR.
# CI's docker-build job covers the cheap path (build + /health only).

set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE=midplaneai/midplane:dev
PG_NAME=midplane-test-pg
APP_NAME=midplane-test-app
NETWORK=midplane-test-net
DATA_DIR=$(mktemp -d -t midplane-test-data.XXXXXX)
HOST_PORT=18080
PG_PASSWORD=midplane_test

cleanup() {
  echo
  echo "[test-image] cleaning up..."
  docker stop "$APP_NAME" >/dev/null 2>&1 || true
  docker rm   "$APP_NAME" >/dev/null 2>&1 || true
  docker stop "$PG_NAME"  >/dev/null 2>&1 || true
  docker rm   "$PG_NAME"  >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

# Pre-clean in case a previous run left stragglers.
docker rm -f "$APP_NAME" "$PG_NAME" >/dev/null 2>&1 || true
docker network rm "$NETWORK" >/dev/null 2>&1 || true

echo "[test-image] === BUILD ==="
docker build -f docker/Dockerfile -t "$IMAGE" .

echo
echo "[test-image] image size:"
docker images "$IMAGE" --format "  {{.Size}}"

echo
echo "[test-image] === NETWORK + POSTGRES SIDECAR ==="
docker network create "$NETWORK" >/dev/null

docker run -d \
  --name "$PG_NAME" \
  --network "$NETWORK" \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -e POSTGRES_DB=midplane_test \
  postgres:16-alpine >/dev/null

echo "[test-image] waiting for postgres..."
for i in $(seq 1 30); do
  if docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1; then
    echo "  ready after ${i} attempt(s)"
    break
  fi
  sleep 0.5
  if [ "$i" = "30" ]; then
    echo "[test-image] FAIL: postgres didn't become ready"
    docker logs "$PG_NAME" | tail -40
    exit 1
  fi
done

echo
echo "[test-image] === MIDPLANE APP ==="
docker run -d \
  --name "$APP_NAME" \
  --network "$NETWORK" \
  -p "$HOST_PORT:8080" \
  -v "$DATA_DIR:/data" \
  -e DATABASE_URL="postgres://postgres:$PG_PASSWORD@$PG_NAME:5432/midplane_test" \
  "$IMAGE" >/dev/null

echo "[test-image] waiting for /health..."
for i in $(seq 1 60); do
  if curl -sf "http://localhost:$HOST_PORT/health" >/dev/null 2>&1; then
    echo "  up after ${i} attempt(s)"
    break
  fi
  sleep 0.25
  if [ "$i" = "60" ]; then
    echo "[test-image] FAIL: /health didn't come up"
    docker logs "$APP_NAME" | tail -40
    exit 1
  fi
done

echo
echo "[test-image] === MCP TRIAL BATTERY ==="
# The client lives inside packages/mcp-server because that's the workspace
# where @modelcontextprotocol/sdk is a declared dependency — bun's isolated
# install layout means the SDK only resolves from there, not from the repo root.
SERVER_URL="http://localhost:$HOST_PORT/mcp" bun run packages/mcp-server/test-image-client.ts

echo
echo "[test-image] === AUDIT VOLUME ==="
ls -la "$DATA_DIR"
if [ ! -f "$DATA_DIR/audit.db" ]; then
  echo "[test-image] FAIL: $DATA_DIR/audit.db not found"
  exit 1
fi
COUNT=$(sqlite3 "$DATA_DIR/audit.db" "SELECT COUNT(*) FROM audit_events;")
echo "[test-image] audit_events rows: $COUNT"
sqlite3 "$DATA_DIR/audit.db" "SELECT event_type, COUNT(*) FROM audit_events GROUP BY event_type;"
if [ "$COUNT" -lt 1 ]; then
  echo "[test-image] FAIL: expected audit rows > 0"
  exit 1
fi

echo
echo "[test-image] === SUCCESS ==="
