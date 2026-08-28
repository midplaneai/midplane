# midplane

**Postgres MCP server for AI agents.** Connect the tables you've been keeping
off-limits. PII masked at the source, policy enforced on the SQL AST, writes held
for human approval, everything audited. MIT, self-hostable.

It sits between an AI agent (Claude, Cursor, any MCP client) and your Postgres
database: every statement is parsed with a real SQL AST — not matched against a
regex blocklist — checked against a declarative per-table access policy, rewritten
so masked columns never leave the database in the clear, and recorded in an audit
row **before** the query executes.

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

Keep the connection string in that `env` block rather than on a command line,
where it would leak to `ps aux` and your shell history. The block still lands in
a plaintext config file, so give Midplane its own least-privilege Postgres role:
it governs which SQL runs, not what the role underneath it can reach.

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

- **Destructive writes by default** — a `DELETE` targeting a table is denied even
  when it carries a `WHERE`, until you opt that table into `read_write`.
- **Whole-table wipes and schema destruction** — unqualified `DELETE` / `UPDATE`
  (no `WHERE`), and every `DROP` / `TRUNCATE` / `ALTER`, regardless of the
  table's access level.
- **Stacked-statement injection** — two statements separated by a semicolon in a
  single call are refused at parse time. This is the canonical injection vector
  and is denied unconditionally.
- **Writes hidden inside a read** — a CTE that performs a write and then selects
  from it is denied at the inner write, not the outer `SELECT`. The same
  recursive walk covers subqueries, UNION arms, and JOINs.

Worked examples of each, with the exact SQL and the denial message, are in the
[policy reference](https://midplane.ai/docs) and the repository README.

## Mask columns, hold writes

Two more sections of the same policy file, for the tables you'd otherwise keep
off-limits:

- **`column_masks`** — name a column and the transform to apply, and the engine
  rewrites the query's source relation so the raw value never leaves Postgres.
  `full-redact`, `null-out`, `consistent-hash` (deterministic and salted, so
  masked join keys still join), `partial`, `generalize`, `pseudonymize`, `noise`.
  Set `MIDPLANE_MASK_SALT` — the engine refuses to boot with masks and no salt
  rather than fall back to a correlatable hash — and `mask_source_rewrite: true`
  for the source-rewrite path. Result provenance the engine can't prove maps to a
  known base column denies the whole result set rather than risk leaking a value.
- **`approvals`** — hold a write the policy already permits until a human rules on
  it. The engine asks a gate over HTTP (`MIDPLANE_APPROVAL_URL` +
  `MIDPLANE_APPROVAL_TOKEN`; the app below serves one) and offers the agent a
  `check_approval` tool to collect the answer. Approvals sit under the policy,
  never over it: nothing denied can be approved into running.

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
  dashboard, policy and masking editors, an approval queue, and a hosted audit log.
- **Self-host the full app** — `./bin/self-host up` from the
  [repo](https://github.com/midplaneai/midplane).

## Requirements

Node 22.16+ or 24+ (the audit log uses the `node:sqlite` builtin), or Bun 1.3+.
`npx` ships with Node, so there is nothing else to install — no native modules,
no compiler. Below 22.16 the bin refuses to start and tells you why, rather than
failing partway through with a stack trace from whichever dependency happened to
reach a newer builtin first.

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
