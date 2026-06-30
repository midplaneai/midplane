// Postgres SourceRewriter — span-splice emission (proven in the Phase-0 spike,
// `.context/spike-emission/`). For each masked base relation it wraps the relation
// reference in a masking subquery `(SELECT …all cols, mask_expr(c) AS c… FROM t) t`
// and splices that in place, leaving the rest of the user's SQL byte-for-byte (the
// minimal-blast-radius posture for a security control). Dialect-internal: like
// normalize.ts / visitor.ts it is allowed to name libpg_query AST nodes (RangeVar,
// ColumnRef). Fail-closed on every uncertainty.
//
// NOT here — companion tasks REQUIRED before Phase-1 ship (this alone is fail-open
// against opaque reads):
//   - function-IDENTITY covert-channel allowlist (per-connection pg_proc shadow
//     scan): rewrite is blind to query_to_xml('…')/dblink/FDW/UDF. See ET2 + doc.
//   - write-path: UPDATE/DELETE WHERE-on-masked reject + RETURNING-list rewrite.
//   - system-column (ctid/…) / whole-row composite reject on a wrapped table.

import { parseSync } from "libpg-query";
import type { RewriteOutcome, SourceRewriter } from "../../masking/source-rewrite.ts";
import type { ColumnMasks } from "../../masking/mask-result-set.ts";
import type { ByNameCatalog, RelationRef } from "../../masking/catalog.ts";
import type { MaskRule } from "../../masking/transforms.ts";
import type { TxClient } from "../../executor.ts";
import type { GateOutcome, ShapeOutcome } from "../../masking/source-rewrite.ts";
import { quoteIdent, transformToSql } from "./transform-sql.ts";
import { checkMaskSafeShape, shadowScan as runShadowScan } from "./mask-safety.ts";

interface RangeVarNode {
  schemaname?: string;
  relname: string;
  alias?: { aliasname?: string };
  location: number;
}

const canonKey = (schema: string | null | undefined, relname: string): string =>
  `${schema ?? "public"}.${relname}`;

// Canonicalize the policy's mask keys to "schema.table" (bare → public), matching
// the executor's search_path pin, so lookups by the catalog's canonical parentKey
// compare equal.
function canonMasks(masks: ColumnMasks): ColumnMasks {
  const m: ColumnMasks = new Map();
  for (const [k, v] of masks) m.set(k.includes(".") ? k : `public.${k}`, v);
  return m;
}

function eachRangeVar(node: unknown, cb: (rv: RangeVarNode) => void): void {
  if (Array.isArray(node)) {
    for (const x of node) eachRangeVar(x, cb);
    return;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o.RangeVar) cb(o.RangeVar as RangeVarNode);
    for (const k of Object.keys(o)) eachRangeVar(o[k], cb);
  }
}

// End offset of the `[schema.]relname` token starting at byte `location`. libpg_query
// gives a node start, not an extent, so we scan the qualified identifier ourselves
// (quotes + optional whitespace around the dot). We replace only this token and keep
// any trailing `[AS] alias` verbatim.
function identExtent(sql: string, start: number): number {
  let i = start;
  const scanIdent = () => {
    if (sql[i] === '"') {
      i++;
      while (i < sql.length && sql[i] !== '"') i++;
      i++;
    } else {
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i]!)) i++;
    }
  };
  scanIdent();
  let j = i;
  while (j < sql.length && /\s/.test(sql[j]!)) j++;
  if (sql[j] === ".") {
    j++;
    while (j < sql.length && /\s/.test(sql[j]!)) j++;
    i = j;
    scanIdent();
  }
  return i;
}

// Codex #5a (validated on live PG): a schema-qualified column ref `public.t.col`
// does NOT bind after the wrap (a subquery alias is a single identifier). Reject any
// such ref to a wrapped table rather than emit SQL Postgres throws on.
function schemaQualifiedColrefReject(ast: unknown, wrappedKeys: Set<string>): string | null {
  let bad: string | null = null;
  (function walk(node: unknown): void {
    if (bad) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (o.ColumnRef) {
        const fields = (o.ColumnRef as { fields?: unknown[] }).fields ?? [];
        const parts = fields.map((f) => {
          const s = (f as { String?: { sval?: string } }).String;
          return s?.sval;
        });
        if (parts.length >= 3 && parts[0] && parts[1]) {
          const key = `${parts[0]}.${parts[1]}`;
          if (wrappedKeys.has(key)) {
            bad = `schema-qualified column reference "${parts[0]}.${parts[1]}.${parts[2] ?? ""}" does not bind to a masked table; use the table alias or an unqualified column`;
          }
        }
      }
      for (const k of Object.keys(o)) walk(o[k]);
    }
  })(ast);
  return bad;
}

export const postgresSourceRewriter: SourceRewriter = {
  collectRefs(sql: string): RelationRef[] {
    let ast: unknown;
    try {
      ast = parseSync(sql);
    } catch {
      return []; // unparseable — policy/parse_error already rejected upstream
    }
    const refs: RelationRef[] = [];
    eachRangeVar(ast, (rv) => refs.push({ schema: rv.schemaname ?? null, relname: rv.relname }));
    return refs;
  },

  rewrite(sql: string, masks: ColumnMasks, catalog: ByNameCatalog): RewriteOutcome {
    const M = canonMasks(masks);
    let ast: unknown;
    try {
      ast = parseSync(sql);
    } catch {
      return { ok: false, reason: "could not parse statement for rewrite" };
    }

    const edits: { start: number; end: number; repl: string }[] = [];
    const wrappedKeys = new Set<string>();
    const maskedColumns: string[] = [];
    let reject: string | null = null;

    eachRangeVar(ast, (rv) => {
      if (reject) return;
      const refKey = canonKey(rv.schemaname, rv.relname);
      const rel = catalog.get(refKey);
      if (!rel) {
        // Not a resolvable base relation. Reject ONLY if it is itself a declared mask
        // target (a masked table that vanished from the catalog — stale, retry); a
        // CTE name / subquery alias / unmasked-unrelated table just isn't a pg_class
        // relation here, so skip it.
        if (M.has(refKey)) {
          reject = `could not resolve masked relation ${refKey} — re-scan the schema and retry`;
        }
        return;
      }
      const colMasks = M.get(rel.parentKey);
      if (!colMasks) return; // resolvable base table, but not masked → leave verbatim

      if (rel.relkind === "v" || rel.relkind === "m") {
        reject = `${refKey} is a ${rel.relkind === "v" ? "view" : "materialized view"}; masking can't resolve view lineage yet — query the base table`;
        return;
      }
      if (rel.relkind !== "r" && rel.relkind !== "p") {
        reject = `${refKey} is an unsupported relation kind (${rel.relkind}) for masking`;
        return;
      }

      // Build the full projection: every column in attnum order, masked ones wrapped.
      const proj: string[] = [];
      for (const colName of rel.columns) {
        const rule: MaskRule | undefined = colMasks.get(colName);
        const qc = quoteIdent(colName);
        if (!rule) {
          proj.push(qc);
          continue;
        }
        const emit = transformToSql(rule, qc, rel.columnTypes.get(colName));
        if (!emit.ok) {
          reject = `cannot mask ${rel.parentKey}.${colName}: ${emit.reason}`;
          return;
        }
        proj.push(`${emit.sql} AS ${qc}`);
        maskedColumns.push(`${rel.parentKey}.${colName}`);
      }

      const innerRef =
        (rv.schemaname ? `${quoteIdent(rv.schemaname)}.` : "") + quoteIdent(rv.relname);
      const start = rv.location;
      const end = identExtent(sql, start);
      // Replace only the `[schema.]relname` token; keep any trailing `[AS] alias`
      // verbatim. When the source had no alias, synthesize one (= relname) so the
      // subquery is aliased and unqualified/relname-qualified refs still bind.
      const wrap = `(SELECT ${proj.join(", ")} FROM ${innerRef})` + (rv.alias ? "" : ` ${quoteIdent(rv.relname)}`);
      edits.push({ start, end, repl: wrap });
      wrappedKeys.add(refKey);
    });

    if (reject) return { ok: false, reason: reject };
    if (edits.length === 0) return { ok: true, sql, maskedColumns: [] }; // nothing masked → verbatim

    const colrefReject = schemaQualifiedColrefReject(ast, wrappedKeys);
    if (colrefReject) return { ok: false, reason: colrefReject };

    // Apply right-to-left so earlier byte offsets stay valid.
    edits.sort((a, b) => b.start - a.start);
    let out = sql;
    for (const e of edits) out = out.slice(0, e.start) + e.repl + out.slice(e.end);
    return { ok: true, sql: out, maskedColumns };
  },

  // Covert-channel gate (ET2), delegated to mask-safety.ts.
  checkShape(sql: string): ShapeOutcome {
    return checkMaskSafeShape(sql);
  },
  shadowScan(tx: TxClient, names: string[]): Promise<GateOutcome> {
    return runShadowScan(tx, names);
  },
};
