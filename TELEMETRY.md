# Midplane Telemetry

This document is the source of truth for what Midplane sends home, what it
never sends home, and how to turn it off. If the implementation diverges from
this document, that's a bug — file it.

Client implementation lives in
[`packages/mcp-server/src/telemetry/`](./packages/mcp-server/src/telemetry/).
The receiver at `t.midplane.ai` is operated by Midplane Inc and not part of
this MIT-licensed repository — its job is described below in
[Receiver-side handling](#receiver-side-handling).

## Summary

When enabled, Midplane sends two kinds of anonymous, aggregate events to
`https://t.midplane.ai/v1/events`:

1. **`startup`** — once per process, when the server boots.
2. **`heartbeat`** — once per 24h while the process is running.

Both events carry a stable, randomly-generated **install ID** (no relation to
your hostname, IP, DB, tenant, or account). No SQL, no table names, no column
names, no error messages, no query results, no credentials, no IP addresses
beyond what the TLS connection already exposes to the receiving endpoint. See
[What we never send](#what-we-never-send) for the bright line.

Telemetry is best-effort: failure is silent and never blocks a query.

## Defaults

| Mode        | Default      | How to change                              |
| ----------- | ------------ | ------------------------------------------ |
| Self-host   | **enabled**  | `MIDPLANE_TELEMETRY=0` or `DO_NOT_TRACK=1` |
| Hosted      | **enabled**  | Account setting (later)                    |

First-run notice: when the install ID is generated for the first time, the
server prints a three-line stderr notice pointing at this document and the
disable instructions. The notice does NOT print on subsequent runs (the
install-id file's existence is what determines first-run).

## Disabling

Any one of these turns telemetry off completely (no startup event, no
heartbeats, install ID is not generated):

```bash
MIDPLANE_TELEMETRY=0
MIDPLANE_TELEMETRY=off
MIDPLANE_TELEMETRY=false
DO_NOT_TRACK=1
```

To preview what *would* be sent without sending it, set
`MIDPLANE_TELEMETRY=debug` — payloads are written to stderr (one line of JSON
per event) and no network call is made.

To override the endpoint (for self-hosted collectors or testing), set
`MIDPLANE_TELEMETRY_ENDPOINT=https://your-collector.example.com/v1/events`.

## What we send

### Event 1: `startup`

Sent once, immediately after the MCP transport is listening. Fields:

| Field            | Type     | Example                            | Why                          |
| ---------------- | -------- | ---------------------------------- | ---------------------------- |
| `schema_version` | int      | `2`                                | Versioned for forward compat |
| `event`          | string   | `"startup"`                        | Discriminator                |
| `install_id`     | ULID     | `"01H8K2J9XQVWZ7PCQ3F0R2N5T8"`     | Stable random ID per install |
| `ts`             | int      | `1730000000`                       | Unix seconds, UTC            |
| `version`        | string   | `"0.5.0"`                          | `@midplane/mcp-server` version |
| `bun_version`    | string   | `"1.3.0"`                          | Runtime                      |
| `os`             | enum     | `"linux"`                          | `darwin` / `linux` / `win32` / `other` |
| `arch`           | enum     | `"x64"`                            | `x64` / `arm64` / `other`    |
| `transport`      | enum     | `"http"`                           | `stdio` / `http`             |
| `container`      | bool     | `true`                             | True if `/.dockerenv` exists |
| `ci`             | bool     | `false`                            | True if `CI=1`, `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `BUILDKITE`, `TRAVIS`, or `JENKINS_URL` is set |

Sample:

```json
{
  "schema_version": 2,
  "event": "startup",
  "install_id": "01H8K2J9XQVWZ7PCQ3F0R2N5T8",
  "ts": 1730000000,
  "version": "0.5.0",
  "bun_version": "1.3.0",
  "os": "linux",
  "arch": "x64",
  "transport": "http",
  "container": true,
  "ci": false
}
```

### Event 2: `heartbeat`

Sent every 24h while the process runs. Counters reset after each drain. If
a process shuts down mid-window, the partial window is dropped (no shutdown
event — keeps the receiver-side data model simple). If the window had zero
tool calls, the heartbeat is suppressed (idle installs don't beacon daily).

| Field                            | Type   | Why                                          |
| -------------------------------- | ------ | -------------------------------------------- |
| `schema_version`                 | int    | Versioned                                    |
| `event`                          | string | `"heartbeat"`                                |
| `install_id`                     | ULID   | Same install ID as `startup`                 |
| `ts`                             | int    | Unix seconds                                 |
| `version`                        | string | Restated for join-free receiver-side analysis|
| `uptime_s`                       | int    | Process uptime so far                        |
| `window_s`                       | int    | Length of this window (≤ 86400)              |
| `tools.{tool}.calls`             | int    | Total invocations per tool                   |
| `tools.{tool}.allow`             | int    | ALLOW decisions per tool                     |
| `tools.{tool}.deny`              | int    | DENY decisions per tool                      |
| `tools_by_database.{db}.{tool}.{calls,allow,deny}` | int | 0.2.0+: per-DB tool counters. **Only present when more than one DB was observed in the window.** Single-DB installs (the `__default__`-only legacy path) omit this field entirely so v2 receivers see no change. The `{db}` key is the operator-supplied DB name from `databases:` YAML (`^[a-z][a-z0-9_-]{0,31}$`) or the literal `__default__`. |
| `denials_by_rule.{rule}`         | int    | Denials grouped by policy rule name (only)   |
| `statement_types.{bucket}`       | int    | Coarse statement type bucket counts          |
| `latency_overhead_ms.p50/p95/p99`| int    | Midplane-added latency only (parse+policy+audit) |
| `latency_overhead_ms.samples`    | int    | Total latency observations in the window     |
| `exec_failures.count`            | int    | Postgres rejected an allowed query           |
| `exec_failures.by_sqlstate_class.{cc}` | int | First two chars of SQLSTATE only           |

Tool names are the fixed set: `query`, `list_tables`, `describe_table`, `list_databases` (`list_databases` is only registered on multi-DB installs but the enum carries it for forward-compat in either case).
Policy rule names are the fixed set: `table_access`, `multi_statement`,
`tenant_scope_missing`, `parse_error`, `internal_error`.
Statement type buckets are the fixed set: `SELECT`, `INSERT`, `UPDATE`,
`DELETE`, `DDL`, `OTHER`. **Anything outside these allow-lists is dropped
before send** — a new rule or tool requires a schema bump and a doc update
before it appears in telemetry. The locked enums are enforced client-side
in `packages/mcp-server/src/telemetry/sanitizer.ts` and re-enforced at the
receiver as defense in depth.

Sample:

```json
{
  "schema_version": 2,
  "event": "heartbeat",
  "install_id": "01H8K2J9XQVWZ7PCQ3F0R2N5T8",
  "ts": 1730086400,
  "version": "0.5.0",
  "uptime_s": 86400,
  "window_s": 86400,
  "tools": {
    "query":          { "calls": 1234, "allow": 1200, "deny": 34 },
    "list_tables":    { "calls":   56, "allow":   56, "deny":  0 },
    "describe_table": { "calls":   78, "allow":   78, "deny":  0 }
  },
  "denials_by_rule": {
    "table_access":            30,
    "multi_statement":          2,
    "tenant_scope_missing":     1,
    "parse_error":              1
  },
  "statement_types": {
    "SELECT": 1300, "INSERT": 20, "UPDATE": 8, "DELETE": 3, "DDL": 0, "OTHER": 37
  },
  "latency_overhead_ms": { "p50": 2, "p95": 8, "p99": 21, "samples": 1368 },
  "exec_failures": {
    "count": 4,
    "by_sqlstate_class": { "42": 3, "23": 1 }
  }
}
```

### Install ID

Generated with the `ulid` package on first startup and persisted at
`${dirname(dbPath)}/install-id` — same lifetime as the audit DB. Wiping the
audit DB also wipes the install ID. The ID is not derived from any
machine-identifying material (no MAC, no hostname, no DB hash). A corrupt or
unparseable install-id file is treated as missing and replaced atomically.

## What we never send

The following are **explicitly excluded** from every telemetry payload, in
every version, forever. The sanitizer test suite asserts these never appear in
serialized payloads:

- **SQL text** — neither raw nor normalized.
- **SQL fingerprints** (the 16-hex audit fingerprint) — even though it's a
  hash, repeated fingerprints would let a receiver fingerprint a customer's
  workload over time.
- **Table names, column names, schema names** — anywhere, including inside
  error messages or rule reasons.
- **Tenant IDs** — `MIDPLANE_TENANT_ID` never leaves the process.
- **Database URL or any of its components** — host, port, user, db name.
- **Query results or row counts beyond aggregate `rows_affected`/`rows_returned`
  histograms** (and we do not send those histograms in v0.2).
- **Postgres error messages** or full SQLSTATE codes — we send the 2-char
  class only (`42` not `42P01`).
- **Hostnames, IPs (beyond the unavoidable TLS-layer source IP at the
  endpoint), MAC addresses, env var values, file paths.**
- **Agent identity** — the `agent_name`, `agent_version`, and
  `agent_intent` fields that the engine sees are never forwarded.
- **Policy file contents** — including tenant-scope column, overrides, and exempt lists.

This is a hard list, not a guideline. Adding any field that touches this list
requires a schema-version bump, a doc update here, and an explicit changelog
entry in CHANGELOG.md before the first release that contains it.

## Receiver-side handling

- TLS only. HTTPS POST, JSON body, 5s timeout, no retries on failure.
- The receiver at `t.midplane.ai` re-validates every payload against the
  same locked schema this document defines, re-runs the forbidden-substring
  scan as defense-in-depth, strips the source IP, and forwards as a
  vendor-side analytics event keyed by `install_id`.
- Rate-limited at the edge. A misbehaving client cannot DoS the endpoint
  into accepting more than its share.
- The receiver never returns a body. Validation failures, malformed JSON,
  and missing-method requests all collapse to `204 No Content` so a client
  learns nothing about why a payload was rejected.
- The receiver source is operated by Midplane Inc and lives in a separate
  closed-source repository. Aggregates are retained per the vendor's
  product-analytics retention setting.

## Why we hold this line

Per [docs/trust-posture.md](./docs/trust-posture.md), self-host means "your
queries are seen only by you." Sending SQL fingerprints, table-name
histograms, or denial-shape categories — even normalized — would chip away at
that. We hold the telemetry surface to **counts and rule-name histograms**
so that no payload contains anything that could identify a customer's
schema, workload, or attack surface. If we ever propose adding deeper
denial-event telemetry (rule name + AST shape category for novel-bypass
detection), it will be a separate doc, a schema-version bump, and an
explicit changelog entry — not a quiet expansion of this contract.

Reference for why this caution is warranted: Prisma's 2021 telemetry incident
([prisma/prisma#7192](https://github.com/prisma/prisma/issues/7192)) — sending
schema-shape data from a self-host product, even hashed, draws sustained
community pushback.

## Forward compatibility

Schema version bumps:

- **Additive change** (new field with a clear privacy story, allow-listed):
  bump `schema_version`, update this doc, add a CHANGELOG entry.
- **Removed or renamed field**: bump major schema version. Old senders keep
  working because the receiver accepts older `schema_version`s for at least 12
  months.
- **Anything in the "What we never send" list moves**: not a schema change.
  That's a new product decision and a new doc.

### Version history

- **v2** — `denials_by_rule` enum renamed: `writes_require_approval` →
  `table_access`. Same privacy story (still rule-name histograms only,
  no SQL); the rule itself was generalized from a binary read-only
  sentinel to a per-table YAML-driven access policy.
- **v1** — initial schema.

## Inspection

Run `MIDPLANE_TELEMETRY=debug bun run packages/mcp-server/src/index.ts` and
exercise the server. Each event that *would* be sent is written to stderr as a
single JSON line, prefixed with `[telemetry-debug]`. No network call is made.

For a faster heartbeat in tests/dev, set
`MIDPLANE_TELEMETRY_HEARTBEAT_MS=5000`. The minimum is 1ms; the maximum is
7 days. This is documented as a test/dev hook — production deployments
should leave it at the default 24h.

`MIDPLANE_TELEMETRY_ENDPOINT` overrides the destination URL. Useful when
running a self-hosted collector or an air-gapped receiver. The URL format
must match the proxy contract (`POST /v1/events`, JSON body).
