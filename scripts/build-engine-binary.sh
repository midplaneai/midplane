#!/usr/bin/env bash
# Compile the self-contained engine binary for self-host process-spawn.
#
# In self-host (MIDPLANE_SELF_HOST=1) the control plane exec's `midplane server`
# as a subprocess per project (ProcessSpawner) — no Docker daemon. This
# produces the binary it spawns. Point ProcessSpawner at it with
# MIDPLANE_ENGINE_BIN, or put it on PATH as `midplane`.
#
#   bun run build:engine-binary                 # → engine/dist/midplane
#   MIDPLANE_ENGINE_BIN="$PWD/engine/dist/midplane" bun --env-file=.env.self-host run dev
#
# The compiled binary embeds the libpg-query WASM's *path* (baked __dirname),
# not the bytes — see engine/docker/Dockerfile. When you build AND run on the
# same host, that baked path is this repo's real node_modules/libpg-query/wasm,
# which already holds the asset, so a host binary runs as-is with no copy. The
# self-host *image* (Dockerfile.self-host) handles the cross-filesystem case by
# shipping that one .wasm at the baked path.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$REPO_ROOT/engine/dist/midplane}"

mkdir -p "$(dirname "$OUT")"
cd "$REPO_ROOT"

echo "compiling engine binary → $OUT"
bun build --compile ./engine/packages/mcp-server/src/cli.ts --outfile "$OUT"
echo "done. run it: $OUT --version"
