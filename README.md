# midplane-cloud

Hosted Midplane. Sign up via Clerk, paste a Postgres URL, get an MCP endpoint that runs the locked OSS engine (`midplane/midplane`) with your encrypted credentials.

This repo CONSUMES the OSS image; it never reimplements the engine. Hosted/self-host parity is mechanically enforced by spawning the same Docker image self-host users run.

## Layout

```
apps/web              Next.js dashboard + Clerk auth + connections API
packages/db           Drizzle schema (customers, connections, audit_events_index)
packages/kms          encryptDsn / decryptDsn (env-mode dev, AWS KMS prod)
packages/router       Hosted MCP request handler — token → connection → Fly app
fly-fra.toml          Frankfurt regional MCP runtime app
scripts/bootstrap.sh  One-shot dev setup
```

Multi-region is V1, not V1.5. Schema and URL format are multi-region from day one. Bootstrap deploys `fra` (eu-central-1) only; `iad` (us-east-2) is provisioned in the V1 launch session as pure deploy work — no migration.

## Quick start

```bash
bun install
cp .env.example .env.local   # fill in Clerk, Neon, KMS dev key
bun db:generate              # generate drizzle migrations from schema
bun db:migrate               # apply migrations to your Neon dev branch
bun dev                      # localhost:3000
bun run test                 # vitest baseline — note `bun run test`, not
                             # `bun test`. The bare form invokes Bun's
                             # built-in runner which doesn't load the
                             # vitest module-mock layer the unit suites
                             # rely on.
bun run test:e2e             # Playwright smoke (E2E_LIVE=1 for live)
```

## OSS image dependency

The router spawns `midplane/midplane:0.1.0`. The OSS workflow publishes to `midplane/midplane` on Docker Hub; that tag isn't pushed yet, so for local dev build from source:

```bash
docker build -t midplane/midplane:0.1.0 /path/to/midplaneai/midplane
```

Or use the convenience script (auto-detects `~/dev/midplane`, override with `OSS_REPO=...`):

```bash
bun run dev:image
```

## What's in scope here

V1 critical path: signup → region pick → paste DSN → encrypted store → hosted MCP URL → Cursor connects → first query exercises the OSS image with stored creds → audit lands in container SQLite.

NOT this session: indexer, dashboard read views, rotation flow, prod AWS KMS, iad region deploy, billing, public deploy.
