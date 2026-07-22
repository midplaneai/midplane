// Single source of truth for the OSS engine image reference.
//
// The router spawns this image per project (DockerSpawner locally,
// FlyMachineSpawner in cloud). Before the monorepo merge the tag was
// hand-copied across ~15 sites; now the TS sites import THIS constant, and
// `scripts/check-image-pin.ts` (run in CI) fails if any non-TS site (the Fly
// configs, scripts, .env examples, docs) disagrees with it.
//
// The engine still ships as its own published image referenced by tag, so the
// merge does not remove the pin — it centralizes it. Bump the version here and
// the spawners + their tests follow automatically; the drift check tells you
// which config/doc sites still need updating.
//
// NOTE: this is the human-readable TAG — the spawner fallback + dev/docs use it.
// PROD (fly-eu.toml / fly-us.toml) pins the immutable multi-arch *digest* of this
// version, which closes the tag-granular adoption-image-check gap (TODOS.md) and
// makes "prod == tested" byte-exact. Bumping the engine: change the version here,
// re-resolve the digest (`docker buildx imagetools inspect midplane/midplane:<v>
// --format '{{.Manifest.Digest}}'`), update the two fly configs, run
// scripts/check-image-pin.ts.
export const OSS_ENGINE_IMAGE = "midplane/midplane:0.15.0";

// GHCR mirror of the same engine artifact, published in lockstep by
// engine-publish.yml (same build, two tags). When MIDPLANE_ENGINE_USE_GHCR=1
// the FlyMachineSpawner rewrites the engine ref to this (via ghcrEngineRef) so
// Fly machine creates pull straight from ghcr.io instead of through Fly's Docker
// Hub pull-through mirror (docker-hub-mirror.fly.io). That mirror has run out of
// disk and 500'd on manifest writes ("no space left on device"), which surfaces
// as a 400 on machine-create and 502s the very first (cold) spawn of a project —
// the sample-DB connect path. ghcr.io is pulled directly, so it sidesteps the
// broken mirror entirely.
//
// This constant is the GHCR ref for the DEFAULT pin; the spawner preserves
// whatever tag was actually staged. Derived from OSS_ENGINE_IMAGE's tag so the
// two never drift: bump the version in one place. The GHCR org is `midplaneai`
// (the GitHub org), NOT the Docker Hub org `midplane` — spawner-fly.ts's
// normalizeImageRef treats both as the same engine so adoption/staleness don't
// churn across the source switch.
const ENGINE_VERSION = OSS_ENGINE_IMAGE.split("@")[0]!.split(":")[1]!;
export const OSS_ENGINE_IMAGE_GHCR = `ghcr.io/midplaneai/midplane:${ENGINE_VERSION}`;
