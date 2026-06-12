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
fly-web-eu.toml       EU control-plane Fly app (also serves apex app.midplane.ai)
fly-web-us.toml       US control-plane Fly app
fly-eu.toml           EU regional MCP runtime app (pinned to Frankfurt)
fly-us.toml           US regional MCP runtime app (pinned to Ashburn)
scripts/bootstrap.sh  One-shot dev setup
```

Multi-region is V1, not V1.5. Schema and URL format are multi-region from day one. Bootstrap deploys `eu` (Frankfurt, eu-central-1) only; `us` (Dulles, us-east-2) is provisioned in the V1 launch session as pure deploy work — no migration. Customer-facing names track the jurisdiction (`eu.midplane.ai`, `us.midplane.ai`); the underlying Fly DC is configurable per region so EU can move to ams later without renaming anything else.

## Quick start

```bash
bun install
cp .env.example .env.local   # fill in Clerk, Neon, KMS dev key
bun db:generate              # generate drizzle migrations from schema
bun migrate:eu               # apply migrations to your EU Neon dev branch
                             # (use migrate:us / migrate:all in prod; locally
                             #  only the EU side is configured by default)
bun dev                      # localhost:3000
bun run test                 # vitest baseline — note `bun run test`, not
                             # `bun test`. The bare form invokes Bun's
                             # built-in runner which doesn't load the
                             # vitest module-mock layer the unit suites
                             # rely on.
bun run test:e2e             # Playwright smoke (E2E_LIVE=1 for live)
```

## OSS image dependency

The router spawns `midplane/midplane:0.9.0` (published on Docker Hub). For local dev against an unreleased OSS branch, override the tag and build from source:

```bash
docker build -t midplane/midplane:0.9.0 /path/to/midplaneai/midplane
```

Or use the convenience script (auto-detects `~/dev/midplane`, override with `OSS_REPO=...`):

```bash
bun run dev:image
```

### Neon (control-plane Postgres)

Two Neon projects, one per region — physical isolation is what makes
env-var locality meaningful. Create both before the Fly secrets block
below:

1. https://console.neon.tech → New Project, region **AWS eu-central-1**,
   name `midplane-prod-eu`. Copy the **pooled** connection string (the
   `-pooler` host) → `DATABASE_URL_EU`. `packages/db/src/index.ts`
   passes `prepare: false` so pgbouncer-mode pooling works.
2. Same flow in **AWS us-east-2**, name `midplane-prod-us` →
   `DATABASE_URL_US`.

Apply migrations against each project before first deploy.
`migrate:eu` / `migrate:us` read from `.env.local`, so either set the
prod URLs there temporarily or inline them:

```bash
DATABASE_URL_EU='postgres://...eu-central-1.aws.neon.tech/...' bun migrate:eu
DATABASE_URL_US='postgres://...us-east-2.aws.neon.tech/...' bun migrate:us
```

Migration `0004_force_rls.sql` runs `FORCE ROW LEVEL SECURITY` on
`audit_events_index` — Neon's project owner role would otherwise bypass
the policy and silently cross customers. `e2e/audit-isolation.e2e.ts`
guards against regressions.

## Deploy (control plane)

The Next.js control plane (apps/web) runs on Fly so it shares the same
6PN private network as the regional runtime apps. `FlyMachineSpawner`
returns IPv6 private IPs that only same-Fly-org apps can reach — hosting
the control plane on Vercel/Render would force every customer audit
request through an extra public-Internet hop.

First-time setup (one-shot, user-driven). Two regional control-plane apps,
each pinned to one Neon project + one KMS key. **Env-var locality:** each
app only carries its region's `DATABASE_URL_<REGION>`, `MIDPLANE_KMS_KEY_<REGION>`,
`FLY_APP_<REGION>`, etc. The opposite region's secrets stay UNSET so a stray
cross-region call throws at the env-var read.

```bash
# 1. Create both apps in your Fly org.
fly apps create midplane-web    --org <your-org>   # EU control plane
fly apps create midplane-web-us --org <your-org>   # US control plane

# 2. EU app secrets. NEVER set DATABASE_URL_US / MIDPLANE_KMS_KEY_US /
#    MIDPLANE_KMS_DEV_KEY_US / FLY_APP_US / FLY_REGION_US /
#    MIDPLANE_PUBLIC_HOST_US on this app.
fly secrets set --app midplane-web \
  MIDPLANE_REGION='eu' \
  DATABASE_URL_EU='postgres://...eu-central-1.aws.neon.tech/midplane?sslmode=require' \
  MIDDLEWARE_ENFORCE='false' \
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY='pk_live_...' \
  CLERK_SECRET_KEY='sk_live_...' \
  MIDPLANE_KMS_MODE='env' \
  MIDPLANE_KMS_DEV_KEY_EU="$(openssl rand -hex 32)" \
  FLY_API_TOKEN='fly_...' \
  FLY_APP_EU='midplane-eu' \
  FLY_REGION_EU='fra' \
  MIDPLANE_PUBLIC_HOST_EU='eu.midplane.ai' \
  MIDPLANE_OSS_IMAGE='midplane/midplane:0.9.0' \
  INDEXER_TOKEN="$(openssl rand -hex 32)" \
  MIDPLANE_STAFF_USER_IDS='user_...'

# 3. US app secrets — symmetric. NEVER set DATABASE_URL_EU /
#    MIDPLANE_KMS_KEY_EU / etc. on this app.
fly secrets set --app midplane-web-us \
  MIDPLANE_REGION='us' \
  DATABASE_URL_US='postgres://...us-east-2.aws.neon.tech/midplane?sslmode=require' \
  MIDDLEWARE_ENFORCE='false' \
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY='pk_live_...' \
  CLERK_SECRET_KEY='sk_live_...' \
  MIDPLANE_KMS_MODE='env' \
  MIDPLANE_KMS_DEV_KEY_US="$(openssl rand -hex 32)" \
  FLY_API_TOKEN='fly_...' \
  FLY_APP_US='midplane-us' \
  FLY_REGION_US='iad' \
  MIDPLANE_PUBLIC_HOST_US='us.midplane.ai' \
  MIDPLANE_OSS_IMAGE='midplane/midplane:0.9.0' \
  INDEXER_TOKEN="$(openssl rand -hex 32)" \
  MIDPLANE_STAFF_USER_IDS='user_...'

# 4. DNS + TLS. Fly matches certs by SNI, so the apex needs its own
#    cert on the EU app (NOT covered by eu.app.midplane.ai's cert).
#    Control-plane hostnames (Next.js dashboard + MCP proxy):
fly certs add eu.app.midplane.ai  --app midplane-web
fly certs add app.midplane.ai     --app midplane-web
fly certs add us.app.midplane.ai  --app midplane-web-us

#    Customer-facing MCP host (the URLs printed in `claude mcp add ...
#    https://<region>.midplane.ai/mcp/<tok>` snippets, from
#    MIDPLANE_PUBLIC_HOST_{EU,US}). These point at the WEB apps, NOT the engine
#    apps: /mcp/<token> is served by the web app's proxyMcp, which resolves the
#    token (cloud DB), decrypts the DSN (KMS), spawns/reuses the OSS container,
#    and proxies to it over the private 6PN network. The engine apps
#    (midplane-eu/us) only HOST those private containers — they take no public
#    MCP traffic and need no public IP or cert of their own.
fly certs add eu.midplane.ai      --app midplane-web
fly certs add us.midplane.ai      --app midplane-web-us

# DNS records:
#   eu.app.midplane.ai  CNAME midplane-web.fly.dev
#   us.app.midplane.ai  CNAME midplane-web-us.fly.dev
#   app.midplane.ai     CNAME eu.app.midplane.ai
#                       (EU app handles apex; middleware redirects authed
#                        users to their regional subdomain)
#   eu.midplane.ai      CNAME midplane-web.fly.dev     (web app serves /mcp)
#   us.midplane.ai      CNAME midplane-web-us.fly.dev
```

### KMS mode for production credential storage

Hosted-mode customer DSNs are stored encrypted. `MIDPLANE_KMS_MODE` selects
the algorithm:

- `env` (default in the snippet above): AES-256-GCM with a per-region
  symmetric key from `MIDPLANE_KMS_DEV_KEY_{EU,US}`. Suitable only for
  pre-launch bootstrap — no envelope encryption, no rotation, no HSM.
- `kms`: AWS KMS `GenerateDataKey` + AES-256-GCM with the wrapped data key.
  Per-region CMK, with `EncryptionContext = {customerId, region}` bound on
  both `GenerateDataKey` and `Decrypt` so a US-region compromise cannot
  decrypt EU rows (and vice versa).

To switch a deployed control plane from `env` to `kms`:

```bash
# 1. Provision one CMK per region (eu-central-1 and us-east-2). Aliases
#    work as the ARN value — e.g. alias/midplane-prod-eu. The Fly machine's
#    AWS identity (via OIDC or a long-lived access key in secrets) needs
#    kms:GenerateDataKey + kms:Decrypt on each key, scoped by
#    EncryptionContext so the credential can't be used to decrypt rows
#    belonging to other customers.
#
#    Sample key policy statement (attach to each region's CMK):
#      {
#        "Effect": "Allow",
#        "Principal": { "AWS": "arn:aws:iam::<acct>:role/midplane-web" },
#        "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
#        "Resource": "*",
#        "Condition": {
#          "StringEquals": { "kms:EncryptionContextKeys": ["customerId", "region"] },
#          "StringEqualsIfExists": { "kms:EncryptionContext:region": "<eu|us>" }
#        }
#      }

# 2. Point the control plane at the CMKs.
fly secrets set --app midplane-web \
  MIDPLANE_KMS_MODE='kms' \
  MIDPLANE_KMS_KEY_EU='arn:aws:kms:eu-central-1:<acct>:key/<uuid>' \
  MIDPLANE_KMS_KEY_US='arn:aws:kms:us-east-2:<acct>:key/<uuid>'

# 3. Provide AWS credentials to the Fly machine. One IAM principal per
#    region, each authorized for ONE CMK only — cross-region isolation
#    is enforced by IAM/key-policy here (not by env-var naming; see note
#    below). The simplest production-safe path is one IAM user per region
#    with an inline policy:

# EU principal
aws iam create-user --user-name midplane-web-eu
aws iam put-user-policy --user-name midplane-web-eu \
  --policy-name midplane-kms-eu \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
      "Resource": "arn:aws:kms:eu-central-1:<acct>:key/<eu-uuid>",
      "Condition": {
        "StringEquals": { "kms:EncryptionContext:region": "eu" }
      }
    }]
  }'
aws iam create-access-key --user-name midplane-web-eu
# → copy AccessKeyId + SecretAccessKey into the EU app:
fly secrets set --app midplane-web \
  AWS_ACCESS_KEY_ID='AKIA...' \
  AWS_SECRET_ACCESS_KEY='...'

# US principal
aws iam create-user --user-name midplane-web-us
aws iam put-user-policy --user-name midplane-web-us \
  --policy-name midplane-kms-us \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
      "Resource": "arn:aws:kms:us-east-2:<acct>:key/<us-uuid>",
      "Condition": {
        "StringEquals": { "kms:EncryptionContext:region": "us" }
      }
    }]
  }'
aws iam create-access-key --user-name midplane-web-us
# → copy AccessKeyId + SecretAccessKey into the US app:
fly secrets set --app midplane-web-us \
  AWS_ACCESS_KEY_ID='AKIA...' \
  AWS_SECRET_ACCESS_KEY='...'

# Also update each CMK's key policy to grant its region's IAM user (or
# the role you use under OIDC) — the sample at step 1 has Principal as
# a placeholder role ARN; swap in `user/midplane-web-eu` etc.
#
# For production, prefer Fly's OIDC provider + sts:AssumeRoleWithWebIdentity
# over long-lived access keys. The credential resolution is identical from
# the SDK's perspective; only the secret-rotation story changes.
```

> AWS credentials don't take a `_EU` / `_US` suffix the way our own
> region-pinned vars do. The AWS SDK's credential provider reads
> `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (and the OIDC variants)
> by fixed name — renaming them would bypass the standard credential
> chain. That's fine here: each Fly app already carries exactly one
> region's IAM principal, and the cross-region failure mode is the CMK
> key policy denying decryption under the wrong `EncryptionContext`, not
> a missing env var.

The `kmsKeyId` column on `connections` routes per row: existing rows with
`env:eu` / `env:us` keep decrypting via the env-mode path; new rows written
after the cutover store the CMK ARN and decrypt via KMS. No backfill is
needed for the cutover itself — rotation of pre-existing env-mode rows is
a separate operation.

### Analytics (PostHog)

Authenticated cloud-user events — `signup_completed`, `connection_*`,
`token_*`, `database_test_run` — are captured server-side from the Next.js
app via `posthog-node` (see `apps/web/src/lib/posthog.ts`). The client
returns `null` when either env var is unset, so dev and CI no-op without
any extra config.

Set the secrets on both regional web apps:

```bash
fly secrets set --app midplane-web \
  POSTHOG_API_KEY='phc_...' \
  POSTHOG_HOST='https://us.i.posthog.com'
fly secrets set --app midplane-web-us \
  POSTHOG_API_KEY='phc_...' \
  POSTHOG_HOST='https://us.i.posthog.com'
```

This is distinct from `infra/telemetry-proxy` (the `t.midplane.ai`
Cloudflare Worker), which proxies anonymized `install_id` events from OSS
engine installs. Same PostHog project, two sources — the `source` property
on every cloud event (`"dashboard"` or `"api"`) lets the two be separated
in funnels.

Per-deploy:

```bash
# NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is baked into the client bundle at
# build time — pass it as a Docker build arg (the same value you set as
# a runtime secret above). Run both deploys when shipping (same image,
# different region pin).
fly deploy --config fly-web-eu.toml \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY='pk_live_...'
fly deploy --config fly-web-us.toml \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY='pk_live_...'

# After the deploy has been stable for ~24h (no region.null_metadata or
# region.cross_region anomalies), flip MIDDLEWARE_ENFORCE to "true" so
# cross-region requests get 302'd instead of just logged.
fly secrets set --app midplane-web    MIDDLEWARE_ENFORCE='true'
fly secrets set --app midplane-web-us MIDDLEWARE_ENFORCE='true'
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

`bun run test` runs the vitest unit suite (not bare `bun test` — see the quick-start note). Live end-to-end suites under `e2e/` are gated on `E2E_LIVE=1` and require Docker + a Neon dev branch:

```bash
bun run test:e2e:live                          # all live suites
bun run test:e2e:live --grep signup            # critical-path #1 only
```

The signup suite (`e2e/signup.live.e2e.ts`) drives the conversion path end to end: real Clerk session → region pick → paste DSN → MCP endpoint → first MCP query → audit row in container SQLite (and `audit_events_index` if `INDEXER_TOKEN` is set).

It uses [Clerk testing tokens](https://clerk.com/docs/testing/overview) to bypass bot detection on the dev Clerk instance. No extra credentials are needed beyond `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY` (already in `.env.local`); `e2e/_clerk-globalsetup.ts` mints a fresh testing token at suite start. Each run creates a brand-new test user via Clerk's Backend API (`+clerk_test@…` reserved subaddress, auto-verified) and deletes it in `afterAll` to keep the dev instance under its user-count cap.

## What's in scope here

V1 critical path: signup → region pick → paste DSN → encrypted store → hosted MCP URL → Cursor connects → first query exercises the OSS image with stored creds → audit lands in container SQLite.

NOT this session: indexer, dashboard read views, rotation flow, prod AWS KMS, us region deploy, billing, public deploy.
