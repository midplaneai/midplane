# Deploying the Midplane cloud control plane

> **This is the operator runbook for the managed, multi-region topology**
> (Fly + Neon + AWS KMS). If you just want to run Midplane yourself, you almost
> certainly want [`SELF_HOST.md`](../SELF_HOST.md) instead — one box, one
> Postgres, no cloud vendors. This page is the from-scratch setup for the hosted
> service.

Multi-region is V1, not V1.5: the schema and the customer-facing URL format are
multi-region from day one. Bootstrap brings up `eu` (Frankfurt, eu-central-1)
first; `us` (Dulles, us-east-2) is pure deploy work — no migration. Customer-
facing names track the jurisdiction (`eu.midplane.ai`, `us.midplane.ai`); the
underlying Fly DC is configurable per region, so EU can move to `ams` later
without renaming anything else.

## OSS engine image

The router spawns `midplane/midplane:0.15.0` (published on Docker Hub). The image
tag has a single source of truth — `OSS_ENGINE_IMAGE` in
`packages/router/src/oss-image.ts` — and `bun scripts/check-image-pin.ts` (CI)
fails if any config/doc site drifts from it.

For local dev (when the published tag isn't on Docker Hub yet, or while iterating
on the engine), build the image from the in-tree engine:

```bash
bun run dev:image            # builds engine/docker/Dockerfile, tag from MIDPLANE_OSS_IMAGE
```

The engine source lives at [`engine/`](../engine) — no separate clone needed. Run
its tests with `bun run test:engine`; run the full production-image battery with
`bash engine/scripts/test-image.sh`.

## Neon (control-plane Postgres)

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
  BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  BETTER_AUTH_URL='https://eu.app.midplane.ai' \
  MIDPLANE_KMS_MODE='env' \
  MIDPLANE_KMS_DEV_KEY_EU="$(openssl rand -hex 32)" \
  FLY_API_TOKEN='fly_...' \
  FLY_APP_EU='midplane-eu' \
  FLY_REGION_EU='fra' \
  MIDPLANE_PUBLIC_HOST_EU='eu.midplane.ai' \
  MIDPLANE_OSS_IMAGE='midplane/midplane:0.15.0' \
  INDEXER_TOKEN="$(openssl rand -hex 32)" \
  MIDPLANE_STAFF_USER_IDS='user_...'

# 3. US app secrets — symmetric. NEVER set DATABASE_URL_EU /
#    MIDPLANE_KMS_KEY_EU / etc. on this app.
fly secrets set --app midplane-web-us \
  MIDPLANE_REGION='us' \
  DATABASE_URL_US='postgres://...us-east-2.aws.neon.tech/midplane?sslmode=require' \
  MIDDLEWARE_ENFORCE='false' \
  BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  BETTER_AUTH_URL='https://us.app.midplane.ai' \
  MIDPLANE_KMS_MODE='env' \
  MIDPLANE_KMS_DEV_KEY_US="$(openssl rand -hex 32)" \
  FLY_API_TOKEN='fly_...' \
  FLY_APP_US='midplane-us' \
  FLY_REGION_US='iad' \
  MIDPLANE_PUBLIC_HOST_US='us.midplane.ai' \
  MIDPLANE_OSS_IMAGE='midplane/midplane:0.15.0' \
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

## KMS mode for production credential storage

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

The `kmsKeyId` column on `projects` routes per row: existing rows with
`env:eu` / `env:us` keep decrypting via the env-mode path; new rows written
after the cutover store the CMK ARN and decrypt via KMS. No backfill is
needed for the cutover itself — rotation of pre-existing env-mode rows is
a separate operation.

## Analytics (PostHog)

Authenticated cloud-user events — `signup_completed`, `project_*`,
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
# No NEXT_PUBLIC_* build args needed: the Better Auth client is same-origin,
# so nothing auth-related is baked into the client bundle — BETTER_AUTH_SECRET
# and the rest are runtime Fly secrets. Run both deploys when shipping (same
# image, different region pin).
fly deploy --config fly-web-eu.toml
fly deploy --config fly-web-us.toml

# After the deploy has been stable for ~24h (no region.null_metadata or
# region.cross_region anomalies), flip MIDDLEWARE_ENFORCE to "true" so
# cross-region requests get 302'd instead of just logged.
fly secrets set --app midplane-web    MIDDLEWARE_ENFORCE='true'
fly secrets set --app midplane-web-us MIDDLEWARE_ENFORCE='true'
```

## Health check

`https://midplane-web.fly.dev/api/health` returns `{ "ok": true }`. Fly's
`[[http_service.checks]]` polls this every 30s. The check intentionally does
not touch Postgres — a Neon outage should not take down the proxy.

Local Docker smoke test (no fly required):

```bash
docker build -t midplane-web -f apps/web/Dockerfile .
```
