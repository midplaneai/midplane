#!/usr/bin/env bash
# Build the OSS engine image locally from the IN-TREE engine (engine/) so the
# router has something to spawn — use this when the published
# `midplane/midplane:<tag>` isn't on Docker Hub yet, or while iterating on the
# engine. Post-merge there is no separate clone to point at; the engine source
# lives at engine/.
#
# Override the tag with MIDPLANE_OSS_IMAGE. The default mirrors OSS_ENGINE_IMAGE
# (packages/router/src/oss-image.ts); scripts/check-image-pin.ts enforces it.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_TAG="${MIDPLANE_OSS_IMAGE:-midplane/midplane:0.15.0}"

echo "building $IMAGE_TAG from the in-tree engine (engine/docker/Dockerfile) ..."
# Build context is the repo root (the merged monorepo has one root bun.lock);
# matches engine-publish.yml and engine/scripts/test-image.sh exactly.
docker build -t "$IMAGE_TAG" -f "$REPO_ROOT/engine/docker/Dockerfile" "$REPO_ROOT"
echo "done. image: $IMAGE_TAG"
