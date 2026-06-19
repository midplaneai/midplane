// Executor interface — the "execute" stage of the locked pipeline.
//
// In production the executor is built from a CredentialStore (pg.Pool keyed
// by tenant). For tests, a mock executor returns canned rows or throws.
//
// We DI the executor explicitly (rather than inline pg) so the engine has
// no hard dependency on pg in unit tests, and so cloud's executor
// (with read-replica routing, in-region pooling, etc.) can drop in cleanly.

// Per-output-column provenance, lifted from the driver's RowDescription
// (node-postgres `result.fields`). This is Postgres' OWN answer to "which
// source column produced this output field", correct through aliases, joins,
// and `SELECT *` — the masker maps output->source from this, NOT from output
// column names (which would silently leak on `SELECT email AS contact`).
//
// A COMPUTED output (aggregate, expression, literal, whole-row serialization)
// reports tableOid=0 / columnAttnum=0: the driver can't attribute it to a base
// column. The masker treats that as "unresolved provenance" and fails closed
// (rejects if the query references a masked column) rather than passing it
// through. See the column-policies-masking design doc (decisions A1 + CQ2).
export interface ResultField {
  /** Output field name (may be an alias). */
  name: string;
  /** pg_class OID of the source table, or 0 if the column is computed. */
  tableOid: number;
  /** attnum within the source table, or 0 if the column is computed. */
  columnAttnum: number;
  /** pg_type OID of the output value — lets the masker reject jsonb/array
   *  columns it can't safely transform in v1. */
  dataTypeOid: number;
}

export interface ExecutionResult {
  rows: unknown[];
  rowCount: number;
  // Per-column provenance, one entry per output column in order. Optional:
  // mock executors in tests omit it, and a masker treats a missing/short
  // `fields` for a masked query as unresolved provenance => fail closed.
  fields?: ResultField[];
}

export interface ExecuteContext {
  tenant_id: string;
  // MCP `clientInfo.name`/`version`, captured at session establish. Both
  // null for non-MCP callers. The PgPoolExecutor doesn't read these today,
  // but they're plumbed through so future executors (connection labels,
  // per-agent rate limits, structured backend logs) can use them without
  // touching the engine API.
  agent_name: string | null;
  agent_version: string | null;
}

export interface Executor {
  execute(sql: string, ctx: ExecuteContext): Promise<ExecutionResult>;
}
