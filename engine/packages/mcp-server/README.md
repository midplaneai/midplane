# midplane

**Safe-by-default SQL guardrails for AI agents.** An MCP server that sits between
an AI agent (Claude, Cursor, any MCP client) and your Postgres database. It parses
every statement with a real SQL AST — not a regex blocklist — enforces a
declarative per-table access policy, blocks destructive DML/DDL, and writes an
audit row **before** the query executes.

[![npm](https://img.shields.io/npm/v/midplane.svg)](https://www.npmjs.com/package/midplane)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

📖 Full documentation: **[midplane.ai/docs](https://midplane.ai/docs)**

## Point an agent at it

No install — `npx` fetches it on first run. Add this to your MCP client's config
(Claude Code, Claude Desktop, Cursor — they all take this shape):

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

The DSN belongs in that `env` block, not on a command line — a connection string
passed as a CLI argument leaks the password to `ps aux` and your shell history.

Out of the box: reads are allowed, writes and DDL are denied, and every query is
audited. Nothing to configure to be safe — configure only to open things up.

## Write a policy

```bash
npx -y midplane init
```

Connects read-only, introspects your schema, suggests a tenant column, and writes
a validated `midplane.policy.yaml`. Point the server at it with
`MIDPLANE_POLICY_FILE`. The non-interactive equivalent for CI is
`midplane policy init`.

## What it blocks

- **Destructive writes by default** — `DELETE FROM users` is denied even with a
  `WHERE`, until you opt the table into `read_write`.
- **Whole-table wipes and schema destruction** — no-`WHERE` `DELETE` / `UPDATE`
  and all `DROP` / `TRUNCATE` / `ALTER`, regardless of table policy.
- **Stacked-statement injection** — `SELECT 1; DROP TABLE users` denied at parse time.
- **Writes hidden inside a read** — `WITH x AS (DELETE FROM users RETURNING *)
  SELECT * FROM x` is denied at the inner `DELETE`. The same recursive walk
  covers subqueries, UNION arms, and JOINs.

## CLI

```
midplane [server]    Run the MCP server   (--stdio | --http)
midplane init        Interactive setup: introspect the DB, write a policy
midplane query ...   Send one query through the server as an agent would
midplane doctor      Preflight + smoke checks (config, DB, audit, canary)
midplane audit ...   Read the local audit log (tail | since | denies | show | stats)
midplane policy ...  Author/validate/lint/dry-run a policy file
```

The audit log is a local SQLite database at `~/.midplane/audit.db` (override with
`DB_PATH`). `midplane audit denies` answers the question operators actually ask:
what got blocked, and why.

## Transports

- **stdio** (`--stdio`) — how MCP clients spawn a local server.
- **Streamable HTTP** (`--http`, the default) — serves `/mcp` on `PORT` (8080).

## Other ways to run it

- **Docker** — `midplane/midplane`, a self-contained image with no Node or
  `node_modules` in it.
- **Managed cloud** — [app.midplane.ai](https://app.midplane.ai), with a
  dashboard, policy editor, and hosted audit log.
- **Self-host the full app** — `./bin/self-host up` from the
  [repo](https://github.com/midplaneai/midplane).

## Requirements

Node 22.16+ or 24+ (the audit log uses the `node:sqlite` builtin), or Bun 1.3+.
No native modules, no compiler needed at install.

## Telemetry

Anonymous, on by default, documented in full in
[TELEMETRY.md](https://github.com/midplaneai/midplane/blob/main/engine/TELEMETRY.md).
No SQL, no table or column names, no identifiers. Disable with
`MIDPLANE_TELEMETRY=0` or `DO_NOT_TRACK=1`.

## License

MIT — see [LICENSE](./LICENSE). Source at
[github.com/midplaneai/midplane](https://github.com/midplaneai/midplane).
Security issues: see
[SECURITY.md](https://github.com/midplaneai/midplane/blob/main/engine/SECURITY.md) —
please don't open a public issue.
