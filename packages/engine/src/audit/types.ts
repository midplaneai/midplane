// Midplane V1 audit event types (locked 2026-04-29 from /plan-eng-review T2).
//
// Append-only event sourcing model. Each query emits 2-3 events:
//   ATTEMPTED  — agent intent recorded (always written first, before policy)
//   DECIDED    — ALLOW or DENY decision (always written, before execute)
//   EXECUTED   — successful execution (only if ALLOW + exec succeeds)
//   FAILED     — execution failed (only if ALLOW + exec throws)
//
// Pipeline order is non-negotiable per eng review T3:
//   parse → policy → audit(ATTEMPTED + DECIDED) → execute → audit(EXECUTED|FAILED)
//
// If audit of ATTEMPTED+DECIDED fails, the engine throws AuditUnavailableError
// and the query is NOT executed. Constraint #3 strictly honored.

import { z } from "zod";

// ─── Discriminator values ───────────────────────────────────────────────────

export const EventType = {
  ATTEMPTED: "ATTEMPTED",
  DECIDED: "DECIDED",
  EXECUTED: "EXECUTED",
  FAILED: "FAILED",
  POLICY_RELOADED: "POLICY_RELOADED",
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

export const Decision = {
  ALLOW: "ALLOW",
  DENY: "DENY",
} as const;
export type Decision = (typeof Decision)[keyof typeof Decision];

export const PolicyRule = {
  TABLE_ACCESS: "table_access",
  MULTI_STATEMENT: "multi_statement",
  TENANT_SCOPE_MISSING: "tenant_scope_missing",
  PARSE_ERROR: "parse_error",
} as const;
export type PolicyRule = (typeof PolicyRule)[keyof typeof PolicyRule];

// Channels a per-call agent intent string can come from. Stamped on every
// audit row alongside `agent_intent` so consumers can show where the signal
// came from and nudge customers toward the standards-aligned channel.
export const IntentSource = {
  MCP_META: "mcp_meta",
  SQL_COMMENT: "sql_comment",
  HTTP_HEADER: "http_header",
} as const;
export type IntentSource = (typeof IntentSource)[keyof typeof IntentSource];

// ─── Payload schemas (one per event type) ───────────────────────────────────

// ATTEMPTED — agent intent. Recorded before policy evaluation. Cannot be redacted later.
export const AttemptedPayload = z.object({
  sql_raw: z.string().min(1).max(1_048_576),               // 1 MiB cap; longer is parse_error at decision
  sql_fingerprint: z.string().regex(/^[0-9a-f]{16}$/),     // hex of first 8 bytes of SHA-256 over normalized AST
  // intentionally no parsed AST here — that's transient. fingerprint is the durable summary.
});
export type AttemptedPayload = z.infer<typeof AttemptedPayload>;

// DECIDED — policy decision. Always written. Captures *why* on DENY.
export const DecidedPayload = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("ALLOW"),
    statement_type: z.string(),                            // SELECT, INSERT, UPDATE, etc.
    tables_touched: z.array(z.string()).max(64),           // schema-qualified, deduped
  }),
  z.object({
    decision: z.literal("DENY"),
    policy_rule: z.string(),                               // e.g. "table_access"
    reason: z.string(),                                    // human-readable, surfaced to agent
    statement_type: z.string().optional(),                 // present when parse succeeded
    tables_touched: z.array(z.string()).max(64).optional(),
  }),
]);
export type DecidedPayload = z.infer<typeof DecidedPayload>;

// EXECUTED — query ran successfully. Captures performance + side-effect summary.
export const ExecutedPayload = z.object({
  exec_ms: z.number().int().nonnegative(),                 // Postgres execution time
  overhead_ms: z.number().int().nonnegative(),             // Midplane-added latency (parse+policy+audit+net)
  rows_affected: z.number().int().nonnegative().optional(),// for INSERT/UPDATE/DELETE returning
  rows_returned: z.number().int().nonnegative().optional(),// for SELECT
});
export type ExecutedPayload = z.infer<typeof ExecutedPayload>;

// FAILED — query was allowed but Postgres rejected it. Captures the error.
export const FailedPayload = z.object({
  exec_ms: z.number().int().nonnegative(),
  overhead_ms: z.number().int().nonnegative(),
  error_class: z.string(),                                 // Postgres SQLSTATE class, e.g. "42P01"
  error_message: z.string().max(4096),                     // truncated; full error stays in pino logs
});
export type FailedPayload = z.infer<typeof FailedPayload>;

// POLICY_RELOADED — the in-memory policy was hot-swapped via the admin endpoint.
// Not tied to a query; query_id is a synthetic ULID for groupability. The
// payload captures what changed so operators can confirm the swap landed.
const TableAccessLevelEnum = z.enum(["deny", "read", "read_write"]);
export const PolicyReloadedPayload = z.object({
  source: z.string(),                                      // "admin_endpoint" today; reserves room for "fs_watch" etc.
  table_access: z
    .object({
      default: TableAccessLevelEnum,
      tables: z.record(z.string(), TableAccessLevelEnum),
    })
    .nullable(),
});
export type PolicyReloadedPayload = z.infer<typeof PolicyReloadedPayload>;

// ─── Discriminated event union ──────────────────────────────────────────────

// `database` names the DB the event applied to. Always written; legacy
// single-DB deploys see "__default__" — the same value the EngineRegistry
// uses internally for the synthetic legacy entry. The hosted indexer adds a
// dimension on this without renaming any existing payload field.
const DatabaseName = z.string().min(1).max(32);

// `agent_name`/`agent_version` are split (NOT a combined User-Agent-style
// string) because MCP `initialize` carries `clientInfo: { name, version }`
// as separate fields and we want the cloud's audit log UI to group, filter,
// and sort on each independently.
const AgentName = z.string().min(1).max(128).nullable();
const AgentVersion = z.string().min(1).max(64).nullable();

// `agent_intent` is the per-call free-text task description. Resolved from
// MCP `_meta.intent`, an SQL comment hint, or an HTTP header (in that
// priority order). Capped at 500 chars at the resolver — zod is the
// belt-and-suspenders defense.
const AgentIntent = z.string().min(1).max(500).nullable();
const IntentSourceEnum = z
  .enum([IntentSource.MCP_META, IntentSource.SQL_COMMENT, IntentSource.HTTP_HEADER])
  .nullable();

export const AuditEvent = z.discriminatedUnion("event_type", [
  z.object({
    id: z.string(),
    query_id: z.string(),
    tenant_id: z.string(),
    database: DatabaseName,
    agent_name: AgentName,
    agent_version: AgentVersion,
    agent_intent: AgentIntent,
    intent_source: IntentSourceEnum,
    ts: z.number().int(),
    schema_version: z.literal(2),
    event_type: z.literal("ATTEMPTED"),
    payload: AttemptedPayload,
  }),
  z.object({
    id: z.string(),
    query_id: z.string(),
    tenant_id: z.string(),
    database: DatabaseName,
    agent_name: AgentName,
    agent_version: AgentVersion,
    agent_intent: AgentIntent,
    intent_source: IntentSourceEnum,
    ts: z.number().int(),
    schema_version: z.literal(2),
    event_type: z.literal("DECIDED"),
    payload: DecidedPayload,
  }),
  z.object({
    id: z.string(),
    query_id: z.string(),
    tenant_id: z.string(),
    database: DatabaseName,
    agent_name: AgentName,
    agent_version: AgentVersion,
    agent_intent: AgentIntent,
    intent_source: IntentSourceEnum,
    ts: z.number().int(),
    schema_version: z.literal(2),
    event_type: z.literal("EXECUTED"),
    payload: ExecutedPayload,
  }),
  z.object({
    id: z.string(),
    query_id: z.string(),
    tenant_id: z.string(),
    database: DatabaseName,
    agent_name: AgentName,
    agent_version: AgentVersion,
    agent_intent: AgentIntent,
    intent_source: IntentSourceEnum,
    ts: z.number().int(),
    schema_version: z.literal(2),
    event_type: z.literal("FAILED"),
    payload: FailedPayload,
  }),
  z.object({
    id: z.string(),
    query_id: z.string(),
    tenant_id: z.string(),
    database: DatabaseName,
    // POLICY_RELOADED has no calling agent; both names and intent are
    // always null. They're still on the row so every event in the union
    // has the same column shape (the indexer's `isValidAuditRow` check
    // doesn't have to special-case POLICY_RELOADED).
    agent_name: z.null(),
    agent_version: z.null(),
    agent_intent: z.null(),
    intent_source: z.null(),
    ts: z.number().int(),
    schema_version: z.literal(2),
    event_type: z.literal("POLICY_RELOADED"),
    payload: PolicyReloadedPayload,
  }),
]);
export type AuditEvent = z.infer<typeof AuditEvent>;

// ─── Fingerprint algorithm (specification only — implementation lives elsewhere) ──

// fingerprint(sql) is a 16-hex-char hash that's the same for "the same query intent".
// Algorithm:
//   1. Parse SQL with libpg-query → AST
//   2. Walk AST, replace every literal node (constants, strings, numbers) with a `?` placeholder
//   3. Replace every parameter ref ($1, $2, ...) with a `?` placeholder
//   4. Sort table aliases alphabetically (so `t1, t2` and `t2, t1` collapse)
//   5. Serialize the canonical AST as deterministic JSON
//   6. SHA-256, take first 8 bytes, hex encode → 16 chars
//
// Examples (all should produce the SAME fingerprint):
//   SELECT * FROM users WHERE id = 42
//   SELECT * FROM users WHERE id = 99
//   SELECT * FROM users WHERE id = $1
//
// Different fingerprints (different intent):
//   SELECT * FROM users WHERE id = 42      -- single-row by PK
//   SELECT * FROM users WHERE created_at > now()  -- different predicate column
//   SELECT id FROM users WHERE id = 42     -- different projection

// ─── V2 hash-chain extension (forward-compatible — schema migration is non-breaking) ──

// Future:
//   prev_hash:  SHA-256 of (id || JSON(payload)) of the previous row in the same tenant
//   signature:  HMAC-SHA-256 of (id || prev_hash || JSON(payload)) signed with per-tenant key
//
// Both nullable when added; existing rows backfilled lazily on first read or
// during a migration window. Compliance buyer in year 2 turns these on.
