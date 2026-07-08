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

## Quick start (Docker only)

Docker is the only prerequisite — no Bun, no manual migrations, no hand-generated
secrets.

```bash
git clone https://github.com/midplaneai/midplane && cd midplane
./bin/self-host up
```

`bin/self-host up`:

1. Creates `.env.self-host` from the example and fills the three generated
   secrets (`BETTER_AUTH_SECRET`, `MIDPLANE_KMS_DEV_KEY_EU`,
   `MIDPLANE_TOKEN_PEPPER_EU_V1`) — once, then reused on every boot.
2. Brings up Postgres and the web container (`docker compose --env-file
   .env.self-host …`), which **applies migrations on boot** and serves on
   `http://localhost:3000`.

Visit `http://localhost:3000`, sign up once (you're the owner), and add a
connection. Other subcommands:

```bash
./bin/self-host down       # stop the stack (the Postgres data volume is kept)
./bin/self-host upgrade    # pull newer images and restart
```

> **Secrets are persisted, not ephemeral.** `MIDPLANE_KMS_DEV_KEY_EU` encrypts
> project DSNs at rest and `MIDPLANE_TOKEN_PEPPER_EU_V1` backs machine-token
> verification. They live in `.env.self-host` and are reused on every boot —
> regenerating either bricks every stored credential and token. Back up
> `.env.self-host` and never rotate these once data exists.

### Driving compose directly

`bin/self-host` is a thin wrapper. If you'd rather run compose yourself, always
pass `--env-file .env.self-host` — raw `docker compose` reads `.env`, so without
the flag the secrets and the `POSTGRES_PORT` override are silently ignored:

```bash
docker compose --env-file .env.self-host -f docker-compose.self-host.yml up -d --wait
docker compose --env-file .env.self-host -f docker-compose.self-host.yml down
```

The compose stack ships a published image
(`ghcr.io/midplaneai/midplane-self-host:latest`) with a `build:` fallback, so a
fork or an unpublished checkout builds `Dockerfile.self-host` locally instead.

### Migrating as a separate step (optional)

The web container migrates on boot, so you normally don't run migrations by
hand. If you want them as a discrete step, the compose file ships a one-shot
`migrate` service (behind a profile so it stays out of the default `up`):

```bash
docker compose --env-file .env.self-host -f docker-compose.self-host.yml \
  --profile migrate run --rm migrate
```

### If a host port is taken (5432 or 3000)

Both published host ports are overridable in `.env.self-host`; the containers'
internal ports are unchanged, so only the host mapping moves.

- **Postgres (5432).** Set `POSTGRES_PORT` to a free port. The web container
  reaches Postgres over the compose network regardless, so nothing else changes.
- **Web dashboard (3000).** Set `WEB_PORT` to a free port (e.g. a Next dev
  server already owns 3000). Also set `BETTER_AUTH_URL` to match — e.g.
  `WEB_PORT=3210` and `BETTER_AUTH_URL=http://localhost:3210` — so the auth
  cookies and the dashboard's displayed MCP URL point at the port you actually
  reach. `./bin/self-host up` prints the resolved URL.

Re-run `./bin/self-host up` after editing. Because the script passes
`--env-file .env.self-host`, the overrides actually take effect.

## Run from source (contributors)

The from-source path needs **Bun ≥ 1.3** and runs the app with `bun run dev`
against the compose Postgres. Install dependencies first (a fresh clone has no
`node_modules`):

```bash
bun install

# 1. Configure — copy the example (or let ./bin/self-host up fill the secrets):
cp .env.self-host.example .env.self-host
openssl rand -base64 32   # → BETTER_AUTH_SECRET
openssl rand -hex 32      # → MIDPLANE_KMS_DEV_KEY_EU
openssl rand -base64 32   # → MIDPLANE_TOKEN_PEPPER_EU_V1

# 2. Database — bring up Postgres and migrate:
docker compose --env-file .env.self-host -f docker-compose.self-host.yml up -d postgres
bun run migrate:self-host          # applies Drizzle migrations to DATABASE_URL

# 3. Engine binary — the control plane exec's it per connection (see topology):
bun run build:engine-binary        # → engine/dist/midplane
export MIDPLANE_ENGINE_BIN="$PWD/engine/dist/midplane"

# 4. Run the control plane:
bun --env-file=.env.self-host run dev          # http://localhost:3000
```

On boot the app validates the self-host env, seeds the implicit org + customer
the single tenant is keyed on, and starts.

> The from-source `DATABASE_URL` points at `localhost:${POSTGRES_PORT:-5432}`
> (the compose Postgres mapped to your host). The containerized `web` service
> ignores that and talks to the in-network `postgres` service instead — so you
> don't edit `DATABASE_URL` for the `bin/self-host` path.

## The engine topology (read this before deploying)

Per connection, the control plane **exec's the compiled `midplane server`
binary as a subprocess** (`ProcessSpawner`, selected automatically by
`MIDPLANE_SELF_HOST=1`), binds it to a loopback-only ephemeral port with that
connection's decrypted DSN, and proxies `/mcp/<token>` to `127.0.0.1:<port>`.
The engine idle-stops after 30 minutes and is torn down on connection delete.

This means self-host needs **no Docker daemon, no Docker socket, no `docker`
CLI in the image, and no host networking**. The only requirement is that the
`midplane` binary is present where the control plane runs (`MIDPLANE_ENGINE_BIN`
or on `PATH`). The self-host image bakes it at `/usr/local/bin/midplane`.

> Why one process per connection: the engine binds exactly one set of databases
> for its lifetime (it reads the policy file + DSN env vars once at boot), so a
> connection gets its own engine. This is the same spawn-per-connection model
> the cloud (Fly machines) and local-dev (Docker) backends use — only the
> spawn *mechanism* differs.

The single self-host image (`Dockerfile.self-host`) bundles both the control
plane and the engine binary — one container is the whole deploy. The compose
stack uses it; to build and run it directly, first point `DATABASE_URL` in
`.env.self-host` at a host the container can reach — `localhost` inside the
container is the container itself, so use `host.docker.internal` (Docker Desktop)
or a same-network hostname — then build and run it, reading the DSN and the
generated secrets from the env file so nothing sensitive lands on the command
line:

```bash
docker build -f Dockerfile.self-host -t midplane/self-host:local .
docker run --env-file .env.self-host -p 3000:3000 midplane/self-host:local
```

The image runs migrations on boot (its entrypoint applies Drizzle migrations to
`DATABASE_URL` before starting the web server; a failure aborts boot loudly), and
`MIDPLANE_SELF_HOST=1` + `MIDPLANE_ENGINE_BIN` are preset. The engine runs
in-container too, so the project DSNs you add in the dashboard follow the same
rule: a `localhost` Postgres on your host is `host.docker.internal` from inside
(or put the DB on the same Docker network).

The audit pipeline's internal bearer (`INDEXER_TOKEN`) is auto-provisioned at
boot when unset: the engine is loopback-only, so the token never leaves the
box, and audit reaches the dashboard out of the box without extra config.

## Just the engine (no dashboard)

The MIT query-path engine also ships on its own as the `midplane/midplane`
Docker image — the lightest install for guarding a **single** database or a CI
pipeline from a terminal, with no control plane, no dashboard, and no Postgres of
its own:

```bash
curl -O https://raw.githubusercontent.com/midplaneai/midplane/main/engine/.env.example
mv .env.example .env   # set DATABASE_URL in the file, never inline — an inline value leaks to ps/history
docker run --env-file .env -p 8080:8080 -v midplane-audit:/data midplane/midplane:latest
```

The MCP endpoint comes up at `http://localhost:8080/mcp`; point your agent at it.
Full setup — policy YAML, agent wiring, multi-database config — is in
[`engine/README.md`](./engine/README.md) and at
[midplane.ai/docs](https://midplane.ai/docs).

## Verified

Run against a local Postgres on this branch:

- The full migration chain applies on a **fresh** `postgres:16-alpine` in one
  connection (`project_databases` exists, all journaled migrations recorded) —
  gated in CI by `migrate-fresh.yml` / `scripts/check-fresh-migration.ts`.
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
