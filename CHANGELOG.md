# Changelog

All notable changes to Midplane are documented here. Entries follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`midplane audit` CLI** (`@midplane/mcp-server`). New unified `midplane` bin with `audit tail | stats | since` subcommands so self-hosters can read the audit log without writing SQL: `docker exec midplane midplane audit tail` for a live JSON-lines stream, `audit stats` for a 24h rollup of event types / deny rules / allow statement types / top agents, `audit since 1h` for a one-shot window dump. Reads SQLite directly (no `INDEXER_TOKEN` needed). Server entry preserved at `midplane server` (default).
- **Anonymous telemetry** (`@midplane/mcp-server`). On startup the server posts a single ULID-keyed event to `https://t.midplane.ai/v1/events`; every 24h it posts a heartbeat with per-tool call counts, denials grouped by policy rule, statement-type buckets, latency histograms (p50/p95/p99), and Postgres failure counts grouped by 2-char SQLSTATE class. No SQL, no fingerprints, no table/column names, no tenant IDs, no error messages — see [`TELEMETRY.md`](./TELEMETRY.md) for the full schema and the "what we never send" list. Disable with `MIDPLANE_TELEMETRY=0` or `DO_NOT_TRACK=1`. Inspect with `MIDPLANE_TELEMETRY=debug`.

## [0.1.0] — Unreleased

First tagged release. The four V1 policy rules — `writes_require_approval`, `multi_statement`, `tenant_scope`, `parse_error` — sit on the `audit-before-execute` pipeline and are pinned by [an adversarial SQL corpus](./docs/adversarial-corpus.md) covering CTE-hidden writes, stacked-statement injection, cross-tenant exfiltration, parser edges, and exec-side-effects. Agent compatibility verified across Cursor, Claude Code, and Claude Desktop on 2026-04-29.

### Added

- **`@midplane/engine`** — parse → policy → audit-attempted → audit-decided → execute → audit-executed pipeline with `{ policy, audit, credentials, executor }` dependency injection. Four AST-recursive policy rules; `SqliteAuditWriter` (bun:sqlite, WAL, append-only) and `PostgresAuditWriter` for the hosted write-through path. `AuditUnavailableError` is thrown when the pre-execute audit write fails — the query never runs.
- **`@midplane/mcp-server`** — wraps the engine with three V1 MCP tools (`query`, `list_tables`, `describe_table`) over stdio and Streamable HTTP. Per-session HTTP transport with `fly-replay: cache_key=<id>` mirror; zod-validated config from `DATABASE_URL` / `PORT` / `DB_PATH` / `MIDPLANE_TENANT_ID` / `MIDPLANE_POLICY_FILE` / `MIDPLANE_TRANSPORT`; `pg.Pool` executor; pino ops logger (audit stays in `engine.audit`).
- **Production Docker image** — multi-stage `oven/bun:1.3-alpine` build, isolated workspace `node_modules`, non-root `midplane:midplane` (1001:1001) runtime user, curl-based `HEALTHCHECK` on `/health`. Multi-arch (`linux/amd64` + `linux/arm64`), published to `midplane/midplane` on Docker Hub via the `v*` tag workflow.
- **Adversarial SQL corpus** — `packages/engine/test/adversarial/` mirrors [`docs/adversarial-corpus.md`](./docs/adversarial-corpus.md) one-to-one: writes-recursive, multi-statement, tenant-scope, parse-edges, exec-side-effects.
- **Agent setup docs + tooling** — [`docs/agent-setup.md`](./docs/agent-setup.md) with verified Cursor / Claude Code / Claude Desktop configs, `scripts/agent-smoke.sh` interactive local boot (sidecar Postgres, demo schema, audit-tail), `scripts/test-image.sh` CI-shaped local gate, and `packages/mcp-server/verify-mcp-handshake.ts` raw-`fetch` Streamable HTTP wire verifier (locked at the test layer via `handshake-wire.test.ts`).

### Verified

- **100% line coverage** on the V1 policy surface (`packages/engine/src/policy/*`). `packages/engine/src/parser/parse.ts` at 91.67% — the three uncovered lines are defensive crash branches that require fault injection.
- **MCP compatibility** across Cursor, Claude Code, and Claude Desktop on 2026-04-29 — all three connect to a local self-host instance and reach the three V1 tools. `writes_require_approval` denial path exercised end-to-end in Claude Code.
- **Performance against locked spike targets** — 154 MB image (under 200 MB budget), cold start ~470 ms (under 500 ms target), ~3.9 ms/call smoketest throughput.

### Hardened

- **`writes_require_approval` denies side-effect statements**, not just DML: `NotifyStmt`, `ListenStmt`, `UnlistenStmt`, and `LockStmt` are now in `WRITE_KINDS`. Postgres pubsub publication, session subscription mutations, and explicit table locks are outside the V1 read-only contract.
- **Empty-AST parse rejection.** Comment-only inputs (`-- nothing`, `/* nothing */`) previously parsed cleanly to `stmts=[]` and produced a no-op ALLOW. Now rejected with `parse_error: "no statements"`.
- **CTE-embedded writes are denied.** The policy visitor walks the entire AST in a single recursive pass; `WITH x AS (DELETE FROM ... RETURNING *) SELECT * FROM x` is denied at the inner DELETE node regardless of the outer statement type. Same recursive walk applies to `tenant_scope` across UNION arms, subqueries, CTEs, and DML relations.
- **Audit-before-execute ordering.** A query that ran but didn't audit is treated as worse than a query that didn't run: if the `ATTEMPTED` or `DECIDED` audit write fails, the engine throws `AuditUnavailableError` and the query never reaches the database. Post-execute audit failures (`EXECUTED` / `FAILED`) are logged to ops but non-fatal — the pre-execute rows already prove intent.

### Known V1 limitations

Documented in [`docs/adversarial-corpus.md`](./docs/adversarial-corpus.md): SELECT-wrapped admin functions (`pg_terminate_backend`, `pg_cancel_backend`, `lo_unlink`), `BEGIN` / `COMMIT`, `VACUUM`, and `PREPARE` / `DEALLOCATE` currently allow. These are deferred to V1.5 (function-side-effects denylist + session-scope tracking) rather than patched into V1.

[0.1.0]: https://github.com/midplaneai/midplane/releases/tag/v0.1.0
