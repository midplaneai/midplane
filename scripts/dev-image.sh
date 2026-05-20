#!/usr/bin/env bash
# Build the OSS engine image locally so the router has something to spawn.
# Use this when developing against an unreleased OSS branch or when the
# published `midplane/midplane:<tag>` isn't yet on Docker Hub. Override the
# clone path with OSS_REPO; override the tag with MIDPLANE_OSS_IMAGE.

set -euo pipefail

OSS_REPO="${OSS_REPO:-/Users/dustinlange/dev/midplane}"
IMAGE_TAG="${MIDPLANE_OSS_IMAGE:-midplane/midplane:0.6.0}"

if [[ ! -d "$OSS_REPO" ]]; then
  echo "OSS repo not found at $OSS_REPO"
  echo "  set OSS_REPO=/path/to/midplaneai/midplane and re-run."
  exit 1
fi

echo "building $IMAGE_TAG from $OSS_REPO ..."
# OSS Dockerfile lives at docker/Dockerfile; build context is the repo root
# (matches the OSS publish-docker.yml workflow exactly).
docker build -t "$IMAGE_TAG" -f "$OSS_REPO/docker/Dockerfile" "$OSS_REPO"
echo "done. image: $IMAGE_TAG"
