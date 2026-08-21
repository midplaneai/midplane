# Midplane

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/midplaneai/midplane/actions/workflows/engine-test.yml/badge.svg)](https://github.com/midplaneai/midplane/actions/workflows/engine-test.yml)
[![Docs](https://img.shields.io/badge/docs-midplane.ai%2Fdocs-2ea44f.svg)](https://midplane.ai/docs)
[![MCP](https://img.shields.io/badge/MCP-stdio%20%2B%20Streamable%20HTTP-blueviolet)](https://modelcontextprotocol.io/)

**Postgres MCP server for AI agents.** Connect the tables you've been keeping
off-limits. PII masked at the source, policy enforced on the SQL AST, writes held
for human approval, everything audited. MIT, self-hostable.

Midplane sits in the query path between an AI agent (Claude, Cursor, any MCP
client) and your Postgres database. Every statement is parsed into a real Postgres
AST — not matched against a regex blocklist — checked against a declarative
per-table policy, rewritten so masked columns never leave the database in the
clear, and recorded in an event-sourced audit log **before** it executes.

> 📖 **Full documentation lives at [midplane.ai/docs](https://midplane.ai/docs)** —
> agent setup, the policy reference, self-hosting, deployment, and the threat model.
> This README is just the orientation.

<img width="960" height="540" alt="midplane-chat-demo" src="https://github.com/user-attachments/assets/d9800b2a-dc45-4a6e-a0b2-3aa219b1009a" />

## Why this exists

AI coding agents are being plugged into production Postgres without an audit trail
or a safety layer. The deprecated Anthropic reference Postgres MCP shipped a
stacked-statement injection vector (Datadog Security Labs, 2025); the common
service-role setup hands an agent a connection that can read and write every table.
So the tables that would make an agent genuinely useful — customers, orders,
subscriptions — stay off-limits, because "a read-only role and good intentions"
isn't a control anyone can show a security reviewer. Midplane is that control.

## What it does

- **PII masked at the source.** Declare a column masked and the engine rewrites
  the query's source relation, so the raw value never leaves Postgres — masking
  applies inside joins, filters, and aggregates rather than being scrubbed out of
  the rows on the way back. Transforms range from `full-redact` and `null-out` to
  `consistent-hash` (deterministic, salted, so masked join keys still join),
  `partial`, `generalize`, `pseudonymize`, and `noise`. It fails closed: anything
  the engine can't prove is masked — an unvetted function that could read the
  table behind the parser's back, a result column whose provenance doesn't map to
  a known base column — denies the query rather than risk an unmasked value.
- **Policy enforced on the SQL AST.** Every statement is parsed by `libpg_query`
  — Postgres's own parser — and checked against a per-table policy of
  `deny` / `read` / `read_write`, plus optional tenant scoping and categorical
  write guardrails. The walk is recursive, so a write buried in a CTE, subquery,
  or UNION arm is caught at the write, not at the outer `SELECT`.
- **Writes held for human approval.** Opt a write class into approvals and the
  engine pauses the statement *after* the policy has allowed it and asks a human.
  The agent gets a `check_approval` tool and re-runs when the answer lands; a
  denial carries the reviewer's note back, so "use the refunds table instead"
  reaches the agent. Approvals sit under the policy, never over it — nothing the
  policy denied can be approved into running.
- **Everything audited.** An event-sourced log written *before* execution: which
  agent, which token, the statement, the decision and its reason, and which
  columns were masked. Local SQLite for the standalone engine; a queryable,
  exportable audit log in the app.

## What it blocks

Out of the box, before you configure anything:

- **Destructive writes by default** — `DELETE FROM users` is denied even with a
  `WHERE`, until you opt the table into `read_write`.
- **Whole-table wipes and schema destruction** — no-`WHERE` `DELETE` / `UPDATE`
  and all `DROP` / `TRUNCATE` / `ALTER`, regardless of table policy.
- **Stacked-statement injection** — `SELECT 1; DROP TABLE users` denied at parse time.
- **Writes hidden inside a read** — `WITH x AS (DELETE FROM users RETURNING *)
  SELECT * FROM x` is denied at the inner `DELETE`, not the outer `SELECT`. The
  same recursive walk covers subqueries, UNION arms, and JOINs.

The full policy model, the parse → policy → mask → audit pipeline, and the
adversarial corpus that pins it are documented at
[midplane.ai/docs](https://midplane.ai/docs).

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

Three ways in — same open-core codebase behind all of them. Step-by-step guides
are at **[midplane.ai/docs](https://midplane.ai/docs)**.

### Managed cloud

The fastest way to try Midplane: **[sign up at app.midplane.ai](https://app.midplane.ai)**
and go from zero to your first guarded query in a couple of minutes. Dashboard,
policy and masking editors, approval queue, hosted audit log, agent-token
issuance. Nothing to install, multi-region, fully supported.

### Guard one database yourself

Put the MIT engine in front of a Postgres database and point an agent at it.
Nothing to install — `npx` ships with Node and fetches the
[`midplane`](https://www.npmjs.com/package/midplane) package on first run
(needs Node 22.16+; on anything older it says so and exits). Add this to your
MCP client's config (Claude Code, Claude Desktop, Cursor — they all take this
shape):

```json
{
  "mcpServers": {
    "midplane": {
      "command": "npx",
      "args": ["-y", "midplane", "server", "--stdio"],
      "env": { "DATABASE_URL": "postgres://user:pass@host:5432/db" }
    }
  }
}
```

Keep the connection string in that `env` block rather than on a command line,
where it would leak to `ps aux` and your shell history. The block still lands in
a plaintext config file, so give Midplane its own least-privilege Postgres role:
it governs which SQL runs, not what the role underneath it can reach.

That config is already the safe default: reads allowed, writes and DDL denied,
every query audited to `~/.midplane/audit.db`. Read the log back with
`npx midplane audit denies`. To open specific tables up, generate a policy with
`npx midplane init` — it introspects your schema over a read-only connection,
suggests a tenant column, and writes a validated `midplane.policy.yaml`.

Masking and approvals are sections of that same policy file: `column_masks` names
the columns to mask and the transform to apply (set `MIDPLANE_MASK_SALT`, and
`mask_source_rewrite: true` for source rewriting), and `approvals` holds writes
until a human rules on them. Approvals need somewhere to ask — point the engine at
the app's gate (`MIDPLANE_APPROVAL_URL` + `MIDPLANE_APPROVAL_TOKEN`), self-hosted
or cloud, both below.

> For a CI pipeline or a long-lived sidecar, the same engine ships as a
> self-contained image with no Node in it — `midplane/midplane:0.19.0`, serving
> Streamable HTTP instead of stdio.
> [Setup](https://midplane.ai/docs) · [`engine/README.md`](./engine/README.md).

### Self-host the whole app

The complete single-tenant product — dashboard, policy and masking editors,
approval queue, audit log, agent-token issuance — keyless and uncapped, on your
own Postgres. Docker is the only prerequisite:

```bash
git clone https://github.com/midplaneai/midplane && cd midplane
./bin/self-host up                               # → http://localhost:3000
```

That generates secrets into `.env.self-host`, brings up Postgres + the web app,
applies migrations on boot, and prints the dashboard URL — the first
email+password signup becomes the owner.

Running from source, the single-image deploy, the engine-spawn topology, and the
full walkthrough: [midplane.ai/docs](https://midplane.ai/docs) (in-repo:
[`SELF_HOST.md`](./SELF_HOST.md)).

## Open core

Midplane is **open core, MIT, and self-hostable.** Everything outside
`apps/web/src/ee/` is the Community Edition — the whole single-tenant product,
uncapped when self-hosted. `apps/web/src/ee/` is the commercial Enterprise Edition
(SSO/SAML today; the governance band over time); deleting it leaves a working MIT
build. The managed cloud is the same codebase and the supported, paid path. See
[`LICENSE`](./LICENSE) for the MIT terms and [`NOTICE`](./NOTICE) for the `ee/`
carve-out.

## Architecture

One codebase, two deployables:

- **Control plane** (repo root) — dashboard, policy and masking management,
  approval queue, audit views, agent-token issuance, hosted MCP proxy. MIT except
  `apps/web/src/ee/`.
- **Engine** ([`engine/`](./engine)) — the MIT query-path engine, compiled to a
  self-contained binary. It parses, enforces, masks, and audits; the control plane
  spawns it per project and never reimplements it, so hosted and self-host run the
  exact same engine — only the packaging differs.

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
The one carve-out is `apps/web/src/ee/` (the commercial Enterprise Edition, governed
by [`apps/web/src/ee/LICENSE`](./apps/web/src/ee/LICENSE) and recorded in
[`NOTICE`](./NOTICE)); deleting it leaves a fully working MIT build.

---

**More:** [Docs](https://midplane.ai/docs) · [Pricing](./PRICING.md) ·
[Support](./SUPPORT.md) · [Design system](./DESIGN.md) ·
[Code of Conduct](./CODE_OF_CONDUCT.md)
