# Sample database

The hosted, read-only demo Postgres behind the "Try with our sample database"
link on the new-project form (`apps/web/src/components/projects/new-project-form.tsx`).
It exists for one user: the evaluator who wants to see an agent query through
Midplane but has no reachable Postgres of their own — previously a hard dead
end in the onboarding funnel.

## What's in here

| File | Run as | Purpose |
|---|---|---|
| `provision.sql` | admin, once | Creates the `midplane_sample` role with the abuse guardrails (read-only grants, `CONNECTION LIMIT 20`, `statement_timeout 2s`, no CREATE/TEMP). |
| `seed.sql` | admin, re-runnable | Drops + recreates the mock-SaaS dataset (`customers`, `subscriptions`, `invoices`, `support_tickets`) and re-grants `SELECT`. Deterministic — no `random()` — so re-seeding is byte-identical. |
| `Dockerfile` | build | Plain Postgres 16 + a self-signed cert (for `sslmode=require`) that self-seeds on first boot by running `provision.sql` + `seed.sql`. |
| `initdb.sh` | first boot | The first-boot hook the image runs once; feeds `SAMPLE_PASSWORD` (a Fly secret) into `provision.sql`. |
| `fly.toml` | deploy | The Fly Machine config: EU, `shared-cpu-1x`/256 MB, one always-on machine, a 1 GB volume, raw-TCP 5432. |
| `deploy.sh` | operator, once | One command: creates the app, passwords, volume, deploys (auto-seeds), sets the IP posture, and prints the DSN + the two `fly secrets set` wiring commands. |

The dataset is synthetic mock-SaaS rather than Pagila because it shows
Midplane's point: `customers.email` / `customers.phone` light up the PII
exposure scan, and the revenue tables answer the demo prompts an agent
naturally gets ("monthly revenue by plan?", "top customers by invoice
total?"). All emails end in `@example.com`.

## Hosting

Run **plain Postgres on a small always-on Fly Machine** (this is what `deploy.sh`
does): `shared-cpu-1x`/256 MB + a 1 GB volume, EU region, colocated with
`midplane-web`, ~$2–3/mo. Deliberately **not** a managed or serverless tier:

- **Not scale-to-zero** (Neon's default, Supabase Free's 7-day pause). The first
  Test-connection or dry-run of the day against a cold instance takes seconds or
  times out — and this database exists precisely for first impressions.
- **Not managed** (Fly MPG ~$38/mo, Supabase Pro $25/mo, Neon Launch always-on
  ~$38/mo). Their value-add is backups/PITR/HA, which is worth ~$0 here: the data
  is deterministic and re-seedable, so `seed.sql` *is* the disaster-recovery plan.
- A DIY Machine also gives **full superuser**, so every guardrail in
  `provision.sql` (role GUCs, `CONNECTION LIMIT 20`, `REVOKE CREATE/TEMP`) applies
  verbatim — no transaction-pooler caveats to work around.

One instance serves both regions — the sample DB holds no customer data, so data
residency doesn't apply to it.

**Reachability posture** (`deploy.sh` picks this): *private* (default) keeps the
DB on 6PN/`.internal` so only the web/engine apps can reach it — stronger, and
the rendered DSN isn't dial-able from a stranger's laptop. *Public*
(`SAMPLE_DB_PUBLIC=1`) allocates a dedicated IPv4 so the copy-paste DSN works
anywhere, matching the "treat the DSN as public" framing exactly. Either way the
guardrails live on the role, not on secrecy.

The private posture's `.internal` host resolves to Fly 6PN (fdaa::/ULA) space,
which the SSRF ping guard blocks for user DSNs — the in-product Test-connection
buttons only work because `pingDsnGuarded` exempts the **exact**
`MIDPLANE_SAMPLE_DSN` string (operator config, not user input). If you edit the
DSN secret, keep it byte-identical everywhere or the reachability test on the
sample project starts failing with the generic connect error.

## Provisioning — one command

```sh
cd scripts/sample-db

# Private by default (6PN only). Add SAMPLE_DB_PUBLIC=1 for a dial-able DSN.
./deploy.sh

# Prints the DSN, a sanity row count, and the two `fly secrets set` commands
# that wire MIDPLANE_SAMPLE_DSN into midplane-web-{eu,us}. SAVE the printed
# passwords — Fly secrets are write-only and provision runs only on first boot.
```

Unset `MIDPLANE_SAMPLE_DSN` on the web apps and the link disappears — that's the
kill switch if the shared instance is ever abused.

## Re-seeding / manual runbook

The image self-seeds on first boot only (empty volume). To re-apply `seed.sql`
after a data change, or to provision against a **non-Fly** host, run the SQL
directly. Against the Fly Machine, forward the port first:

```sh
fly proxy 15432:5432 -a midplane-sample-db &   # then use localhost:15432

# On any host: role + guardrails (once), then schema + data (re-runnable).
export SAMPLE_PASSWORD="$(openssl rand -hex 24)"   # first time only
psql "$ADMIN_SAMPLE_DSN" -v sample_password="$SAMPLE_PASSWORD" -f provision.sql
psql "$ADMIN_SAMPLE_DSN" -f seed.sql

# Sanity: the sample role can read but not write, create, or camp.
psql "postgres://midplane_sample:$SAMPLE_PASSWORD@<host>:5432/sample?sslmode=require" \
  -c "SELECT count(*) FROM customers" \
  -c "INSERT INTO customers (name,email,phone,country,signed_up_at) VALUES ('x','x@example.com','x','US',now())" \
  # the INSERT must fail with "permission denied"
```

To rotate the public credential without a re-seed:
`ALTER ROLE midplane_sample PASSWORD '<new>'`, then update the web-app secrets.

**Already-deployed instances:** `provision.sql` only runs on first boot, so
apply hardening added after the initial deploy by hand. Currently that means
the maintenance-DB revokes and the large-object write revokes (both added
post-deploy):

```sh
fly ssh console -a midplane-sample-db -C "psql -U postgres -c 'REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC; REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC;'"
fly ssh console -a midplane-sample-db -C "psql -U postgres -d sample -c 'REVOKE EXECUTE ON FUNCTION lo_create(oid), lo_creat(integer), lo_from_bytea(oid, bytea), lo_import(text), lo_import(text, oid), lo_open(oid, integer), lowrite(integer, bytea), lo_put(oid, bigint, bytea) FROM PUBLIC;'"
```

## Abuse recovery

Postgres cannot stop a role from changing its own password — so with a public
posture, anyone holding the DSN can run `ALTER ROLE midplane_sample PASSWORD`
and lock the demo out for everyone. The web apps' Test-connection failures
against the sample DSN are the signal. Recovery is the rotate command above
(superuser via `fly ssh`, then re-set `MIDPLANE_SAMPLE_DSN` on both web apps);
if abuse repeats, flip to the private posture or unset the secret (kill
switch). The role's session GUCs (`statement_timeout` etc.) are politeness,
not enforcement — a hostile client can `SET` them away; the enforced limits
are `CONNECTION LIMIT 20` and the SELECT-only grants.

**Rotation blast radius:** existing sample projects store an encrypted
snapshot of the OLD DSN, so a rotation breaks their queries (Postgres auth
failure) and — in the private posture — their saved-db Test-connection also
falls out of the exact-match SSRF exemption. There is no bulk re-point; those
evaluators re-create the sample project (cheap by design, but say so in any
incident comms). Rotate the *sample role's* password for abuse; never rotate
it casually.

**Capacity math:** `CONNECTION LIMIT 20` is global while each sample project's
engine opens a pool of up to 10 connections, plus Test-connection pings — two
concurrently busy evaluators can exhaust the cap and hand a third "too many
connections" on the first-impression surface. If sample-DB traffic becomes
real, raise the role's `CONNECTION LIMIT` (e.g. 40–60) before shrinking
engine pools; the Machine's own `max_connections` (default 100) has headroom.

## Deliberate non-goals

- **No auto-seeded masking policy.** The design doc lists seeding a masking
  config into the user's project when they pick the sample DSN as optional
  garnish; the exposure scan already flags `customers.email` / `phone`, which
  is the guided path. Revisit if stranger tests show evaluators never find
  masking.
- **No writes.** The default-access picker still offers read/write, but the
  DB role denies writes regardless — an agent granted "read + write" on the
  sample project gets `permission denied` from Postgres, which is itself an
  honest demo of defense-in-depth.
