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

- Docker (for the bundled Postgres and the OSS engine the control plane spawns).
- Bun ≥ 1.3 (to run migrations and the control plane).

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

## 3. Run the control plane

```bash
bun --env-file=.env.self-host run dev          # http://localhost:3000
# (production: `bun --filter '@midplane-cloud/web' build` then run the standalone
#  server with the same env)
```

On boot the app validates the self-host env, seeds the implicit org + customer
the single tenant is keyed on, and starts. Visit `http://localhost:3000`, sign
up once (you're the owner), and add a connection.

## The engine topology (read this before deploying)

The control plane does **not** embed the engine. Per connection, it spawns one
OSS engine container (`MIDPLANE_OSS_IMAGE`) via the **local Docker daemon**
(`DockerSpawner`, the path used whenever `FLY_API_TOKEN` is unset) and proxies
`/mcp/<token>` to it. So wherever the control plane runs, it needs:

1. access to the Docker daemon (to `docker run` the engine), and
2. network reachability to the engine's published port (the spawner binds the
   engine to a random **host** port and connects at `127.0.0.1:<port>`).

Running the control plane **on the host** (step 3 above) satisfies both
naturally — this is the supported single-box setup and is how local development
already works.

A fully-containerized control plane (control plane itself in a container) also
needs the Docker socket mounted, the `docker` CLI in the image, and — so that
`127.0.0.1:<port>` resolves to the host's published engine ports — host
networking. That works on Linux (`network_mode: host` + `/var/run/docker.sock`);
it does **not** work cleanly on Docker Desktop for macOS, where the daemon runs
in a VM. Containerizing the control plane for a Linux host is the documented
next step; it is intentionally not the default `compose up` because it can't be
validated cross-platform here.

## Verified

Run against a local Postgres on this branch:

- Migrations apply via `migrate:self-host`.
- `e2e/audit-isolation.e2e.ts` passes in **both** modes — self-host
  (`MIDPLANE_SELF_HOST=1` + `DATABASE_URL`) and cloud (`DATABASE_URL_EU`) — the
  cross-tenant RLS/scope regression gate.
- The implicit customer is seeded and a `SET LOCAL app.customer_id =
  <implicit id>` bind round-trips an audit row (no silent blank-log).
- Full unit suite green; cloud behavior unchanged when `MIDPLANE_SELF_HOST` is
  unset.

Not yet validated here: the fully-containerized control-plane deploy shape
(needs a Linux host — see above).
