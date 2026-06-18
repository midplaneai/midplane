#!/usr/bin/env bash
# Local end-to-end test for the production Docker image.
#
# Builds docker/Dockerfile, boots a postgres:16-alpine sidecar + the image,
# runs the MCP trial battery, asserts audit_events rows landed.
#
# CI doesn't run this — it's a free-spend local gate before opening the PR.
# CI's docker-build job covers the cheap path (build + /health only).
#
# Boot sequence (network, postgres, app, /health) is factored into
# lib/image-boot.sh and shared with scripts/agent-smoke.sh.

set -euo pipefail

# Absolute script dir, resolved BEFORE the cd below. $0 is a relative path when
# CI invokes this as `bash engine/scripts/test-image.sh` from the repo root, so
# sourcing via "$(dirname "$0")/..." AFTER cd'ing would look under the new cwd
# (engine/) and miss. Capturing the absolute dir first makes the source robust
# to the invocation directory.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

# shellcheck source=lib/image-boot.sh
source "$SCRIPT_DIR/lib/image-boot.sh"

trap cleanup_image_boot EXIT
precleanup_image_boot

# Build context is the REPO ROOT: the merged monorepo has one root bun.lock and
# `bun install --frozen-lockfile` needs every workspace manifest present.
REPO_ROOT="$(cd .. && pwd)"
echo "[test-image] === BUILD (compiled binary, repo-root context) ==="
docker build -f "$REPO_ROOT/engine/docker/Dockerfile" -t "$IMAGE" "$REPO_ROOT"
echo
echo "[test-image] image size:"
docker images "$IMAGE" --format "  {{.Size}}"
echo

boot_postgres_sidecar
boot_midplane_app

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
