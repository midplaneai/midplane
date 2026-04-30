# Midplane Threat Model

Status: pre-launch draft. Refines through implementation; updated before public launch.

## Trust boundaries

```
[ Agent (Cursor/Claude Code/etc.) ]
            │
            │  MCP protocol (stdio for self-host, Streamable HTTP for hosted)
            ▼
[ Midplane MCP Server ]
            │
            │  in-process call
            ▼
[ Midplane Engine: parse → policy → audit → execute → audit ]
            │
            │  pg.Pool connection
            ▼
[ Customer's Postgres ]
```

For hosted only: the customer's Postgres URL is encrypted at rest with a per-tenant AWS KMS key. Decrypted in process memory at query time, cached for up to 10 minutes (with up to 60 additional minutes of grace if KMS is unreachable, after which new sessions are refused). Never written to disk.

## Attack vectors covered

- **SQL injection via raw text in MCP arguments.** AST-based parsing (libpg_query); no regex. Anything that doesn't parse is denied.
- **Multi-statement injection** (Datadog SQLi vector). Parser detects multiple statements; policy rule `multi_statement` denies.
- **Destructive writes against production.** Policy rule `table_access` denies any write whose target table isn't `read_write` in the YAML policy (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `DROP`, `TRUNCATE`, `ALTER`, `GRANT`, `REVOKE`, `CREATE`, `EXECUTE`, `CALL`, `COPY`, etc.) at any AST depth. With no YAML, every write denies (matching the original deny-all-writes posture). With YAML, per-table read/read_write grants are explicit and AST-recursive (CTEs, subqueries, UNION arms). Approval workflows on top of denial are a Midplane Cloud feature, not OSS.
- **Cross-tenant exfiltration** (Supabase service-role pattern). Opt-in tenant scope rule; denies any query against a mapped table without a literal `WHERE {column} = {tenant_id}` predicate at the same scope. Conservative: subqueries, CTEs, UNION arms, JOINs all enforced.
- **CTE-embedded writes.** Recursive AST walk catches `INSERT/UPDATE/DELETE` at any depth, even when the top-level statement is a `SELECT`.

## Attack vectors NOT covered (out of scope today)

- **Compromised customer DB role.** If your agent's connection string belongs to a privileged role, Midplane operates on top of those permissions. We do not replace Postgres role-based access control. Best practice: create a scoped role for your agent.
- **Supply chain attack on the published artifacts.** Midplane ships only as a Docker image (`midplane/midplane` on Docker Hub) — `@midplane/engine` and `@midplane/mcp-server` are workspace identifiers, not published npm packages. Hub-side access control + multi-arch image digests are the current mitigation. npm publishing with provenance attestations is on the roadmap once the runtime story (currently Bun-only via `bun:sqlite`) supports a Node consumer path.
- **Malicious agent prompt before it reaches Midplane.** If the agent is jailbroken to bypass the MCP server entirely (e.g., direct DB connection through other means), Midplane sees nothing. We secure the path through us, not all paths.
- **Agent leaking query results outside Midplane's view.** Midplane denies and audits queries; what the agent does with returned rows after the fact is the agent's responsibility (and the user's session).
- **Metadata side-channel attacks against the audit log.** Audit row count and timing are observable to the customer's own infrastructure operators. No guarantee against insider threat at the customer.

## Residual exposure (hosted)

- **Decrypted credentials in process memory** for the cached TTL plus grace window (max 70 minutes per credential after last KMS contact).
- **Connection pools held warm** during the cache window. A process compromise during this window exposes warm connections.
- **Postgres index of audit data** is queryable by Midplane operators with database access until retention expires (Free tier: 7 days; Pro: 90 days; Team: 1 year).
- **In-flight session cookies / MCP tokens** as you'd expect for any HTTP service.

## Out of scope (self-host)

Self-host has no Midplane-controlled infrastructure exposure. Customer's Postgres URL stays in their environment. Audit log is local SQLite. Trust posture reduces to "do you trust the OSS code you're running?" — and the answer is "you can read it before you run it."

## Reporting a vulnerability

See [SECURITY.md](./SECURITY.md).
