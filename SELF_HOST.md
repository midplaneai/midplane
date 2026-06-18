# Self-hosting Midplane (single-tenant)

Run the Midplane control plane standalone against **one Postgres** and a local
OSS engine: keyless, uncapped, single-owner, no region routing, no cloud
vendors. Flip it on with `MIDPLANE_SELF_HOST=1`. When that flag is unset the
same codebase is the multi-tenant cloud, byte-for-byte unchanged.

## What you get

- **Uncapped core.** Unlimited connections, tokens, and seats; full audit
  history. Usage caps are a cloud-billing construct — your infra, your rules.
- **Single-owner auth.** The first email+password signup becomes the owner;
  later public signups are rejected. (Teammate invites are a planned follow-up.)
- **One database, one region.** No region picker, no subdomains, no cross-region
  routing. `getDb` ignores the region argument and returns your single
  `DATABASE_URL`; the app pins an internal region token (`eu`) for the audit
  pipeline's bookkeeping only.
- **Local encryption.** Credentials are encrypted at rest with a local AES key
  (env-mode KMS) — no AWS KMS.

SSO and the rest of the governance band stay behind the commercial `ee/` license
and are dark in the community build.

## Prerequisites

- Bun ≥ 1.3 (to run migrations, the control plane, and to compile the engine
  binary).
- Docker — **optional**. Only the bundled Postgres
  (`docker-compose.self-host.yml`) uses it; point `DATABASE_URL` at your own
  Postgres and you don't need Docker at all. The engine is **not** a container
  in self-host (see the topology section) — there is no Docker-socket
  requirement.

## 1. Configure

```bash
cp .env.self-host.example .env.self-host
# fill the three secrets:
openssl rand -base64 32   # → BETTER_AUTH_SECRET
openssl rand -hex 32      # → MIDPLANE_KMS_DEV_KEY_EU
openssl rand -base64 32   # → MIDPLANE_TOKEN_PEPPER_EU_V1
```

## 2. Database

```bash
# If host port 5432 is busy, set POSTGRES_PORT in the environment and match it
# in DATABASE_URL inside .env.self-host.
docker compose -f docker-compose.self-host.yml up -d postgres
bun run migrate:self-host          # applies Drizzle migrations to DATABASE_URL
```

## 3. Build the engine binary

The control plane exec's the compiled engine binary per connection (see the
topology section). Compile it once:

```bash
bun run build:engine-binary        # → engine/dist/midplane
```

Then point the control plane at it (or put it on `PATH` as `midplane`):

```bash
export MIDPLANE_ENGINE_BIN="$PWD/engine/dist/midplane"
```

(The containerized image below bakes this in — this step is only for the
run-on-host path.)

## 4. Run the control plane

```bash
bun --env-file=.env.self-host run dev          # http://localhost:3000
# (production: `bun --filter '@midplane-cloud/web' build` then run the standalone
#  server with the same env)
```

On boot the app validates the self-host env, seeds the implicit org + customer
the single tenant is keyed on, and starts. Visit `http://localhost:3000`, sign
up once (you're the owner), and add a connection.

## The engine topology (read this before deploying)

Per connection, the control plane **exec's the compiled `midplane server`
binary as a subprocess** (`ProcessSpawner`, selected automatically by
`MIDPLANE_SELF_HOST=1`), binds it to a loopback-only ephemeral port with that
connection's decrypted DSN, and proxies `/mcp/<token>` to `127.0.0.1:<port>`.
The engine idle-stops after 30 minutes and is torn down on connection delete.

This means self-host needs **no Docker daemon, no Docker socket, no `docker`
CLI in the image, and no host networking**. The only requirement is that the
`midplane` binary is present where the control plane runs (`MIDPLANE_ENGINE_BIN`
or on `PATH`).

> Why one process per connection: the engine binds exactly one set of databases
> for its lifetime (it reads the policy file + DSN env vars once at boot), so a
> connection gets its own engine. This is the same spawn-per-connection model
> the cloud (Fly machines) and local-dev (Docker) backends use — only the
> spawn *mechanism* differs.

Two ways to run it:

- **On the host** (steps 3–4 above): build the binary, set
  `MIDPLANE_ENGINE_BIN`, run the control plane. The supported single-box setup;
  also how local development works.
- **Fully containerized** (one image, the whole deploy): `Dockerfile.self-host`
  bundles both the control plane and the engine binary, so there is nothing to
  mount or pull:

  ```bash
  docker build -f Dockerfile.self-host -t midplane/self-host:local .
  docker run --env-file .env.self-host -p 3000:3000 midplane/self-host:local
  ```

  The binary is baked at `/usr/local/bin/midplane` (with `MIDPLANE_ENGINE_BIN`
  preset), and `MIDPLANE_SELF_HOST=1` is set in the image. This works the same
  on Linux and macOS — there is no host-networking or VM-socket caveat anymore.

The audit pipeline's internal bearer (`INDEXER_TOKEN`) is auto-provisioned at
boot when unset: the engine is loopback-only, so the token never leaves the
box, and audit reaches the dashboard out of the box without extra config.

## Verified

Run against a local Postgres on this branch:

- Migrations apply via `migrate:self-host`.
- The compiled engine binary (`bun run build:engine-binary`) boots `server`
  self-contained from a `node_modules`-free dir, becomes healthy on its loopback
  port, creates + migrates its `audit.db`, and exits cleanly on `SIGTERM` (no
  orphan).
- `e2e/audit-isolation.e2e.ts` passes in **both** modes — self-host
  (`MIDPLANE_SELF_HOST=1` + `DATABASE_URL`) and cloud (`DATABASE_URL_EU`) — the
  cross-tenant RLS/scope regression gate.
- `e2e/self-host-spawn.live.e2e.ts` (gated on `E2E_LIVE=1`) proves the full
  process-spawn path: spawn the real binary → run a query → the indexer drains
  audit into Postgres bound to the implicit customer → an RLS-scoped read
  returns real rows (guards the silent zero-rows trap).
- The implicit customer is seeded and a `SET LOCAL app.customer_id =
  <implicit id>` bind round-trips an audit row (no silent blank-log).
- Full unit suite green (incl. `ProcessSpawner`); cloud behavior unchanged when
  `MIDPLANE_SELF_HOST` is unset.

Not built in this session: the `Dockerfile.self-host` image (a full Next
standalone + engine compile). The binary-compile, boot, and process-spawn paths
it bundles are all verified above; the multi-stage image build itself is
unbuilt here.
