# Shared boot sequence for the production Midplane image with a sidecar
# Postgres. Sourced by scripts/test-image.sh (CI-shaped) and
# scripts/agent-smoke.sh (interactive). Not executable on its own.
#
# Callers may override these env vars before sourcing; defaults below.

: "${IMAGE:=midplane/midplane:dev}"
: "${PG_NAME:=midplane-test-pg}"
: "${APP_NAME:=midplane-test-app}"
: "${NETWORK:=midplane-test-net}"
: "${HOST_PORT:=18080}"
: "${PG_PASSWORD:=midplane_test}"
: "${PG_DB:=midplane_test}"
: "${DATA_DIR:=}"

# Caller may pre-set DATA_DIR; otherwise we mint one. We track ownership
# so cleanup_image_boot only rm -rf's directories the helper created.
# Pre-supplied paths (e.g. a persistent audit volume) are never deleted.
if [ -z "$DATA_DIR" ]; then
  DATA_DIR=$(mktemp -d -t midplane-image-boot.XXXXXX)
  __IMAGE_BOOT_OWNS_DATA_DIR=1
else
  __IMAGE_BOOT_OWNS_DATA_DIR=0
fi
export IMAGE PG_NAME APP_NAME NETWORK HOST_PORT PG_PASSWORD PG_DB DATA_DIR

cleanup_image_boot() {
  echo
  echo "[image-boot] cleaning up..."
  docker stop "$APP_NAME" >/dev/null 2>&1 || true
  docker rm   "$APP_NAME" >/dev/null 2>&1 || true
  docker stop "$PG_NAME"  >/dev/null 2>&1 || true
  docker rm   "$PG_NAME"  >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  if [ "${__IMAGE_BOOT_OWNS_DATA_DIR:-0}" = "1" ]; then
    rm -rf "$DATA_DIR"
  else
    echo "[image-boot] preserving DATA_DIR=$DATA_DIR (caller-supplied)"
  fi
}

precleanup_image_boot() {
  docker rm -f "$APP_NAME" "$PG_NAME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}

boot_postgres_sidecar() {
  echo "[image-boot] === NETWORK + POSTGRES SIDECAR ==="
  docker network create "$NETWORK" >/dev/null

  docker run -d \
    --name "$PG_NAME" \
    --network "$NETWORK" \
    -e POSTGRES_PASSWORD="$PG_PASSWORD" \
    -e POSTGRES_DB="$PG_DB" \
    postgres:16-alpine >/dev/null

  echo "[image-boot] waiting for postgres..."
  # -h 127.0.0.1 forces a TCP probe. Without it, pg_isready hits the unix
  # socket and returns 0 against the init-phase local-only server that the
  # postgres docker-entrypoint runs during initdb / setup scripts. The real
  # network listener starts only after that init phase ends, so the unix-
  # socket check races with anything that connects via TCP.
  for i in $(seq 1 60); do
    if docker exec "$PG_NAME" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
      echo "  ready after ${i} attempt(s)"
      return 0
    fi
    sleep 0.5
  done
  echo "[image-boot] FAIL: postgres didn't become ready"
  docker logs "$PG_NAME" | tail -40
  return 1
}

boot_midplane_app() {
  echo
  echo "[image-boot] === MIDPLANE APP ==="
  docker run -d \
    --name "$APP_NAME" \
    --network "$NETWORK" \
    -p "$HOST_PORT:8080" \
    -v "$DATA_DIR:/data" \
    -e DATABASE_URL="postgres://postgres:$PG_PASSWORD@$PG_NAME:5432/$PG_DB" \
    "$IMAGE" >/dev/null

  echo "[image-boot] waiting for /health..."
  for i in $(seq 1 60); do
    if curl -sf "http://localhost:$HOST_PORT/health" >/dev/null 2>&1; then
      echo "  up after ${i} attempt(s)"
      return 0
    fi
    sleep 0.25
  done
  echo "[image-boot] FAIL: /health didn't come up"
  docker logs "$APP_NAME" | tail -40
  return 1
}
