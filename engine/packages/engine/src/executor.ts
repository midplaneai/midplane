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

// A single checked-out, transaction-scoped client for the masking source-rewrite
// path (T0). The transaction already has search_path pinned (same as execute()),
// and a pooled connection cannot rebind mid-transaction — so catalog resolution,
// the mask-salt GUC, and the rewritten user query all run against ONE backend.
// This is the fix for the split today's executor has: execute() is transaction-
// scoped but the catalog reads (query()) run on a SEPARATE pooled connection with
// no search_path pin, so pre-exec name resolution could disagree with execution
// and the salt GUC might not be on the execution client.
//
// Driver-agnostic by construction (no pg types leak here), like Executor itself.
export interface TxClient {
  // Metadata/catalog query within the transaction. Same shape as CatalogQueryFn
  // so buildCatalogByName / a CachingCatalogResolver can run on THIS client.
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  // Execute the (rewritten) user SQL, lifting RowDescription provenance — same
  // ExecutionResult shape (and same provenance semantics) as Executor.execute().
  exec(sql: string): Promise<ExecutionResult>;
}

export interface Executor {
  execute(sql: string, ctx: ExecuteContext): Promise<ExecutionResult>;
  // Run one unit of work on a transaction-scoped client (search_path pinned), for
  // the masking source-rewrite path. OPTIONAL: an executor that doesn't implement
  // it (mock executors, or a deployment without rewrite support) signals the engine
  // to use the post-exec masker instead — so this is purely additive and never
  // breaks an existing Executor. The transaction COMMITs when `fn` resolves and
  // ROLLBACKs if it throws.
  withTransaction?<T>(ctx: ExecuteContext, fn: (tx: TxClient) => Promise<T>): Promise<T>;
}
