# Changelog

All notable changes to Midplane are documented here. Entries follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`midplane policy` CLI — author, trust, and dry-run a `MIDPLANE_POLICY_FILE` without hand-editing YAML blind.** Closes the "self-host is just hand-written YAML" gap; four subcommands on the existing `midplane` binary:
  - `midplane policy init [--url $DATABASE_URL] [--tenant-column <col>] [-o <file>]` — scaffold a commented policy file. With `--url`, it connects, lists every table in the `public` schema (the same `information_schema` query the `list_tables` tool runs, read-only), and emits each under `table_access` with `default: read` and a flip-to-`read_write` hint. With `--tenant-column`, it emits a strict `tenant_scope` block on that column (`exempt: [audit_log]`). The DSN is never printed or written into the file.
  - `midplane policy validate <file>` — parse the YAML and check it against the *same* zod schema the server boots with. Prints `OK`, or `INVALID` + each error (zod path + message). Exit nonzero on invalid. Offline: an unset `${VAR}` in a `databases[].url` doesn't fail a structural check.
  - `midplane policy lint <file>` — security-posture findings beyond schema validity: `default: read_write`, tables granted writes, missing/disabled `tenant_scope`, audit-style tables left scoped, policies that restrict nothing. `[ERROR]` findings exit nonzero (CI gate); warnings exit 0.
  - `midplane policy test <file> --sql "<query>" [--tenant-id <id>] [--db <name>] [--json]` — run a query through the engine's real `evaluate()` against the file's policy (no DB connection) and print the decision, the rule, and the exact agent-facing message a denial would return. The dry-run authors use to answer "would this pass, and what would the agent see?"

## [0.7.0] — 2026-06-01

### Added

- **MySQL dialect (Phase 1 PR2 of the multi-DB roadmap).** A database configured with `dialect: mysql` now runs end-to-end — parse → normalized IR → the *same, unchanged* policy rules → `mysql2` → audit. Set it per DB in the policy YAML:

  ```yaml
  databases:
    - name: warehouse
      url: mysql://app:secret@db:3306/app_db   # the DSN MUST name the database
      dialect: mysql
      table_access: { default: read, tables: { users: read_write } }
      tenant_scope: { column: org_id, exempt: [regions] }
  ```

  The dialect uses [`node-sql-parser`](https://www.npmjs.com/package/node-sql-parser) (MySQL mode, pinned to an exact version — a parser-fidelity regression on a minor bump is a silent-bypass vector for a security tool) and emits the identical `NormalizedProgram` the Postgres adapter does, so `table_access`, `tenant_scope`, `multi_statement`, and `parse_error` produce byte-identical verdicts across dialects. The shipped PG verdict baseline is unchanged; `packages/engine/src/policy/` is byte-unchanged — a new dialect adds an adapter, not rule edits.

- **MySQL bare-name soundness (the analog of the PG `search_path` pin).** The MySQL `Executor` (`mysql2/promise`, `multipleStatements: false`) relies on the DSN-pinned database, and the adapter enforces the parser-side half, fail-closed:
  - `USE <db>` is denied (`unsupported` → `table_access` no-target), independent of the `multipleStatements` guard — a standalone `USE` is denied.
  - Any `db.table` / `db.table.col` reference whose database is neither the connected database nor the `information_schema` discovery carve-out is denied (a cross-database reference is a tenant bypass even with the database pin). Caught even when the foreign qualifier appears only in a `WHERE` column reference.
  - `INSERT … ON DUPLICATE KEY UPDATE` and `REPLACE` take the upsert deny path on tenant-scoped tables (a unique-key collision can clobber another tenant's row). `MERGE` is rejected at parse (`node-sql-parser` does not accept it in MySQL mode) → `parse_error` deny.
  - A CTE named after a table that its own body reads is **not** mistaken for a CTE reference: a non-recursive CTE's name does not bind in its own body, so `WITH audit_log AS (SELECT * FROM audit_log) SELECT * FROM audit_log` reads the real `audit_log` and is policy-checked (previously the body read was silently skipped). This also fixes the identical pre-existing bug in the **Postgres** adapter (present since the normalized-IR refactor in #26); recursive CTEs keep their self-reference bound. Legitimate shadowing (a CTE whose body reads nothing real) still allows.
  - Anything the parser can't faithfully model is `unsupported` → denied. We accept false denials to never accept a false allow.

- **`dialect` on DECIDED audit rows.** Every `DECIDED` audit payload now carries the dialect the query was parsed under (`"postgres"` | `"mysql"`). Additive + optional under `audit.schema_version: 3` (no bump) — same pattern as the `database` (0.2.0) and `mcp_token_id` (0.6.0) columns.

- **`dialect: mysql` unlocked in policy YAML.** `DatabaseEntrySchema.dialect` accepts `postgres | mysql`; unknown values (e.g. `sqlite`, Phase 1.5) still fail loudly at boot via the zod enum.

### Changed

- **Metadata tools route through the dialect.** `list_tables` / `describe_table` build their `information_schema` discovery SQL from the dialect's `listTablesSql` / `describeTableSql` (surfaced through the engine registry's `EngineEntry`, since `Engine.dialect` is private) instead of hardcoding it. Postgres and MySQL emit identical `information_schema` SQL; the seam exists so a future dialect without `information_schema` can override it. An omitted `schema` now defaults per dialect: Postgres → `public`, MySQL → the connected database (`information_schema.table_schema` is the database name in MySQL, so the old `public` default returned zero rows). A fan-out `list_tables` across mixed dialects uses each DB's own default.
- `ParseResult.ast` is now `unknown` at the `Dialect` / policy / public-API seam — each dialect's native AST is private to its own `normalize()`. The Postgres `parse()` export still returns the concrete `PgParseTree` shape, so direct callers are unaffected. The engine fingerprints the AST through `normalizeForFingerprint(node: unknown)` unchanged.

### Why

Single-DB framing caps the product; the cross-backend audit schema + the one adversarial corpus that pins every dialect at once is the compounding moat. MySQL is the forcing function that proves the normalized-IR seam (shipped PG-only in 0.6.x) is genuinely dialect-agnostic: the rules didn't change, yet a MySQL DB gets the identical decision for the identical query. node-sql-parser runs in-process (no sidecar) per the roadmap's Phase-1 scope; the higher-fidelity sqlglot sidecar (Phase 2) becomes a pure parse/normalize adapter swap — the rules never change. SQLite is deferred to Phase 1.5.

## [0.6.0] — 2026-05-20

### Added

- **Per-token audit attribution via `X-Midplane-Token-Id`.** The cloud proxy injects an `X-Midplane-Token-Id` HTTP header on every forwarded MCP request, naming the cloud-side token that opened the session. The engine reads it once at the MCP `initialize` handshake, caches it on the session, and stamps `mcp_token_id` on every audit row emitted from that session — `ATTEMPTED`, `DECIDED`, `EXECUTED`, `FAILED`. The SQLite `audit_events` table grows a nullable `mcp_token_id TEXT` column (in-place `ALTER TABLE` migration on first 0.6.0 boot); existing rows read NULL. `GET /audit/since/<cursor>` returns the field under the same snake_case key in every row's JSON. `midplane audit tail | since` JSON output picks it up automatically. The hosted Postgres mirror schema (`audit_events_index`) and `PostgresAuditWriter` get the same column. The deny-webhook payload also carries `mcp_token_id`, additive-nullable (receivers that don't know the field ignore it; receivers that want per-token attribution start reading it).

  Header is **header-only** — no fallback channels. Format is a 26-char Crockford base32 ULID (`^[0-9A-HJKMNP-TV-Z]{26}$`); a defensive 64-char cap is applied before any validation so a pathological header never reaches the regex. A present-but-malformed header is **ignored** (treated as no header); the request is never rejected — the engine remains tolerant of misbehaving clients. Stdio sessions, non-MCP callers (admin endpoints, audit pull), and `POLICY_RELOADED` rows always have `mcp_token_id = NULL`. The `audit.schema_version` does NOT bump (stays at `3`): the column is additive-nullable, same pattern as the `database` column added in 0.2.0 — v3 readers ignore the unknown column on the wider row, v3 writers fill it.

### Why

The "safer than direct DSN" trust posture for cloud Midplane requires audit rows to answer "which token ran this query?" customers issuing multiple named tokens per connection (e.g., one for CI, one for an interactive analyst) need to attribute every query to the token that authorized it, not just to the customer's MCP session. Pre-0.6.0 the engine had no channel from the cloud proxy to the audit row that carried token identity. This shipping the OSS half of a lockstep cloud/OSS change: the cloud-side `mcp_tokens` table and `audit_events_index.mcp_token_id` column ship in cloud PR1 (independent of this release); cloud PR2 then pins to this tag, the proxy starts injecting the header, and the indexer reads `mcp_token_id` from this PR's pull payload into the cloud audit table.

The header-only, ignore-malformed contract was chosen over a multi-channel resolver (the 0.3.0 `agent_intent` design ripped out in 0.4.0) because the cloud proxy is the only legitimate source — there's no scenario where a self-host operator hand-injects token ids — and tolerating malformed input keeps the engine from being weaponized against its own clients by a misconfigured intermediary. The session-frozen capture at MCP `initialize` (rather than re-read per request) matches the proxy's per-token session affinity and prevents a mid-session attacker from re-stamping rows under a different token id.

## [0.5.0] — 2026-05-18

### Added

- **`tenant_scope` strict mode.** New `column:` top-level field declares the universal tenant column. When set, every queried table is tenant-scoped unless listed in the new `exempt:` array, or covered by `overrides:` (renamed from `mappings`). Lookup precedence per table: `exempt[table]` → `overrides[table]` → `column`. Closes the silent-leak class that 0.4.x's `mappings`-only design left open: a table that an operator forgot to list was silently unscoped; now the operator declares the invariant (`column`) and the exceptions (`exempt`), and a forgotten table denies by default. The engine does no schema introspection — the rule's job is checking whether the AST carries `WHERE <column> = <tenant_id>` at every scope where a scoped table appears; if the column doesn't exist on a queried table, Postgres surfaces the column-missing error (operator's cue to add the table to `exempt` or `overrides`). The deny *forces* classification rather than silently failing.

  ```yaml
  tenant_scope:
    enabled: true
    column: tenant_id        # universal default
    overrides:               # tables that use a different column
      orders: org_id
    exempt:                  # tables that intentionally don't filter
      - audit_log
      - regions
  ```

- **POLICY_RELOADED `tenant_scope` payload + diff extended.** The audit row's `payload.tenant_scope` now carries `{ column, overrides, exempt }` (replaces the 0.4.x `{ mappings }` blob). `payload.diff.tenant_scope` gains `column.{from,to}`, `overrides_added/removed/changed` (replaces `mappings_*`), and `exempt_added/removed`. The cloud audit dashboard's structured diff renderer indexes against this shape — operators read what changed from the row alone, no dashboard cross-reference required.
- **DML predicate checks for UPDATE / DELETE / INSERT-VALUES.** Pre-0.5.0 the rule blanket-denied any DML on a mapped table, which was over-conservative once strict mode made it possible to scope every `read_write` table. `UPDATE t SET ... WHERE tenant_col = <ctx>` and `DELETE FROM t WHERE tenant_col = <ctx>` now allow (same WHERE-predicate matcher as SELECT). `INSERT INTO t (..., tenant_col, ...) VALUES (..., <ctx>, ...)` allows when the tenant column is explicitly in the column list and every row's literal at that position equals `ctx.tenant_id`. `INSERT … SELECT`, `INSERT … ON CONFLICT DO UPDATE`, and `MERGE` remain conservatively denied on scoped targets — operators must `exempt` to use them.
- **`information_schema` carve-out for `tenant_scope`.** Matches the existing `table_access` carve-out at table-access.ts:447. The canned `list_tables` and `describe_table` tools (which query `information_schema.tables` and `information_schema.columns`) now work under strict mode without forcing operators to enumerate every system view in `exempt`. `pg_catalog` is intentionally not carved out, mirroring `table_access`.
- **`describe()` / `list_databases` returns the live strict-mode state.** `tenant_scope_column`, `tenant_scope_overrides`, and `tenant_scope_exempt` replace the 0.4.x `tenant_scope_mappings` field. `tenant_scope_enabled` is now true iff `column` is set OR `overrides` is non-empty (exempt-only is inert). Cloud callers use these to round-trip what they pushed.

### Changed (Breaking)

- **MCP wire shape: `tenant_scope_mappings` removed from `list_databases`.** Replaced with the three fields named above. Consumers reading the JSON output of `list_databases` need to update their parsers. The cloud dashboard reads through the new fields.
- **POLICY_RELOADED `payload.tenant_scope` shape changed.** A consumer pinned to `payload.tenant_scope.mappings` reads `undefined`; the equivalent data lives under `payload.tenant_scope.overrides` (or, for strict-mode configs, `payload.tenant_scope.column`). Same change for `payload.diff.tenant_scope.mappings_*` → `overrides_*`. The 0.4.0 `sections_changed` / `databases_changed` keys are unchanged.
- **`@midplane/engine` rule signature widened.** `tenantScope()` now accepts a rich `TenantScopeConfig` (`{ defaultColumn, overrides, exempt }`) or a getter returning one, in addition to the legacy flat-record source (still supported as a back-compat shim — a plain `Record<string, string>` is read as `{ defaultColumn: null, overrides: <record>, exempt: [] }`).
- **Engine context shape extended.** `EngineContext.tenant_scope` accepts the rich form (`defaultColumn` / `overrides` / `exempt`) in addition to the legacy `mappings` field, for tests that wire config via ctx rather than through a holder. Production wires this through `tenantScope()`'s source argument.

### Changed (Compatible)

- **`mappings` is a deprecated alias for `overrides`.** YAML configs that use `mappings: { ... }` continue to load and behave identically to pre-0.5.0 — `mappings` is read as `overrides` with no top-level `column` (legacy mode, only listed tables checked). Setting both `mappings` and `overrides` in the same document is rejected at parse time with a clear error. The alias will be removed in a later release; migrate to `overrides`. Recommended upgrade path: add `column: <your_tenant_col>` and move per-table exceptions to `overrides` / `exempt`.

### Why

The 0.4.x `tenant_scope.mappings` design was opt-in: any table not listed in the mapping dict was silently unscoped. The shape was asymmetric with `table_access`: `table_access.default: deny` was the canonical safety knob, but `tenant_scope` had no equivalent. Cloud onboarding kept exposing the failure mode — operators introspect their schema, see 40 tables, mark 8 in `mappings`, ship, then a new table gets added that wasn't on the original list, and the agent reads it cross-tenant with no signal.

Strict mode flips the default. The operator declares one invariant (`column`) and any exceptions (`exempt`); every other table is denied by construction. The dangerous path is named, not silent. An alternative design ("introspect-at-boot" — the engine checks the live schema to know which tables have the column) was rejected: it pulls in DB availability at startup, cache invalidation on schema changes, and a fuzzy "if the schema has it" lookup. This design needs no introspection: a missing column produces a Postgres error that surfaces back to the operator as a cue to update the YAML.

## [0.4.0] — 2026-05-02

### Changed (Breaking)

- **Per-call agent intent collapsed into a single structured tool arg.** 0.3.0 read intent from three channels (MCP `_meta.intent` → SQL comment hint → `X-Midplane-Intent` HTTP header) and stamped a winning `intent_source` enum onto every audit row. Stock Claude Code never populated any of them, so audit logs showed `agent_intent = null` across the board — the column read as broken even though every channel was working as designed. **0.4.0 makes `intent` a required structured field on the `query` tool's input schema.** The MCP tool's JSON schema is the contract; agents fill `intent` the same way they fill `sql`, validated by the SDK before the engine ever runs. Schema-browsing tools (`list_tables`, `describe_table`) intentionally do not take an intent arg — their `event_type` already names what the call was. The validator strips control characters, trims, and rejects values that are blank or control-only after sanitization, so `" "`, `"\n\t"`, and `"\x00"` get a 400-style error instead of stamping a non-null-but-useless string on every audit row. Result: audit rows that previously had `agent_intent = null` for every `query` call now have an LLM-supplied "why" (typical fill rate observed: 100% on stock Claude Code traffic with the 0.4.0 tool description). Agents calling `query` with an old (intent-less) tool definition will get a one-shot validation error and re-fetch the schema.
- **Audit row `intent_source` column dropped; `audit.schema_version` bumps `2 → 3`.** With one source, the column was always-redundant. SQLite `audit_events` migrates in place on first 0.4.0 boot: `ALTER TABLE … DROP COLUMN intent_source`, then `UPDATE audit_events SET schema_version = 3 WHERE schema_version = 2` so existing rows don't continue to advertise a v2 contract they no longer match (a v2-pinned parser would expect `intent_source` and silently misread the row otherwise). The `audit_events_index` Postgres mirror schema drops the same column and the table-default bumps to `3`. New rows emitted by 0.4+ are stamped `schema_version: 3`. Pre-0.3 v1 rows are left as-is — they predate the column entirely and are still self-consistent. The `IntentSource` enum is removed from `@midplane/engine`'s public exports.
- **Deny-webhook payload `intent_source` removed; `schema_version` bumps `2 → 3`.** Receivers that pinned to schema 2 must widen their handler. `agent_intent` is unchanged.
- **Removed APIs:** `resolveAgentIntent`, `extractSqlCommentIntent`, `INTENT_HEADER`, `INTENT_MAX_LENGTH`, the `X-Midplane-Intent` HTTP header, and the `/* midplane:intent="..." */` / `-- midplane:intent: ...` SQL comment hint syntax. The `AgentIntent` engine type narrows from `{ value: string; source: IntentSource }` to `string`.

### Why (intent rip-out)

Research across the MCP ecosystem turned up no widely-adopted convention for client-supplied intent: the `_meta` extension point is spec-canonical, but `_meta.intent` specifically is novel — no reference server (GitHub, Sentry, Linear) reads it, and no off-the-shelf MCP client (Claude Code, Cursor, Codex) writes it. Comment-hint and HTTP-header channels added implementation surface (240 LOC of resolver, sanitizer, comment parser) for capture rates that depended entirely on agents we couldn't bind contractually. Tool args are different: every MCP client already validates them; the LLM treats them as a hard contract; making `intent` `required` gets us 100% capture for free. Closer to Spring AI's "Tool Argument Augmenter" pattern than to header-based gateways.

### Added

- **Hot-swap of `tenant_scope.mappings` on `POST /admin/policy`.** A YAML body that changes `databases[].tenant_scope.mappings` (or top-level `tenant_scope.mappings` in the legacy single-DB shape) now returns 200, the next query observes the new mapping, and a `POLICY_RELOADED` audit row records the swap. Same holder/getter pattern `table_access` already uses — the rule reads the holder once per `finalize()`, so a swap mid-traffic flips queries cleanly between old and new mappings without engine restart. Pre-0.4.0 the endpoint rejected mappings changes with `tenant_scope.mappings ... not hot-swappable in this version`, which forced a container restart on every per-DB mapping edit and blocked the cloud dashboard's per-DB mapping editor from shipping. The multi-DB *add/remove* path is still respawn-only — only mapping changes on existing DBs are in scope.
- **Self-describing `POLICY_RELOADED` audit payload.** The audit row now carries `sections_changed` (which sections actually moved — subset of `["table_access", "tenant_scope"]`), `databases_changed` (every DB whose policy changed in this swap call), `tenant_scope.mappings` (current full state, for symmetry with the existing `table_access` field), and a coarse `diff` block that names exactly which mappings/tables were added, removed, or changed (`{ from, to }` per key). Operators reading the audit log can verify "I changed `orders.tenant_id` at 14:03" from the row alone — no dashboard cross-reference required. A no-op swap (re-sending the same body) writes a row with empty `sections_changed` and an empty `diff`, so consumers can trust `sections_changed` as a change-feed rather than "what was touched". The cloud audit dashboard indexes against this shape.
- **`describe()` / `list_databases` returns the live `tenant_scope_mappings` dict.** Previously only a `tenant_scope_enabled` boolean was reported; the cloud dashboard now reads the full dict to verify engine state matches what its DB row says it pushed.

### Changed

- **`tenantScope()` accepts a holder/getter source.** The rule now resolves mappings via an optional source argument (`Record<string, string> | (() => Record<string, string> | undefined) | undefined`) — the getter form mirrors `tableAccess` and is what `mcp-server` wires into each engine. Back-compat: `tenantScope()` with no arg still falls back to reading `ctx.tenant_scope.mappings` from the per-call context (preserves existing test fixtures).
- **`EngineEntry.holder` gained `tenantScope: Record<string, string>`.** Single source of truth for the live mappings on a registered DB. `EngineEntry.mappings` (the redundant snapshot field) and `ctxBase.tenant_scope` (the redundant per-call context field) are removed; both were stale-on-swap by construction.

## [0.3.0] — 2026-05-01

### Changed (Breaking)

- **Audit row `agent_identity` split into `agent_name` + `agent_version`.** The single combined string was a User-Agent-style cautionary tale — combined strings kill grouping, filtering, and sorting. MCP `initialize` already sends `clientInfo: { name, version }` as separate fields; the audit row now stores them separately. SQLite `audit_events` migrates in place on first 0.3.0 boot: the legacy `agent_identity` column is dropped (it was always `null` because no transport ever populated it) and four new columns are added — `agent_name`, `agent_version`, `agent_intent`, `intent_source`. The `audit_events_index` Postgres mirror schema gains the same columns. **`audit.schema_version` bumps `1 → 2`.** The deny-webhook payload `schema_version` also bumps `1 → 2` and `agent_identity` is replaced with the same four fields. Receivers that pinned to schema 1 must widen their handler.
- **`EngineContext` and `ExecuteContext`: `agent_identity` removed.** Replaced by `agent_name: string \| null` + `agent_version: string \| null`. Both default to `null` for non-MCP callers.

### Added

- **Agent identity stamped on every audit row.** When the calling agent is an MCP client, `clientInfo.name` and `clientInfo.version` (captured once at the `initialize` handshake) are stamped on every audit row emitted from that session — `ATTEMPTED`, `DECIDED`, `EXECUTED`, `FAILED`. Non-MCP callers (raw HTTP audit pull, admin endpoints) leave both fields `null`. No agent action required: every MCP client already sends `clientInfo`.
- **Agent intent (per-call) with three resolution channels.** Every audit row now carries an `agent_intent` free-text task description (≤ 500 chars) plus an `intent_source` enum recording which channel won. Channels, in priority order:
    1. **MCP `_meta.intent`** — MCP reserves `_meta` on requests for implementation-specific data; this is the standards-aligned, first-class slot.
    2. **SQL comment hint** — `/* midplane:intent="..." */` or `-- midplane:intent: ...` at the head of the query. Stripped from the SQL before it's forwarded to the database (don't change query semantics — just don't send the hint downstream).
    3. **HTTP header `X-Midplane-Intent`** — for non-MCP HTTP callers. Lowest priority because intermediaries can strip headers.
  Sanitization trims whitespace, drops control chars, and truncates at 500 chars (truncate, never reject the query). Stamping `intent_source` on the row lets the cloud audit log UI surface "richness of signal" and nudge customers toward the standards-aligned channel.

## [0.2.0] — 2026-04-30

### Added

- **Multi-database support.** A single `midplane/midplane` container can now serve N Postgres DBs through one MCP endpoint. Configure them under a top-level `databases:` block in `MIDPLANE_POLICY_FILE`; each entry has its own `url`, `table_access`, and `tenant_scope`. `${ENV_VAR}` interpolation is supported on `url` so DSNs stay out of YAML files. Single-DB users see no change — the existing `DATABASE_URL` env + top-level `table_access` / `tenant_scope` shape keeps working byte-for-byte.
- **Dynamic MCP tool surface.** When N databases are configured (N ≥ 2), `query` and `describe_table` get a required `database` enum arg, `list_tables` gets an optional `database` (omitted = fan out across all DBs and group results by name), and a new `list_databases` tool reports each DB's name, tenant_scope status, and table_access default. When N == 1 (the legacy path) the tool schema is identical to 0.1.x — no `database` field appears anywhere and `list_databases` is not registered. Agents that only ever talked to one DB notice nothing.
- **Audit row carries `database`.** Every audit event is tagged with the originating DB name (or `__default__` for the legacy single-DB path). The `audit_events` SQLite table grows a `database TEXT NOT NULL` column with a one-time `ALTER TABLE` migration on first 0.2.0 boot — existing audit DBs upgrade in place. `GET /audit/since` payloads include `database` on every row; `midplane audit tail | since` JSON output does too. The hosted Postgres mirror schema (`audit_events_index`) gains the same column.
- **Per-DB telemetry dimension.** Heartbeats include a `tools_by_database` field with per-DB tool counters when more than one DB is observed in the window. The aggregate `tools.{name}.calls/allow/deny` shape is preserved byte-identical to v2 — single-DB installs send the same heartbeat as 0.1.x, the proxy needs no migration. New `list_databases` tool counted alongside existing tool names.
- **Hot-swap of `databases:`.** `POST /admin/policy` accepts the new shape. Adding a DB spins up a fresh pool; removing a DB drains and drops; editing a DB's `table_access` is an in-place pointer swap; editing a DB's `url` rebuilds the pool with a loud log line. Tool schemas reshape on the next session — clients reconnecting see the updated `database` enum on their next `tools/list`. Per-DB `tenant_scope.mappings` changes are still rejected (same rule as 0.1.x) and require a restart.

### Changed

- **Engine version bumped to 0.2.0** across `@midplane/engine`, `@midplane/mcp-server`, and the MCP server identification. The audit schema migration warrants a minor bump even though the user-facing tool surface is additive on the legacy path.

## [0.1.x] — 2026-04-30

### Changed (Breaking)

- **`writes_require_approval` → `table_access`.** The binary read-only sentinel is replaced by a per-table read/read_write/deny YAML policy loaded via `MIDPLANE_POLICY_FILE`. Default behavior with no YAML file is preserved exactly: every SELECT allows, every write denies, regardless of target. With YAML, agents get per-table `read_write` opt-in (e.g. `feature_flags: read_write`, `audit_log: deny`). Wire-level rule name in audit + telemetry payloads changes from `"writes_require_approval"` to `"table_access"`. Recursive AST detection (CTEs, subqueries, UNION arms, JOINs) is preserved. See [`docs/policy-rules.md`](./docs/policy-rules.md) for the schema and [`docs/adversarial-corpus.md`](./docs/adversarial-corpus.md#1-table_access-per-table-rw-recursive-ast-detection) for the full bypass set.
- **Telemetry `schema_version` 1 → 2.** The `denials_by_rule` enum renames `writes_require_approval` → `table_access`; otherwise identical to v1. Same privacy story — still rule-name histograms only, no SQL. The `t.midplane.ai` proxy accepts both v1 and v2 during the transition window. See [`TELEMETRY.md`](./TELEMETRY.md#version-history).

### Hardened

- **CTE names no longer treated as base tables.** The `table_access` walker now tracks lexically-visible CTE names from each statement's `WITH` clause and skips bare-name `RangeVar`s that match. Without this, `default: deny` would have rejected legitimate derived-table queries (`WITH x AS (SELECT 1) SELECT * FROM x`), and a CTE name colliding with a denied table would have been conflated with the real table (`WITH audit_log AS (SELECT 1) SELECT * FROM audit_log`). Schema-qualified references (`public.audit_log`) are never CTE names. Inner CTE bodies are still checked against policy, so `WITH x AS (DELETE FROM real RETURNING *) SELECT * FROM x` still denies on the inner DELETE.
- **`COPY` and `LOCK` deny unconditionally.** Both statements have side effects beyond row writes — filesystem I/O for `COPY`, transaction-scoped concurrency holds for `LOCK` — that the per-table YAML can't reasonably grant. Marking `webhooks: read_write` no longer enables `COPY webhooks TO '/tmp/leak'` or `LOCK TABLE webhooks IN ACCESS EXCLUSIVE MODE`. The denial promotes to `no_target` so the agent-facing message names them as side-effect statements that deny regardless of YAML.

### Added

- **Per-table R/W policy via YAML.** New top-level `table_access` block in `MIDPLANE_POLICY_FILE`: `default` for unlisted tables (`read` / `read_write` / `deny`) and a `tables` map for per-table overrides. Schema-qualified keys (`stripe.charges`) match before bare names. Approval workflows (Slack-bot, web queue, escalation) remain a Midplane Cloud feature; OSS Midplane is policy-as-YAML.
- **Polished denial reason strings.** Every policy denial now returns a full-sentence message that names the offending table and points at the YAML key to flip (`Midplane denied this query because writes to table \`users\` are not allowed by the table-access policy (\`users\` resolves to \`read\`; mark it \`read_write\` in your MIDPLANE_POLICY_FILE to grant writes).`). `tenant_scope_missing` names the mapped table + tenant column; `multi_statement` reports the statement count; `parse_error` includes the parser error. Agent shows the message verbatim. The `policy_rule` wire-level identifier is unchanged so structured branching keeps working.
- **`midplane audit` CLI** (`@midplane/mcp-server`). New unified `midplane` bin with `audit tail | stats | since` subcommands so self-hosters can read the audit log without writing SQL: `docker exec midplane midplane audit tail` for a live JSON-lines stream, `audit stats` for a 24h rollup of event types / deny rules / allow statement types / top agents, `audit since 1h` for a one-shot window dump. Reads SQLite directly (no `INDEXER_TOKEN` needed). Server entry preserved at `midplane server` (default).
- **Anonymous telemetry** (`@midplane/mcp-server`). On startup the server posts a single ULID-keyed event to `https://t.midplane.ai/v1/events`; every 24h it posts a heartbeat with per-tool call counts, denials grouped by policy rule, statement-type buckets, latency histograms (p50/p95/p99), and Postgres failure counts grouped by 2-char SQLSTATE class. No SQL, no fingerprints, no table/column names, no tenant IDs, no error messages — see [`TELEMETRY.md`](./TELEMETRY.md) for the full schema and the "what we never send" list. Disable with `MIDPLANE_TELEMETRY=0` or `DO_NOT_TRACK=1`. Inspect with `MIDPLANE_TELEMETRY=debug`.

## [0.1.0] — 2026-04-29

First tagged release. Four policy rules — `writes_require_approval`, `multi_statement`, `tenant_scope`, `parse_error` — sit on the `audit-before-execute` pipeline and are pinned by [an adversarial SQL corpus](./docs/adversarial-corpus.md) covering CTE-hidden writes, stacked-statement injection, cross-tenant exfiltration, parser edges, and exec-side-effects. Agent compatibility verified across Cursor, Claude Code, and Claude Desktop on 2026-04-29.

### Added

- **`@midplane/engine`** — parse → policy → audit-attempted → audit-decided → execute → audit-executed pipeline with `{ policy, audit, credentials, executor }` dependency injection. Four AST-recursive policy rules; `SqliteAuditWriter` (bun:sqlite, WAL, append-only) and `PostgresAuditWriter` for the hosted write-through path. `AuditUnavailableError` is thrown when the pre-execute audit write fails — the query never runs.
- **`@midplane/mcp-server`** — wraps the engine with three MCP tools (`query`, `list_tables`, `describe_table`) over stdio and Streamable HTTP. Per-session HTTP transport with `fly-replay: cache_key=<id>` mirror; zod-validated config from `DATABASE_URL` / `PORT` / `DB_PATH` / `MIDPLANE_TENANT_ID` / `MIDPLANE_POLICY_FILE` / `MIDPLANE_TRANSPORT`; `pg.Pool` executor; pino ops logger (audit stays in `engine.audit`).
- **Production Docker image** — multi-stage `oven/bun:1.3-alpine` build, isolated workspace `node_modules`, non-root `midplane:midplane` (1001:1001) runtime user, curl-based `HEALTHCHECK` on `/health`. Multi-arch (`linux/amd64` + `linux/arm64`), published to `midplane/midplane` on Docker Hub via the `v*` tag workflow.
- **Adversarial SQL corpus** — `packages/engine/test/adversarial/` mirrors [`docs/adversarial-corpus.md`](./docs/adversarial-corpus.md) one-to-one: writes-recursive, multi-statement, tenant-scope, parse-edges, exec-side-effects.
- **Agent setup docs + tooling** — [`docs/agent-setup.md`](./docs/agent-setup.md) with verified Cursor / Claude Code / Claude Desktop configs, `scripts/agent-smoke.sh` interactive local boot (sidecar Postgres, demo schema, audit-tail), `scripts/test-image.sh` CI-shaped local gate, and `packages/mcp-server/verify-mcp-handshake.ts` raw-`fetch` Streamable HTTP wire verifier (locked at the test layer via `handshake-wire.test.ts`).

### Verified

- **100% line coverage** on the policy surface (`packages/engine/src/policy/*`). `packages/engine/src/parser/parse.ts` at 91.67% — the three uncovered lines are defensive crash branches that require fault injection.
- **MCP compatibility** across Cursor, Claude Code, and Claude Desktop on 2026-04-29 — all three connect to a local self-host instance and reach all three Midplane tools. `writes_require_approval` denial path exercised end-to-end in Claude Code.
- **Performance against locked spike targets** — 154 MB image (under 200 MB budget), cold start ~470 ms (under 500 ms target), ~3.9 ms/call smoketest throughput.

### Hardened

- **`writes_require_approval` denies side-effect statements**, not just DML: `NotifyStmt`, `ListenStmt`, `UnlistenStmt`, and `LockStmt` are now in `WRITE_KINDS`. Postgres pubsub publication, session subscription mutations, and explicit table locks are outside the read-only contract.
- **Empty-AST parse rejection.** Comment-only inputs (`-- nothing`, `/* nothing */`) previously parsed cleanly to `stmts=[]` and produced a no-op ALLOW. Now rejected with `parse_error: "no statements"`.
- **CTE-embedded writes are denied.** The policy visitor walks the entire AST in a single recursive pass; `WITH x AS (DELETE FROM ... RETURNING *) SELECT * FROM x` is denied at the inner DELETE node regardless of the outer statement type. Same recursive walk applies to `tenant_scope` across UNION arms, subqueries, CTEs, and DML relations.
- **Audit-before-execute ordering.** A query that ran but didn't audit is treated as worse than a query that didn't run: if the `ATTEMPTED` or `DECIDED` audit write fails, the engine throws `AuditUnavailableError` and the query never reaches the database. Post-execute audit failures (`EXECUTED` / `FAILED`) are logged to ops but non-fatal — the pre-execute rows already prove intent.

### Known limitations

Documented in [`docs/adversarial-corpus.md`](./docs/adversarial-corpus.md): SELECT-wrapped admin functions (`pg_terminate_backend`, `pg_cancel_backend`, `lo_unlink`), `BEGIN` / `COMMIT`, `VACUUM`, and `PREPARE` / `DEALLOCATE` currently allow. These are deferred to a later release (function-side-effects denylist + session-scope tracking).

[0.5.0]: https://github.com/midplaneai/midplane/releases/tag/v0.5.0
