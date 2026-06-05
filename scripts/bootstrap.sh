#!/usr/bin/env bash
# One-shot dev setup for midplane-cloud.
#
# Prereqs in PATH:  bun, docker, psql, neonctl, openssl
#
# What this does:
#   1. Generate KMS dev keys (one per region) if .env.local is missing them.
#   2. Create / reuse a Neon project + dev branch in eu-central-1.
#   3. Run drizzle migrations against the dev branch (handwritten 0001_constraints.sql included).
#   4. Build midplane/midplane:0.7.1 from the local OSS clone if the tag
#      isn't published yet (set OSS_REPO=/path/to/midplaneai/midplane).
#   5. Boot localhost:3000.
#
# After this finishes:
#   - Sign up via Clerk in the browser
#   - Pick a region
#   - Paste a Postgres URL
#   - Hit GET on the returned MCP URL + /health → expect 200

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.env.local"
OSS_REPO="${OSS_REPO:-/Users/dustinlange/dev/midplane}"
IMAGE_TAG="${MIDPLANE_OSS_IMAGE:-midplane/midplane:0.7.1}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "creating $ENV_FILE from .env.example"
  cp "$ROOT/.env.example" "$ENV_FILE"
fi

# 1. KMS dev keys -------------------------------------------------------------
ensure_key() {
  local var="$1"
  local current
  current="$(grep -E "^${var}=" "$ENV_FILE" | sed -E "s/^${var}=(.*)$/\1/" || true)"
  if [[ -z "$current" ]]; then
    local key
    key="$(openssl rand -hex 32)"
    # macOS sed and GNU sed differ on -i; use a tmpfile.
    awk -v var="$var" -v val="$key" '
      BEGIN { done=0 }
      $0 ~ ("^" var "=") { print var "=" val; done=1; next }
      { print }
      END { if (!done) print var "=" val }
    ' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
    echo "  $var generated"
  fi
}
ensure_key "MIDPLANE_KMS_DEV_KEY_EU"
ensure_key "MIDPLANE_KMS_DEV_KEY_US"

# 2. Neon dev branch ----------------------------------------------------------
if ! grep -qE "^DATABASE_URL_EU=postgres" "$ENV_FILE"; then
  echo "DATABASE_URL_EU not set in .env.local. Provision a Neon project at"
  echo "https://console.neon.tech (region: AWS eu-central-1) and paste its"
  echo "connection string into .env.local as DATABASE_URL_EU= before"
  echo "re-running this script. Local dev only needs the EU branch; the"
  echo "US side is exercised in production."
  exit 1
fi

# 3. Migrations ---------------------------------------------------------------
echo "running drizzle migrations against EU branch..."
bun --filter '@midplane-cloud/db' generate || true
bun --filter '@midplane-cloud/db' migrate:eu

# 4. OSS image pin ------------------------------------------------------------
if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  if [[ -d "$OSS_REPO" ]]; then
    echo "building $IMAGE_TAG from $OSS_REPO (tag not yet published)..."
    docker build -t "$IMAGE_TAG" "$OSS_REPO"
  else
    echo "warning: $IMAGE_TAG not present and OSS_REPO=$OSS_REPO does not exist."
    echo "  router /mcp/<token> proxy will not work until the image is available."
  fi
fi

# 5. Dev server ---------------------------------------------------------------
echo "booting localhost:3000..."
exec bun --filter '@midplane-cloud/web' dev
