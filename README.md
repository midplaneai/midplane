# midplane-cloud

Hosted Midplane. Sign up via Clerk, paste a Postgres URL, get an MCP endpoint that runs the locked OSS engine (`midplane/midplane`) with your encrypted credentials.

This repo CONSUMES the OSS image; it never reimplements the engine. Hosted/self-host parity is mechanically enforced by spawning the same Docker image self-host users run.

## Layout

```
apps/web              Next.js dashboard + Clerk auth + connections API
apps/web/Dockerfile   Multi-stage bun + Next.js standalone build (control plane)
packages/db           Drizzle schema (customers, connections, audit_events_index)
packages/kms          encryptDsn / decryptDsn (env-mode dev, AWS KMS prod)
packages/router       Hosted MCP request handler — token → connection → Fly app
fly-web.toml          Control-plane Fly app (Next.js dashboard + /mcp/<token>)
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

The router spawns `midplane/midplane:0.4.0`. The OSS workflow publishes to `midplane/midplane` on Docker Hub; that tag isn't pushed yet, so for local dev build from source:

```bash
docker build -t midplane/midplane:0.4.0 /path/to/midplaneai/midplane
```

Or use the convenience script (auto-detects `~/dev/midplane`, override with `OSS_REPO=...`):

```bash
bun run dev:image
```

## Deploy (control plane)

The Next.js control plane (apps/web) runs on Fly so it shares the same
6PN private network as the regional runtime apps. `FlyMachineSpawner`
returns IPv6 private IPs that only same-Fly-org apps can reach — hosting
the control plane on Vercel/Render would force every customer audit
request through an extra public-Internet hop.

First-time setup (one-shot, user-driven):

```bash
# 1. Create the app in your Fly org.
fly apps create midplane-web --org <your-org>

# 2. Set runtime secrets. NEVER inline these in fly-web.toml.
fly secrets set --app midplane-web \
  DATABASE_URL='postgres://...neon.tech/midplane?sslmode=require' \
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY='pk_live_...' \
  CLERK_SECRET_KEY='sk_live_...' \
  MIDPLANE_KMS_MODE='env' \
  MIDPLANE_KMS_DEV_KEY_FRA="$(openssl rand -hex 32)" \
  MIDPLANE_KMS_DEV_KEY_IAD="$(openssl rand -hex 32)" \
  FLY_API_TOKEN='fly_...' \
  FLY_APP_FRA='midplane-fra' \
  FLY_APP_IAD='midplane-iad' \
  MIDPLANE_PUBLIC_HOST_FRA='fra.midplane.ai' \
  MIDPLANE_PUBLIC_HOST_IAD='iad.midplane.ai' \
  MIDPLANE_OSS_IMAGE='midplane/midplane:0.4.0' \
  INDEXER_TOKEN="$(openssl rand -hex 32)"
```

Per-deploy:

```bash
# NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is baked into the client bundle at
# build time — pass it as a Docker build arg (the same value you set as
# a runtime secret above).
fly deploy --config fly-web.toml \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY='pk_live_...'
```

Health check: `https://midplane-web.fly.dev/api/health` returns
`{ "ok": true }`. Fly's `[[http_service.checks]]` polls this every 30s.
The check intentionally does not touch Postgres — a Neon outage should
not take down the proxy.

Local Docker smoke test (no fly required):

```bash
docker build -t midplane-web -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_local .
```

## Testing

`bun test` runs the vitest unit suite. Live end-to-end suites under `e2e/` are gated on `E2E_LIVE=1` and require Docker + a Neon dev branch:

```bash
bun run test:e2e:live                          # all live suites
bun run test:e2e:live --grep signup            # critical-path #1 only
```

The signup suite (`e2e/signup.live.e2e.ts`) drives the conversion path end to end: real Clerk session → region pick → paste DSN → MCP endpoint → first MCP query → audit row in container SQLite (and `audit_events_index` if `INDEXER_TOKEN` is set).

It uses [Clerk testing tokens](https://clerk.com/docs/testing/overview) to bypass bot detection on the dev Clerk instance. No extra credentials are needed beyond `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` (already in `.env.local`); `e2e/_clerk-globalsetup.ts` mints a fresh testing token at suite start. Each run creates a brand-new test user via Clerk's Backend API (`+clerk_test@…` reserved subaddress, auto-verified) and deletes it in `afterAll` to keep the dev instance under its user-count cap.

## What's in scope here

V1 critical path: signup → region pick → paste DSN → encrypted store → hosted MCP URL → Cursor connects → first query exercises the OSS image with stored creds → audit lands in container SQLite.

NOT this session: indexer, dashboard read views, rotation flow, prod AWS KMS, iad region deploy, billing, public deploy.
