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
// NOTE: this is the human-readable TAG — the spawner fallback + dev/docs use it.
// PROD (fly-eu.toml / fly-us.toml) pins the immutable multi-arch *digest* of this
// version, which closes the tag-granular adoption-image-check gap (TODOS.md) and
// makes "prod == tested" byte-exact. Bumping the engine: change the version here,
// re-resolve the digest (`docker buildx imagetools inspect midplane/midplane:<v>
// --format '{{.Manifest.Digest}}'`), update the two fly configs, run
// scripts/check-image-pin.ts.
export const OSS_ENGINE_IMAGE = "midplane/midplane:0.11.0";
