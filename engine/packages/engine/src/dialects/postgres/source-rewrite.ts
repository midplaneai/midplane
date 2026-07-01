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

// True system columns (attnum < 0): NOT in the wrap projection, so a reference to
// one on a wrapped table won't bind. `oid` is omitted — it's a plausible user
// column name and rarely a system column post-PG12.
const SYSTEM_COLUMNS = new Set(["ctid", "tableoid", "xmin", "xmax", "cmin", "cmax"]);

function topStmt(ast: unknown): Record<string, unknown> | null {
  const s = (ast as { stmts?: { stmt?: unknown }[] }).stmts?.[0]?.stmt;
  return s && typeof s === "object" ? (s as Record<string, unknown>) : null;
}

// The write TARGET relation (UPDATE/DELETE/INSERT/MERGE). Never wrapped — a write
// target can't be a subquery — and the place we guard masked-column references.
// libpg_query serializes the typed `relation` (RangeVar*) field INLINE (no
// {RangeVar:...} wrapper, unlike generic fromClause items), so read both shapes.
function writeTarget(stmt: Record<string, unknown> | null): { rv: RangeVarNode; key: string } | null {
  if (!stmt) return null;
  for (const k of ["UpdateStmt", "DeleteStmt", "InsertStmt", "MergeStmt"]) {
    const relation = (stmt[k] as { relation?: unknown } | undefined)?.relation;
    const rv = asRangeVar(relation);
    if (rv) return { rv, key: canonKey(rv.schemaname, rv.relname) };
  }
  return null;
}

function asRangeVar(relation: unknown): RangeVarNode | null {
  if (!relation || typeof relation !== "object") return null;
  const o = relation as Record<string, unknown>;
  if (o.RangeVar) return o.RangeVar as RangeVarNode; // defensive: wrapped shape
  return typeof o.relname === "string" ? (o as unknown as RangeVarNode) : null; // inline shape
}

// True if any ColumnRef under `node` names one of `masked` (its last identifier).
function refsMaskedColumn(node: unknown, masked: Set<string>): boolean {
  let found = false;
  (function walk(n: unknown): void {
    if (found) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object") {
      const o = n as Record<string, unknown>;
      if (o.ColumnRef) {
        const fields = (o.ColumnRef as { fields?: unknown[] }).fields ?? [];
        const last = fields.map((f) => (f as { String?: { sval?: string } }).String?.sval).pop();
        if (typeof last === "string" && masked.has(last)) {
          found = true;
          return;
        }
      }
      for (const k of Object.keys(o)) walk(o[k]);
    }
  })(node);
  return found;
}

// A RETURNING clause on a masked target may expose a masked column three ways: an
// explicit masked column, `*` / `t.*` (A_Star), or a whole-row composite of the
// target (`RETURNING <target>`). v1 doesn't mask RETURNING and the write target is
// never wrapped, so ANY of these would return the raw masked value — reject all.
function returningExposesMasked(
  returningList: unknown,
  masked: Set<string>,
  targetNames: Set<string>,
): boolean {
  let bad = false;
  (function walk(n: unknown): void {
    if (bad) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object") {
      const o = n as Record<string, unknown>;
      if (o.A_Star) {
        bad = true; // RETURNING * or RETURNING t.*
        return;
      }
      if (o.ColumnRef) {
        const parts = ((o.ColumnRef as { fields?: unknown[] }).fields ?? []).map(
          (f) => (f as { String?: { sval?: string } }).String?.sval,
        );
        const last = parts[parts.length - 1];
        if (typeof last === "string" && masked.has(last)) {
          bad = true; // explicit masked column
          return;
        }
        if (parts.length === 1 && typeof parts[0] === "string" && targetNames.has(parts[0])) {
          bad = true; // whole-row composite of the target (RETURNING <target>)
          return;
        }
      }
      for (const k of Object.keys(o)) walk(o[k]);
    }
  })(returningList);
  return bad;
}

// Masking is READ-side. A write to a masked target may not reference a masked column
// in its WHERE / ON CONFLICT (inference via rows-affected) or expose one via
// RETURNING (v1 doesn't mask RETURNING); a masked-target MERGE is rejected wholesale
// in v1. Returns the offending clause name, or null. (The SET targetList is not
// checked — writing a masked value into another column reveals nothing to the agent
// that wrote it.) `targetNames` = the write target's relname + alias.
function maskedWriteClause(
  stmt: Record<string, unknown>,
  masked: Set<string>,
  targetNames: Set<string>,
): string | null {
  if (stmt.MergeStmt) return "MERGE";
  const target = (stmt.UpdateStmt ?? stmt.DeleteStmt ?? stmt.InsertStmt) as
    | Record<string, unknown>
    | undefined;
  if (!target) return null;
  if (refsMaskedColumn(target.whereClause, masked)) return "WHERE";
  if (refsMaskedColumn(target.onConflictClause, masked)) return "ON CONFLICT";
  if (returningExposesMasked(target.returningList, masked, targetNames)) return "RETURNING";
  return null;
}

// CTE names declared anywhere in the statement (for the shadowing check).
function collectCteNames(ast: unknown): Set<string> {
  const names = new Set<string>();
  (function walk(n: unknown): void {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object") {
      const o = n as Record<string, unknown>;
      const name = (o.CommonTableExpr as { ctename?: string } | undefined)?.ctename;
      if (typeof name === "string") names.add(name);
      for (const k of Object.keys(o)) walk(o[k]);
    }
  })(ast);
  return names;
}

// System-column reject (Codex #8): reject a system-column reference qualified by a
// wrapped table's alias, or unqualified while something is wrapped (fail-closed).
function systemColumnReject(ast: unknown, wrappedAliases: Set<string>): string | null {
  let bad: string | null = null;
  (function walk(n: unknown): void {
    if (bad) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === "object") {
      const o = n as Record<string, unknown>;
      if (o.ColumnRef) {
        const parts = ((o.ColumnRef as { fields?: unknown[] }).fields ?? []).map(
          (f) => (f as { String?: { sval?: string } }).String?.sval,
        );
        const last = parts[parts.length - 1];
        if (typeof last === "string" && SYSTEM_COLUMNS.has(last)) {
          const qualifier = parts.length >= 2 ? parts[parts.length - 2] : null;
          if (qualifier == null || wrappedAliases.has(qualifier)) {
            bad = `system column "${last}" is not available on a masked (wrapped) table`;
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

    // CTE shadowing guard (reviewer #2). A CTE that shares a name with a masked table
    // makes `FROM <name>` bind to the CTE in SQL, but the catalog lookup below would
    // wrap it as the base table — changing semantics / reading a relation the query
    // didn't reference at that scope. Fail closed on the collision (bare CTE names vs
    // the masked tables' bare relnames).
    const maskedBare = new Set([...M.keys()].map((k) => k.slice(k.lastIndexOf(".") + 1)));
    for (const cte of collectCteNames(ast)) {
      if (maskedBare.has(cte)) {
        return {
          ok: false,
          reason: `a CTE named "${cte}" shadows a masked table; rename the CTE so masking can tell the base table from the CTE`,
        };
      }
    }

    // Write-target guard (masking is read-side). The write target is never wrapped
    // (a write target can't be a subquery); a write to a masked table may not
    // reference a masked column in WHERE / ON CONFLICT / RETURNING. Read-position
    // tables inside the write (UPDATE … FROM, INSERT … SELECT) are still wrapped by
    // the loop below.
    const stmt = topStmt(ast);
    const write = writeTarget(stmt);
    if (write && stmt) {
      const targetRel = catalog.get(write.key);
      if (!targetRel) {
        if (M.has(write.key)) {
          return { ok: false, reason: `could not resolve masked relation ${write.key} — re-scan the schema and retry` };
        }
      } else {
        const tcm = M.get(targetRel.parentKey);
        if (tcm) {
          const targetNames = new Set<string>([
            write.rv.relname,
            ...(write.rv.alias?.aliasname ? [write.rv.alias.aliasname] : []),
          ]);
          const clause = maskedWriteClause(stmt, new Set(tcm.keys()), targetNames);
          if (clause) {
            return {
              ok: false,
              reason: `a write to masked table ${targetRel.parentKey} references a masked column in its ${clause}; masking protects reads — remove the masked column from the ${clause}`,
            };
          }
        }
      }
    }

    const edits: { start: number; end: number; repl: string }[] = [];
    const wrappedKeys = new Set<string>();
    const wrappedAliases = new Set<string>();
    const maskedColumns: string[] = [];
    let reject: string | null = null;

    eachRangeVar(ast, (rv) => {
      if (reject) return;
      if (write && rv === write.rv) return; // write target: never a read position
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
      wrappedAliases.add(rv.alias?.aliasname ?? rv.relname);
    });

    if (reject) return { ok: false, reason: reject };
    if (edits.length === 0) return { ok: true, sql, maskedColumns: [] }; // nothing masked → verbatim

    const colrefReject = schemaQualifiedColrefReject(ast, wrappedKeys);
    if (colrefReject) return { ok: false, reason: colrefReject };

    const sysReject = systemColumnReject(ast, wrappedAliases);
    if (sysReject) return { ok: false, reason: sysReject };

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
