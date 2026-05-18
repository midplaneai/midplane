# Midplane

[![CI](https://github.com/midplaneai/midplane/actions/workflows/test.yml/badge.svg)](https://github.com/midplaneai/midplane/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-stdio%20%2B%20Streamable%20HTTP-blueviolet)](https://modelcontextprotocol.io/)
[![Verified](https://img.shields.io/badge/verified-Cursor%20%7C%20Claude%20Code%20%7C%20Claude%20Desktop-2ea44f)](./docs/agent-setup.md)

A safety layer between AI coding agents (Cursor, Claude Code, Claude Desktop) and your Postgres database. Parse, policy, audit. Read-only by default. Per-table read/write policy via YAML.

```bash
curl -O https://raw.githubusercontent.com/midplaneai/midplane/main/.env.example
mv .env.example .env  # edit with your DATABASE_URL
docker run --env-file .env -p 8080:8080 -v midplane-audit:/data midplane/midplane:latest
```

Or, from a clone of this repo, `docker compose up -d`.

The MCP endpoint comes up at `http://localhost:8080/mcp`. Paste it into your agent's MCP config and your agent now goes through Midplane.

> **Don't put credentials on the docker command line.** `-e DATABASE_URL=postgres://...` inline leaks the password to `ps aux` and your shell history. Use `--env-file` or compose. We won't show you that pattern anywhere in our docs.

## Why this exists

AI coding agents are getting plugged into production Postgres without an audit trail. The deprecated Anthropic reference Postgres MCP shipped a stacked-statement injection vector (Datadog Security Labs, 2025); the Supabase service-role pattern has been used to exfiltrate cross-tenant data. Midplane sits between your agent and your DB, parses every query as an AST, denies the dangerous shapes, and writes a durable audit row **before** the query runs.

## What it blocks

- **Destructive writes against production.** Out of the box (no YAML), every write denies — `DELETE FROM users` is denied even with a `WHERE`. Opt in per-table via the `table_access` YAML; mark `feature_flags: read_write` to let the agent update flags while `users` and `payments` stay read-only and `audit_log` stays `deny` (no read either).
- **SQL stacked-statement injection.** `SELECT 1; DROP TABLE users` is denied at parse time.
- **Cross-tenant exfiltration.** Opt in by mapping a tenant column once; queries on that table without the right `WHERE` predicate are denied at any AST depth (subqueries, CTEs, JOINs).
- **CTE-embedded writes.** `WITH x AS (DELETE FROM ...) SELECT * FROM x` doesn't fool the recursive AST walk.

> **Approvals (Slack-bot, web queue, escalation) are a Midplane Cloud feature.** OSS Midplane is policy-as-YAML; Cloud is policy + humans in the loop. The OSS roadmap below adds more YAML-driven controls; it does not add an approval flow.

Pinned by an [adversarial SQL corpus](./docs/adversarial-corpus.md): **105 bypass attempts denied** + 52 legitimate-query controls allowed. **100% line coverage** on the policy surface (`packages/engine/src/policy/*`).

## In a real chat

A `delete all users` prompt to Claude Code, against a Midplane-fronted DB:

> ⏺ Hold on — that's destructive and irreversible. Before I run `DELETE FROM public.users`, please confirm.
>
> *user: confirm delete all users*
>
> ⏺ Midplane blocked it. The denial reason it returned: *"Midplane denied this query because writes to table `users` are not allowed by the table-access policy (`users` resolves to `read`; mark it `read_write` in your MIDPLANE_POLICY_FILE to grant writes)."* The DELETE was audited but not executed.

Two enforcement layers: the agent's own confirmation, then Midplane's policy denial. The audit row lands before the query reaches the DB. Full transcript and demo prompts in [agent-setup.md](./docs/agent-setup.md).

## Quickstart by agent

<details>
<summary><b>Cursor</b></summary>

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "midplane": {
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

Cursor auto-detects Streamable HTTP from the URL. No `transport` key needed.
</details>

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add --transport http midplane http://localhost:8080/mcp
```

`--transport http` is required — without it the CLI defaults to stdio and the URL is treated as a launcher command.
</details>

<details>
<summary><b>Claude Desktop</b></summary>

For local self-host, use the `mcp-remote` shim (the Custom Connectors UI requires HTTPS and rejects `http://localhost`).

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "midplane": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:8080/mcp"]
    }
  }
}
```

Restart Claude Desktop after editing. Hosted Midplane (HTTPS endpoint) uses Custom Connectors normally.
</details>

All three [verified 2026-04-29](./docs/agent-setup.md) against a local container.

## Multiple databases (0.2.0)

One container can serve N Postgres DBs through a single MCP endpoint. Add a `databases:` block to `MIDPLANE_POLICY_FILE`; each entry has its own `url`, `table_access`, and `tenant_scope`. `${ENV_VAR}` is interpolated in `url`, so DSNs stay out of YAML files.

```yaml
databases:
  - name: prod
    url: ${PROD_DATABASE_URL}
    table_access:
      default: read
      tables:
        feature_flags: read_write
    tenant_scope:
      enabled: true
      column: customer_id      # strict: every queried table needs this
      exempt:                  # ...except these
        - audit_log
  - name: analytics
    url: ${ANALYTICS_DATABASE_URL}
    table_access:
      default: read_write
```

When N ≥ 2, `query` and `describe_table` require a `database` arg, `list_tables` accepts an optional `database` (omitted = fan out across all DBs and group results by name), and a new `list_databases` tool reports each DB's name and policy summary. Single-DB users see no change to the tool surface — `database` doesn't appear and `list_databases` isn't registered.

When `databases:` is absent, the `DATABASE_URL` env var + top-level `table_access` / `tenant_scope` shape from 0.1.x keeps working byte-for-byte.

## How it works

1. Agent sends a SQL query via MCP.
2. Midplane parses it with [libpg_query](https://github.com/launchql/libpg-query-node) (the actual Postgres parser).
3. Walks the AST, evaluates policy rules.
4. Writes audit event (durable, **before** execution).
5. Executes against your DB, audits the result, returns it.

If the pre-execute audit write fails, the query never runs.

## Why not just…?

| | Midplane | Anthropic ref Postgres MCP* | Direct connection |
|---|---|---|---|
| AST-based parsing | ✓ | regex blocklist | n/a |
| Stacked-statement injection denied | ✓ | **shipped a CVE** | depends on driver |
| Cross-tenant scope rule | ✓ | ✗ | ✗ |
| Read-only by default | ✓ | ✗ | depends on role |
| Durable audit log (before execute) | ✓ | ✗ | DB-side only, after-the-fact |
| Verified across Cursor / Claude Code / Claude Desktop | ✓ | n/a | n/a |

\* Deprecated 2025 in favor of community implementations; the reference impl was the target of [Datadog Security Labs' stacked-statement injection finding](https://securitylabs.datadoghq.com/).

If your agent already has DB tooling, Midplane sits in front of it as a separate MCP server — you don't have to rip anything out.

## Repo layout

- [`packages/engine`](./packages/engine) — `@midplane/engine`. Parse → policy → audit-attempted → audit-decided → execute → audit-executed pipeline. Embeddable; no MCP dependency.
- [`packages/mcp-server`](./packages/mcp-server) — `@midplane/mcp-server`. Wraps the engine in three MCP tools (`query`, `list_tables`, `describe_table`) over stdio + Streamable HTTP.
- [`docker/`](./docker) — production image (`midplane/midplane`).
- [`docs/`](./docs) — agent setup, policy rules, threat model, adversarial corpus.
- [`examples/cursor-saas-postgres`](./examples/cursor-saas-postgres) — 5-minute walkthrough: Cursor + Midplane in front of your real product DB.
- [`examples/smoketest`](./examples/smoketest) — end-to-end smoketest against a sidecar Postgres.

## Status

`0.2.0` — adds multi-database support (one container, N Postgres DBs through one MCP endpoint). Single-DB users upgrade with no config changes; the existing `DATABASE_URL` + top-level `table_access` shape keeps working byte-for-byte. The audit SQLite gains a `database` column with a one-time `ALTER TABLE` migration on first 0.2.0 boot. `0.1.0` shipped as the first OSS release. Expect to stay on `0.x` for a while; the hosted tier ships separately on its own cadence and is not gated on OSS releases.

Performance against locked spike targets: 154 MB image (under 200 MB budget), cold start ~470 ms (under 500 ms target), ~3.9 ms/call smoketest throughput.

## Roadmap

OSS roadmap (policy-as-YAML, no approvals — those ship in Cloud):

- **Next** — function-side-effects denylist (`pg_terminate_backend`, `lo_unlink`, etc.), session-scope tracking (`BEGIN` / `COMMIT` / `PREPARE`), per-token policy bundles.
- **Later** — fine-grained schema-aware policy (column-level reads), time-of-day rules, fewer false positives on `tenant_scope`.

Approvals (Slack-bot, web queue, escalation) and the dashboard live in Midplane Cloud, not OSS. Tracked in GitHub Issues. PRs welcome.

## Contributing

Issues and PRs welcome. The single highest-leverage contribution is **new entries in [the adversarial SQL corpus](./docs/adversarial-corpus.md)** — bypass attempts (and the policy fixes that defeat them) are how this project earns trust. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the workflow, the PR checklist, and the DCO.

```bash
bun install
bun test                    # run the policy + adversarial corpus
bun run smoketest           # end-to-end against sidecar Postgres
```

For security issues, follow [SECURITY.md](./SECURITY.md). Do not open a public issue.

## Documentation

- [Changelog](./CHANGELOG.md)
- [Threat model](./THREAT_MODEL.md)
- [Self-host](./docs/self-host.md)
- [Agent setup](./docs/agent-setup.md) — verified configs for Cursor, Claude Code, Claude Desktop
- [Trust posture](./docs/trust-posture.md) — what we claim, what we don't
- [Policy rules](./docs/policy-rules.md)
- [Adversarial corpus](./docs/adversarial-corpus.md)
- [Telemetry](./TELEMETRY.md) — what's collected, how to disable (`MIDPLANE_TELEMETRY=0`)

## Acknowledgements

- [libpg_query](https://github.com/launchql/libpg-query-node) — the real Postgres parser, exposed via Node bindings. Midplane is unbuildable without it.
- [Model Context Protocol](https://modelcontextprotocol.io/) — Anthropic's open standard that makes Midplane a drop-in for any MCP-capable agent.
- [Datadog Security Labs](https://securitylabs.datadoghq.com/) — whose research on the deprecated Postgres MCP stacked-statement injection motivates the `multi_statement` rule.

## License

MIT. See [LICENSE](./LICENSE). The license stays MIT — no copyleft, no BSL, no source-available, ever.
