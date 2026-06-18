// Single source of truth for the OSS engine image reference.
//
// The router spawns this image per connection (DockerSpawner locally,
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
// NOTE: this is the human-readable TAG. Pinning prod by immutable digest
// (`midplane/midplane:<tag>@sha256:...`) is a tracked follow-up — it also closes
// the tag-granular adoption-image-check gap (TODOS.md). See the P7 plan 5b#2.
export const OSS_ENGINE_IMAGE = "midplane/midplane:0.9.0";
