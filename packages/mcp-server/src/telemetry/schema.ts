// Telemetry payload schema. Source of truth for both the in-process sender
// and the t.midplane.ai proxy. The proxy keeps a byte-identical copy at
// infra/telemetry-proxy/src/schema.ts; if you edit one, edit both.
//
// Hard rule: every field added here MUST have a corresponding row in
// /TELEMETRY.md and must NOT touch anything in the "What we never send" list.

import { z } from "zod";

export const TELEMETRY_SCHEMA_VERSION = 2;

// ─── Locked enums ──────────────────────────────────────────────────────────

export const ToolName = z.enum(["query", "list_tables", "describe_table"]);
export type ToolName = z.infer<typeof ToolName>;

// Mirrors PolicyRule from packages/engine/src/audit/types.ts.
export const PolicyRuleName = z.enum([
  "table_access",
  "multi_statement",
  "tenant_scope_missing",
  "parse_error",
  "internal_error",
]);
export type PolicyRuleName = z.infer<typeof PolicyRuleName>;

// Coarse statement-type buckets. DDL is collapsed into one bucket so
// telemetry can't distinguish CREATE vs DROP vs ALTER attempts.
export const StatementTypeBucket = z.enum([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "DDL",
  "OTHER",
]);
export type StatementTypeBucket = z.infer<typeof StatementTypeBucket>;

// ULID — 26 chars, Crockford base32, uppercase.
export const InstallId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export type InstallId = z.infer<typeof InstallId>;

// First 2 chars of SQLSTATE only. Sending the full 5-char code can leak
// schema (e.g. 42P01 = relation doesn't exist).
export const SqlstateClass = z.string().regex(/^[0-9A-Z]{2}$/);

// ─── Event 1: startup ──────────────────────────────────────────────────────

export const StartupEventSchema = z
  .object({
    schema_version: z.literal(2),
    event: z.literal("startup"),
    install_id: InstallId,
    ts: z.number().int().nonnegative(),
    version: z.string().min(1).max(64),
    bun_version: z.string().min(1).max(64),
    os: z.enum(["darwin", "linux", "win32", "other"]),
    arch: z.enum(["x64", "arm64", "other"]),
    transport: z.enum(["stdio", "http"]),
    container: z.boolean(),
    ci: z.boolean(),
  })
  .strict();
export type StartupEvent = z.infer<typeof StartupEventSchema>;

// ─── Event 2: heartbeat ────────────────────────────────────────────────────

export const ToolCountersSchema = z
  .object({
    calls: z.number().int().nonnegative(),
    allow: z.number().int().nonnegative(),
    deny: z.number().int().nonnegative(),
  })
  .strict();
export type ToolCounters = z.infer<typeof ToolCountersSchema>;

export const LatencyHistogramSchema = z
  .object({
    p50: z.number().int().nonnegative(),
    p95: z.number().int().nonnegative(),
    p99: z.number().int().nonnegative(),
    samples: z.number().int().nonnegative(),
  })
  .strict();
export type LatencyHistogram = z.infer<typeof LatencyHistogramSchema>;

export const ExecFailuresSchema = z
  .object({
    count: z.number().int().nonnegative(),
    by_sqlstate_class: z.record(SqlstateClass, z.number().int().nonnegative()),
  })
  .strict();
export type ExecFailures = z.infer<typeof ExecFailuresSchema>;

export const HeartbeatEventSchema = z
  .object({
    schema_version: z.literal(2),
    event: z.literal("heartbeat"),
    install_id: InstallId,
    ts: z.number().int().nonnegative(),
    version: z.string().min(1).max(64),
    uptime_s: z.number().int().nonnegative(),
    window_s: z.number().int().nonnegative().max(86_400),
    tools: z.partialRecord(ToolName, ToolCountersSchema),
    denials_by_rule: z.partialRecord(PolicyRuleName, z.number().int().nonnegative()),
    statement_types: z.partialRecord(StatementTypeBucket, z.number().int().nonnegative()),
    latency_overhead_ms: LatencyHistogramSchema,
    exec_failures: ExecFailuresSchema,
  })
  .strict();
export type HeartbeatEvent = z.infer<typeof HeartbeatEventSchema>;

export const TelemetryEventSchema = z.discriminatedUnion("event", [
  StartupEventSchema,
  HeartbeatEventSchema,
]);
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

// ─── Sanitizer denylist (TELEMETRY.md "What we never send") ────────────────
//
// If any string field anywhere in a serialized payload matches one of these,
// the sanitizer drops the event before it leaves the process. The proxy
// re-runs the same check as defense-in-depth.

export const FORBIDDEN_PAYLOAD_SUBSTRINGS: readonly RegExp[] = [
  /\bSELECT\b/i,
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /\bMERGE\b/i,
  /\bDROP\b/i,
  /\bTRUNCATE\b/i,
  /\bALTER\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /\bCREATE\b/i,
  /\bEXECUTE\b/i,
  /\bCALL\b/i,
];

// Statement-type bucketing helper. Maps the engine's free-form
// statement_type string into the locked telemetry bucket. Anything that
// isn't a known DML/DDL keyword maps to OTHER.
export function bucketStatementType(t: string | undefined | null): StatementTypeBucket {
  if (!t) return "OTHER";
  const upper = t.toUpperCase();
  if (upper === "SELECT" || upper === "INSERT" || upper === "UPDATE" || upper === "DELETE") {
    return upper;
  }
  // DDL keywords roll up to a single bucket.
  if (
    upper === "CREATE" ||
    upper === "DROP" ||
    upper === "ALTER" ||
    upper === "TRUNCATE" ||
    upper === "GRANT" ||
    upper === "REVOKE" ||
    upper === "RENAME" ||
    upper === "COMMENT" ||
    upper.startsWith("CREATE_") ||
    upper.startsWith("DROP_") ||
    upper.startsWith("ALTER_")
  ) {
    return "DDL";
  }
  return "OTHER";
}

// SQLSTATE class extractor. 5-char Postgres SQLSTATE → 2-char class.
// Returns null when the input is not a valid SQLSTATE-shaped string.
export function sqlstateClassOf(code: string | undefined | null): string | null {
  if (!code || code.length < 2) return null;
  const head = code.slice(0, 2);
  return /^[0-9A-Z]{2}$/.test(head) ? head : null;
}
