#!/usr/bin/env bash
# Day 0 spike runner. Builds the image, runs the server, runs the client, asserts.
set -e

cd "$(dirname "$0")"

IMAGE=midplane-spike:local
CONTAINER=midplane-spike-run
DATA_DIR=$(mktemp -d)

cleanup() {
  echo
  echo "[run] cleaning up..."
  docker stop "$CONTAINER" >/dev/null 2>&1 || true
  docker rm "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

echo "[run] === BUILD ==="
docker build -t "$IMAGE" .
echo
echo "[run] image size:"
docker images "$IMAGE" --format "  {{.Size}}"

echo
echo "[run] === SERVER ==="
docker run -d \
  --name "$CONTAINER" \
  -p 8080:8080 \
  -v "$DATA_DIR:/data" \
  "$IMAGE"

# Wait for /health
for i in $(seq 1 20); do
  if curl -sf http://localhost:8080/health >/dev/null; then
    echo "[run] server up after ~${i} attempt(s)"
    break
  fi
  sleep 0.5
  if [ "$i" = "20" ]; then
    echo "[run] FAIL: server didn't come up"
    docker logs "$CONTAINER"
    exit 1
  fi
done

echo
echo "[run] === CLIENT ==="
bun run client.ts

echo
echo "[run] === VERIFY SQLite WROTE ==="
sqlite3 "$DATA_DIR/audit.db" "SELECT event_type, COUNT(*) FROM audit_events GROUP BY event_type;"

echo
echo "[run] === SUCCESS ==="
