# Midplane

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/midplaneai/midplane/actions/workflows/engine-test.yml/badge.svg)](https://github.com/midplaneai/midplane/actions/workflows/engine-test.yml)
[![Docs](https://img.shields.io/badge/docs-midplane.ai%2Fdocs-2ea44f.svg)](https://midplane.ai/docs)
[![MCP](https://img.shields.io/badge/MCP-stdio%20%2B%20Streamable%20HTTP-blueviolet)](https://modelcontextprotocol.io/)

**Safe-by-default SQL guardrails for AI agents.** Midplane sits in the query path
between an AI agent (Claude, Cursor, any MCP client) and your Postgres database. It
parses every statement with a real SQL AST — not a regex blocklist — enforces a
declarative per-table access policy, blocks destructive DML/DDL, and writes an
event-sourced audit log of which agent ran what, **before** the query executes.

> 📖 **Full documentation lives at [midplane.ai/docs](https://midplane.ai/docs)** —
> agent setup, the policy reference, self-hosting, deployment, and the threat model.
> This README is just the orientation.

<!-- TODO(screenshot): a dashboard audit-log or denied-query view belongs here.
     Open-core dashboards convert on a visual; highest-leverage single addition. -->

## Why this exists

AI coding agents are being plugged into production Postgres without an audit trail
or a safety layer. The deprecated Anthropic reference Postgres MCP shipped a
stacked-statement injection vector (Datadog Security Labs, 2025); the Supabase
service-role pattern has been used to exfiltrate cross-tenant data. Midplane parses
every query as an AST, denies the dangerous shapes, and writes a durable audit row
**before** the query reaches your database.

## What it blocks

- **Destructive writes by default** — `DELETE FROM users` is denied even with a
  `WHERE`, until you opt the table into `read_write`.
- **Whole-table wipes and schema destruction** — no-`WHERE` `DELETE` / `UPDATE`
  and all `DROP` / `TRUNCATE` / `ALTER`, regardless of table policy.
- **Stacked-statement injection** — `SELECT 1; DROP TABLE users` denied at parse time.
- **Cross-tenant exfiltration** — map a tenant column once; unscoped queries are
  denied at any AST depth (subqueries, CTEs, JOINs).

The full policy model, the parse → policy → audit pipeline, and the adversarial
corpus that pins it are documented at [midplane.ai/docs](https://midplane.ai/docs).

## In a real chat

A `delete all users` prompt to Claude Code, against a Midplane-fronted DB:

> ⏺ Hold on — that's destructive and irreversible. Before I run
> `DELETE FROM public.users`, please confirm.
>
> *user: confirm delete all users*
>
> ⏺ Midplane blocked it: *"writes to table `users` are not allowed by the
> table-access policy."* The DELETE was audited but not executed.

## Quick start

Start hosted, or run it yourself — same open-core codebase. Step-by-step guides are
at **[midplane.ai/docs](https://midplane.ai/docs)**.

### Managed cloud

The fastest way to try Midplane: **[sign up at app.midplane.ai](https://app.midplane.ai)**
and go from zero to your first guarded query in a couple of minutes. Nothing to
install, multi-region, fully supported.

### Self-host

The complete single-tenant app — dashboard, policy editor, audit log, agent-token
issuance — keyless and uncapped, on your own Postgres + a local engine.

```bash
cp .env.self-host.example .env.self-host         # fill 3 secrets
docker compose -f docker-compose.self-host.yml up -d postgres
bun run migrate:self-host
bun run build:engine-binary
export MIDPLANE_ENGINE_BIN="$PWD/engine/dist/midplane"
bun --env-file=.env.self-host run dev            # http://localhost:3000
```

Walkthrough, engine-spawn topology, and the single-image deploy:
[midplane.ai/docs](https://midplane.ai/docs) (in-repo: [`SELF_HOST.md`](./SELF_HOST.md)).

> The MIT query-path engine also ships as a standalone Docker image
> (`midplane/midplane`) — for guarding a single database or a CI pipeline without
> the dashboard. Setup at [midplane.ai/docs](https://midplane.ai/docs).

## Open core

Midplane is **open core, MIT, and self-hostable.** Everything outside
`apps/web/src/ee/` is the Community Edition — the whole single-tenant product,
uncapped when self-hosted. `apps/web/src/ee/` is the commercial Enterprise Edition
(SSO/SAML today; the governance band over time); deleting it leaves a working MIT
build. The managed cloud is the same codebase and the supported, paid path. See
[`LICENSE`](./LICENSE).

## Architecture

One codebase, two deployables:

- **Control plane** (repo root) — dashboard, policy management, audit views,
  agent-token issuance, hosted MCP proxy. MIT except `apps/web/src/ee/`.
- **Engine** ([`engine/`](./engine)) — the MIT query-path engine, compiled to a
  self-contained binary. The control plane spawns it per project and never
  reimplements it, so hosted and self-host run the exact same engine — only the
  packaging differs.

```
apps/web              Next.js dashboard + Better Auth + projects API
packages/db           Drizzle schema (customers, projects, audit index)
packages/kms          encryptDsn / decryptDsn (env-mode dev, AWS KMS prod)
packages/router       Hosted MCP request handler — token → project → engine
engine/               The MIT query-path engine
infra/telemetry-proxy Cloudflare Worker for anonymized OSS install telemetry
```

Operating the managed multi-region cloud (Fly + Neon + KMS) is in
[`docs/deploy.md`](./docs/deploy.md).

## Contributing

Issues and PRs welcome — start with [`CONTRIBUTING.md`](./CONTRIBUTING.md). The
single highest-leverage contribution is a new entry in the adversarial SQL corpus:
a bypass attempt and the policy fix that defeats it. Commits are DCO-signed
(`git commit -s`). For security issues, follow [`SECURITY.md`](./SECURITY.md) —
don't open a public issue.

## License

MIT — see [`LICENSE`](./LICENSE). No copyleft, no BSL, no source-available rug-pull.
The one carve-out is `apps/web/src/ee/` (the commercial Enterprise Edition); deleting
it leaves a fully working MIT build.

---

**More:** [Docs](https://midplane.ai/docs) · [Pricing](./PRICING.md) ·
[Support](./SUPPORT.md) · [Design system](./DESIGN.md) ·
[Code of Conduct](./CODE_OF_CONDUCT.md)
