# Midplane

A safety layer between AI coding agents (Cursor, Claude Code, Claude Desktop) and your Postgres database. Parse, policy, audit. Read-only by default; writes require approval.

```
docker run -e DATABASE_URL=$YOUR_PG_URL -p 8080:8080 midplaneai/midplane:latest
```

That's it. The MCP endpoint comes up at `http://localhost:8080/mcp`. Paste it into your agent's MCP config and your agent now goes through Midplane.

## What it blocks

- Destructive writes against production. `DELETE FROM users` (even with a `WHERE`) is denied unless you opt in to write mode.
- SQL stacked-statement injection. `SELECT 1; DROP TABLE users` is denied at parse time.
- Cross-tenant exfiltration. Opt in by mapping a tenant column once; queries on that table without the right `WHERE` predicate are denied at any AST depth (subqueries, CTEs, JOINs).
- CTE-embedded writes. `WITH x AS (DELETE FROM ...) SELECT * FROM x` doesn't fool the recursive AST walk.

## How it works

1. Agent sends a SQL query via MCP.
2. Midplane parses it with [libpg_query](https://github.com/launchql/libpg-query-node) (the actual Postgres parser).
3. Walks the AST, evaluates policy rules.
4. Writes audit event (durable, before execution).
5. Executes against your DB, audits the result, returns it.

If audit fails, the query doesn't run.

## Status

V1 in active development. Free hosted tier and OSS self-host both ship at launch.

Verified across **Cursor**, **Claude Code**, and **Claude Desktop** on 2026-04-29 — all three connect to a local self-host instance and reach the three V1 tools (`query`, `list_tables`, `describe_table`). The `writes_require_approval` denial path was exercised end-to-end in Claude Code; see [agent-setup.md](./docs/agent-setup.md) for setup details.

- [Threat model](./THREAT_MODEL.md)
- [Self-host docs](./docs/self-host.md)
- [Agent setup](./docs/agent-setup.md) — verified configs for Cursor, Claude Code, Claude Desktop
- [Trust posture](./docs/trust-posture.md)
- [Policy rules](./docs/policy-rules.md)

### Maintainer notes

The `publish-docker` workflow pushes to Docker Hub on every `v*` tag. Before
the first release tag, set repo secrets `DOCKERHUB_USERNAME` and
`DOCKERHUB_TOKEN`. GHCR uses the built-in `GITHUB_TOKEN` and needs no setup.

## License

MIT. See [LICENSE](./LICENSE).
