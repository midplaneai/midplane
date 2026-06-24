// maskResultSet — the result-set masking chokepoint (decision CQ1).
//
// Runs after execute(), on BOTH the SELECT and the INSERT/UPDATE...RETURNING
// result paths, before rows leave the engine. Pure: all DB access (the catalog)
// is resolved by the caller and passed in, so this is unit-testable without a
// database.
//
// Mapping mechanism (decision A1, empirically validated 2026-06-19): each output
// field's source is taken from the driver's RowDescription provenance
// (ResultField.tableOid / columnAttnum), NOT from output column names — Postgres
// resolves aliases / joins / `SELECT *` / inline-CTE pass-through to the true
// base column, so `SELECT u.email AS contact` is correctly seen as users.email.
//
// Fail-closed by construction (decision CQ2). Per output field:
//   - relkind r/p (table / partitioned)  -> mask iff (table, column) is declared
//   - relkind v/m (view / matview)       -> REJECT iff masking is relevant
//   - tableOid = 0 (computed/aggregate/  -> REJECT iff masking is relevant
//     set-op/whole-row serialization)
//   - oid not in the catalog             -> REJECT (cannot prove safety)
// "masking relevant" = the query TOUCHES a table that has a declared mask. This
// is conservative: `SELECT count(*) FROM users` (users.email masked) rejects even
// though count exposes nothing. That is the accepted v1 stance (eng review:
// "reject as default, loosen later"); the later loosening is an AST check of
// whether the computed expression actually references a masked column. The
// alternative — deriving relevance only from resolved fields — would PASS
// `to_jsonb(users)` (tableOid=0, no resolved field) and silently leak. Safety wins.

import { applyTransform, type MaskRule } from "./transforms.ts";

/** Catalog facts about one relation, resolved from pg_class / pg_attribute /
 *  pg_inherits by the caller (cached per connection). */
export interface RelInfo {
  schema: string;
  relname: string;
  /** pg_class.relkind: r=table, p=partitioned, v=view, m=matview, ... */
  relkind: string;
  /** Top of the partition/inheritance chain (self if not a child). A mask is
   *  declared on the parent, so a directly-queried child resolves up to it. */
  topParentOid: number;
  /** attnum -> column name, for the relation identified by THIS oid. */
  columns: Map<number, string>;
}

export type Catalog = Map<number, RelInfo>;
/** "schema.table" -> (column name -> mask rule). */
export type ColumnMasks = Map<string, Map<string, MaskRule>>;

export type MaskOutcome =
  | { ok: true; rows: unknown[]; maskedColumns: string[] }
  | {
      ok: false;
      reason: string;
      offendingColumns: string[];
      // True only for cache-staleness rejects (an OID/attnum the cached catalog
      // didn't know). The caller invalidates the catalog and retries ONCE. A
      // view/computed/whole-row reject is NOT retryable (it's a real shape limit).
      retryable?: boolean;
    };

export interface MaskResultSetInput {
  rows: unknown[];
  fields: import("../executor.ts").ResultField[] | undefined;
  columnMasks: ColumnMasks;
  catalog: Catalog;
  /** Salt keying the deterministic transforms. */
  salt: string;
}

const key = (schema: string, table: string) => `${schema}.${table}`;

// System catalogs carry no maskable customer ROW values, and information_schema
// is how schema discovery (list_tables / describe_table) reads metadata. A
// field resolving to one of these is never masked and never rejected — mirrors
// the information_schema carve-out the table_access + tenant_scope rules already
// apply. (Selecting from an information_schema view reports the VIEW's oid with
// schema=information_schema, which would otherwise hit the view-reject below.)
const SYSTEM_SCHEMAS = new Set(["information_schema", "pg_catalog"]);

export function maskResultSet(input: MaskResultSetInput): MaskOutcome {
  const { rows, fields, columnMasks, catalog, salt } = input;

  // Fast path / regression pin: a connection with NO column_masks is a true
  // no-op — return the original rows untouched.
  if (columnMasks.size === 0) return { ok: true, rows, maskedColumns: [] };

  // Canonicalize the policy keys to "schema.table" (bare names => public.<name>,
  // matching the executor's SET LOCAL search_path pin) so they compare equal to
  // the catalog's schema.relname at lookup. Done once per query.
  //
  // Security decisions below are driven ONLY by per-output-column provenance
  // resolved through the catalog (reliable), NEVER by the IR's "touched tables"
  // — those drop the schema (private.users -> "users") and report a view's name
  // instead of its base table, so a touched-table heuristic both over-rejects
  // and, worse, lets computed outputs over views / non-public schemas leak.
  const canon = (t: string) => (t.includes(".") ? t : `public.${t}`);
  const normMasks = new Map<string, Map<string, MaskRule>>();
  for (const [k, v] of columnMasks) normMasks.set(canon(k), v);

  // A masked-project query with no field metadata = unresolved provenance =>
  // fail closed.
  if (!fields) {
    return {
      ok: false,
      reason:
        "query rejected: this result carries no column provenance, so masking cannot be proven — select masked columns directly from their base table",
      offendingColumns: [],
    };
  }

  // Plan once per query (decision PERF1): decide each output field, collect the
  // transforms to apply, reject on the first unresolvable/leaky field.
  const toMask: { outputName: string; transform: MaskRule; ref: string }[] = [];

  for (const f of fields) {
    if (f.tableOid === 0) {
      // Computed: aggregate, expression, set-op, or whole-row serialization
      // (to_jsonb(users_v), to_jsonb(private.users), ...). It has NO base-column
      // provenance, so we cannot prove it doesn't carry a masked value. With
      // masking enabled (we're past the empty fast-path), reject — fail-closed.
      // This deliberately also rejects a count() over an unrelated table: a
      // touched-table heuristic that views and schema-qualified refs slip past
      // is not safe enough for a redaction control. Loosen later with AST
      // lineage (does the expression actually reference a masked column?).
      return rejectComputed(f.name);
    }
    const rel = catalog.get(f.tableOid);
    if (!rel) {
      // OID not in the (cached) catalog — e.g. a table created after the cache
      // was built. Cannot prove safety -> reject (caller refreshes + retries).
      return {
        ok: false,
        reason: `query rejected: could not resolve the source of column "${f.name}" — re-scan the schema and retry`,
        offendingColumns: [f.name],
        retryable: true,
      };
    }
    if (SYSTEM_SCHEMAS.has(rel.schema)) {
      // information_schema / pg_catalog: system metadata, never customer row
      // values. Never masked, never rejected — this is how schema discovery
      // reads information_schema views (which report the view's oid).
      continue;
    }
    if (rel.relkind === "v" || rel.relkind === "m") {
      // View / matview: tableOid is the VIEW, not the base table, so a base
      // mask would not fire AND tableOid is non-zero — the silent-leak hole.
      // Reject; view-lineage resolution is deferred.
      return {
        ok: false,
        reason: `query rejected: column "${f.name}" comes from a ${rel.relkind === "v" ? "view" : "materialized view"} (${rel.schema}.${rel.relname}); masking can't yet resolve view lineage — query the base table`,
        offendingColumns: [f.name],
      };
    }
    if (rel.relkind !== "r" && rel.relkind !== "p") {
      // Any other relkind (foreign table, etc.) — unproven -> reject.
      return {
        ok: false,
        reason: `query rejected: column "${f.name}" comes from an unsupported relation kind (${rel.relkind})`,
        offendingColumns: [f.name],
      };
    }

    // relkind r/p: resolve to the parent for the mask lookup (masks are declared
    // on the partition parent). Column NAMES are consistent parent<->child even
    // if attnums drift, so resolve the name from THIS oid then look up the mask
    // under the parent's schema.table.
    const colName = rel.columns.get(f.columnAttnum);
    if (colName === undefined) {
      return {
        ok: false,
        reason: `query rejected: could not resolve column attnum ${f.columnAttnum} of ${rel.schema}.${rel.relname}`,
        offendingColumns: [f.name],
        retryable: true,
      };
    }
    const parent = rel.topParentOid !== f.tableOid ? catalog.get(rel.topParentOid) : rel;
    const tableKey = parent ? key(parent.schema, parent.relname) : key(rel.schema, rel.relname);
    const transform = normMasks.get(tableKey)?.get(colName);
    if (transform) {
      toMask.push({ outputName: f.name, transform, ref: `${tableKey}.${colName}` });
    }
  }

  if (toMask.length === 0) return { ok: true, rows, maskedColumns: [] };

  // Apply per cell. Rows are objects keyed by OUTPUT field name (node-pg
  // default). NOTE: duplicate output names (e.g. SELECT u.id, o.id) collapse to
  // one key in node-pg row objects; masking the surviving key is the best we can
  // do and is a documented v1 limitation of the driver's row shape.
  const ctx = { salt };
  const maskedRows = rows.map((row) => {
    if (row === null || typeof row !== "object") return row;
    const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
    for (const m of toMask) {
      if (m.outputName in out) {
        out[m.outputName] = applyTransform(m.transform, out[m.outputName], ctx);
      }
    }
    return out;
  });

  return {
    ok: true,
    rows: maskedRows,
    maskedColumns: [...new Set(toMask.map((m) => m.ref))],
  };
}

function rejectComputed(outputName: string): MaskOutcome {
  return {
    ok: false,
    reason: `query rejected: output "${outputName}" is computed from one or more columns and may include masked data (expression, aggregate, set-op, or row serialization); select masked columns directly`,
    offendingColumns: [outputName],
  };
}
