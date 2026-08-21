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
- **Destructive writes against production.** Policy rule `table_access` denies any write whose target table isn't `read_write` in the YAML policy (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `DROP`, `TRUNCATE`, `ALTER`, `GRANT`, `REVOKE`, `CREATE`, `EXECUTE`, `CALL`, `COPY`, etc.) at any AST depth. With no YAML, every write denies (matching the original deny-all-writes posture). With YAML, per-table read/read_write grants are explicit and AST-recursive (CTEs, subqueries, UNION arms). The `approvals` section adds a human on top of a grant: a write the policy permits is held until someone rules on it. Approvals sit *under* the policy — a denied statement can never be approved into running — and require a gate to answer them (`MIDPLANE_APPROVAL_URL`, served by the control plane, cloud or self-hosted); with approvals on and no gate the server refuses to boot.
- **Whole-table wipes and schema destruction on writable tables.** Policy rule `dangerous_statement` (the `guardrails` section, on by default) denies `DELETE`/`UPDATE` with no `WHERE` clause and all `DROP`/`TRUNCATE`/`ALTER` — **regardless of `table_access`**, so granting a table `read_write` for legitimate writes can't be escalated into `DELETE FROM orders` or `DROP TABLE orders`. Caught at any AST depth (a no-`WHERE` DELETE inside a CTE included). Opt out per flag (`guardrails.block_ddl: false` / `guardrails.block_unqualified_dml: false`). A third flag, `guardrails.block_dml`, refuses row-scoped writes too; it is **off** by default, since refusing ordinary row changes is a lockdown rather than a safety net. It also covers writes with no destructive operation to name (`CREATE TABLE`, `CREATE TABLE AS`, `SELECT … INTO`), which materialize data just as a row change does — so a database that refuses row changes cannot be made to stage data in a new relation instead.
- **CTE-embedded writes.** Recursive AST walk catches `INSERT/UPDATE/DELETE` at any depth, even when the top-level statement is a `SELECT`.
- **PII reaching an agent that has a legitimate read.** The `column_masks` section transforms declared columns; under source rewrite (`mask_source_rewrite: true`) the rewrite happens at the source relation, so the raw value never leaves Postgres and the mask applies inside joins, filters, and aggregates rather than being scrubbed from the rows afterwards. It fails closed in both directions: result provenance the engine can't map back to a known base column denies the whole result set, and every function a masked statement invokes must be a vetted mask-safe builtin — so a read of a masked table through a string the parser can't see (`query_to_xml`, `dblink`, an FDW, a `SECURITY DEFINER` UDF) is denied rather than answered with raw PII. Deterministic transforms are keyed by `MIDPLANE_MASK_SALT`; the engine refuses to boot with masks and no salt. This is a redaction control for values Midplane returns, **not** a substitute for Postgres column privileges — see the out-of-scope note on the customer DB role below.

## Attack vectors NOT covered (out of scope today)

- **Compromised customer DB role.** If your agent's connection string belongs to a privileged role, Midplane operates on top of those permissions. We do not replace Postgres role-based access control. Best practice: create a scoped role for your agent.
- **Cross-tenant isolation.** Midplane is not your tenant-isolation boundary. The engine ships an opt-in `tenant_scope` rule (off by default, documented in [`docs/policy-rules.md`](./docs/policy-rules.md)) that denies a query on a scoped table unless the AST carries a literal `WHERE {column} = {tenant_id}` predicate at the same scope. It does what it says, but how an agent's identity binds to a tenant id is not settled, so we make no isolation guarantee on top of it. Enforce tenant isolation in Postgres with row-level security.
- **Supply chain attack on the published artifacts.** Midplane publishes two artifacts from one `engine-v*` tag: the Docker image (`midplane/midplane` on Docker Hub and GHCR) and the `midplane` npm package. Mitigations: registry-side access control, multi-arch image digests, and — for npm on every release after 0.19.0 — [provenance attestations](https://docs.npmjs.com/generating-provenance-statements), so `npm view midplane` resolves the tarball back to the commit and workflow that built it. **0.19.0 is the exception and has no attestation**: npm requires an interactive 2FA session to create a package, and that session has no CI identity to sign with, so the first release was published by hand. Check for yourself with `npm view midplane dist.attestations` rather than taking this paragraph's word for it. The npm tarball is a single readable bundle with no install scripts and no native modules, so there is no compile step to subvert and the published artifact can be diffed against the source. **A dependency of ours is still a dependency of yours**: the package leaves its eight runtime dependencies external precisely so they stay visible to `npm audit` rather than vendored into our tarball, which means a compromise upstream of `pg`, `libpg-query`, or the MCP SDK reaches you through us. Pin the version you run. `@midplane/engine` remains a workspace identifier, not a published package.
- **Malicious agent prompt before it reaches Midplane.** If the agent is jailbroken to bypass the MCP server entirely (e.g., direct DB connection through other means), Midplane sees nothing. We secure the path through us, not all paths.
- **Agent leaking query results outside Midplane's view.** Midplane denies, masks, and audits queries; what the agent does with the rows it legitimately received is the agent's responsibility (and the user's session). Masking narrows what those rows contain — it does not follow them once they leave.
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
