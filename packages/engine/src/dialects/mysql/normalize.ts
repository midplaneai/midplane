// MySQL → normalized IR adapter.
//
// The MySQL analog of dialects/postgres/normalize.ts, and the ONLY file in the
// engine that names node-sql-parser AST shapes. It projects node-sql-parser's
// MySQL AST into the same dialect-agnostic NormalizedProgram the PG adapter
// emits, so the policy rules — unchanged, dialect-blind — produce the same
// verdicts for MySQL that they do for Postgres.
//
// node-sql-parser AST cheat-sheet (verified against the real parser, pinned by
// dialects/mysql/normalize.test.ts):
//   • astify(sql) → one stmt object, OR an array for multi-statement / trailing ';'.
//   • Each stmt has a lowercase `type`: select|insert|replace|update|delete|
//     drop|truncate|create|alter|rename|use|call|set|... .
//   • Table ref:  { db: string|null, table: string, as: string|null, join?, on? }
//     in `from[]` / `table[]` / `name[]`. A FROM-subquery is { expr: { ast }, as }.
//   • column_ref: { type:'column_ref', table: string|null, column: string }, with
//     a `db` field added for a 3-part `db.table.col` qualifier.
//   • where: a binary_expr tree ({ type:'binary_expr', operator, left, right }).
//   • UNION arms chain via `_next` (+ `set_op`); CTEs live under `with[].stmt.ast`.
//
// SECURITY (fail-closed). The bare-name soundness guarantee for MySQL is the
// executor's database pin (the DSN names the database; multipleStatements:false;
// USE is denied here). This adapter enforces the parser-side half:
//   • USE → unsupported{keyword:'USE'} + synthetic no_target. We do NOT rely on
//     the multi_statement rule as the backstop (USE can stand alone).
//   • Any db.table[.col] whose `db` is neither the connected database nor the
//     information_schema discovery carve-out → unsupported (a cross-database
//     reference is a tenant-bypass even with the database pin). This is the real
//     analog of the PG search_path pin: it keeps bare/own-db policy keys sound.
//   • Every `unsupported` statement ALSO emits a synthetic no_target AccessCheck
//     so table_access denies it (tenant_scope already consumes `unsupported`).
//   • Anything we can't model (unknown statement type, MERGE if the parser ever
//     starts accepting it, …) → unsupported → denied.
// MERGE is not special-cased: node-sql-parser rejects it outright in MySQL mode,
// so it lands as a parse_error DENY before reaching here.

import type {
  AccessCheck,
  EqualityPredicate,
  InsertShape,
  NormalizedProgram,
  ScopeUnit,
  TableRef,
  UnsupportedStatement,
} from "../../ir/types.ts";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const asString = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

// Build the dialect's normalize(). Closes over the connected database name so
// the cross-DB guard can tell an own-database qualifier (allowed, normalized to
// bare) from a foreign one (denied). `database === null` (the registry's default
// singleton, used only by getDialect()/tests with no DSN context) is the strict
// fallback: every explicit non-information_schema db qualifier is rejected.
export function createNormalize(
  database: string | null,
): (ast: unknown) => NormalizedProgram {
  return (ast: unknown): NormalizedProgram => normalize(ast, database);
}

interface Out {
  accessChecks: AccessCheck[];
  scopeUnits: ScopeUnit[];
  unsupported: UnsupportedStatement[];
  relnames: Set<string>;
}

function normalize(ast: unknown, database: string | null): NormalizedProgram {
  const stmts: unknown[] = Array.isArray(ast) ? ast : ast === undefined ? [] : [ast];
  const out: Out = {
    accessChecks: [],
    scopeUnits: [],
    unsupported: [],
    relnames: new Set<string>(),
  };

  for (const s of stmts) {
    if (isObj(s)) normalizeStatement(s, database, out);
  }

  return {
    statementCount: stmts.length,
    auditStatementType: stmts.length > 0 ? statementKeyword(stmts[0]) : null,
    allRelnames: [...out.relnames],
    accessChecks: out.accessChecks,
    scopeUnits: out.scopeUnits,
    unsupported: out.unsupported,
  };
}

// Program-level audit statement_type: the canonical uppercase keyword of the
// first statement's node type (select → SELECT, insert → INSERT, …). Mirrors
// the PG adapter's "first /Stmt$/ node, uppercased" at the dialect level.
function statementKeyword(stmt: unknown): string {
  if (!isObj(stmt)) return "UNKNOWN";
  const t = asString(stmt.type);
  return t ? t.toUpperCase() : "UNKNOWN";
}

// ── DB-qualifier classification (the cross-DB guard) ────────────────────────

type DbClass = "bare" | "own" | "information_schema" | "foreign";

function classifyDb(db: unknown, database: string | null): DbClass {
  const d = asString(db);
  if (d === null) return "bare";
  if (d === "information_schema") return "information_schema";
  if (database !== null && d === database) return "own";
  return "foreign"; // foreign DB, or database unknown (strict fallback)
}

// schema field for a TableRef given its db classification. Own-database and bare
// refs collapse to null (bare name against the connected DB, like a PG public
// ref); information_schema carries through so the rules' carve-out applies.
function schemaFor(cls: DbClass): string | null {
  return cls === "information_schema" ? "information_schema" : null;
}

// Does the statement reference any database other than the connected one (or the
// information_schema carve-out)? A single foreign qualifier on a table ref OR a
// 3-part column ref poisons the whole statement → fail-closed deny.
function hasForeignDbRef(node: unknown, database: string | null): boolean {
  let found = false;
  const visit = (v: unknown): void => {
    if (found || v === null || v === undefined) return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (!isObj(v)) return;
    if ("db" in v && classifyDb(v.db, database) === "foreign") {
      found = true;
      return;
    }
    for (const k of Object.keys(v)) visit(v[k]);
  };
  visit(node);
  return found;
}

// ── TableRef extraction ─────────────────────────────────────────────────────

// A node-sql-parser table ref ({ db, table, as }). Returns null for non-table
// FROM entries (subqueries: { expr, as }).
function toTableRef(entry: unknown, database: string | null): TableRef | null {
  if (!isObj(entry)) return null;
  const relname = asString(entry.table);
  if (relname === null) return null;
  if ("expr" in entry) return null; // FROM-subquery, not a base table
  const cls = classifyDb(entry.db, database);
  const alias = asString(entry.as);
  return {
    schema: schemaFor(cls),
    relname,
    effectiveName: alias ?? relname,
    alias,
  };
}

function addRelname(out: Out, name: string | null): void {
  if (name !== null) out.relnames.add(name);
}

// Collect every relname the statement structurally touches — for audit
// tables_touched. Walks the whole tree adding table-ref `table` names (incl. CTE
// references and DML targets) and CTE definition names, in first-encounter
// order, Set-deduped. ColumnRef qualifiers are excluded (only real relations
// count, matching the PG accumulator's RangeVar-only walk).
function collectRelnames(node: unknown, out: Out): void {
  const visit = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (!isObj(v)) return;
    // CTE definition name: with[].name.value
    if (isObj(v.name) && asString((v.name as Obj).value) && "stmt" in v) {
      addRelname(out, asString((v.name as Obj).value));
    }
    // Table ref shape: has a string `table`, is not a column_ref, no `column`.
    if (v.type !== "column_ref" && !("column" in v) && asString(v.table)) {
      addRelname(out, asString(v.table));
    }
    for (const k of Object.keys(v)) visit(v[k]);
  };
  visit(node);
}

// ── Literals + equality predicates (AND-only) ───────────────────────────────

// Stringify a literal node the same way the PG adapter does: number → String(n),
// string → its value. Other node kinds aren't constant literals the tenant check
// can compare, so they're null (predicate won't match → conservative).
function literalOf(node: unknown): string | null {
  if (!isObj(node)) return null;
  const t = node.type;
  if (t === "number" && (typeof node.value === "number" || typeof node.value === "bigint")) {
    return String(node.value);
  }
  if (
    (t === "single_quote_string" || t === "double_quote_string" || t === "string") &&
    typeof node.value === "string"
  ) {
    return node.value;
  }
  return null;
}

// { qualifier, column } from a column_ref. The qualifier is the immediate table
// part (alias or table name); for an own-database 3-part `db.table.col` ref the
// db has already passed the cross-DB guard, so we use `table` as the qualifier
// exactly as the bare 2-part form does.
function columnRefOf(node: unknown): { qualifier: string | null; column: string } | null {
  if (!isObj(node) || node.type !== "column_ref") return null;
  const column = asString(node.column);
  if (column === null) return null;
  return { qualifier: asString(node.table), column };
}

// AND-only equality predicates reachable from a WHERE tree. OR/NOT do not
// strengthen the constraint, so recursion stops at them — mirrors the PG
// adapter's AEXPR_OP "=" / BoolExpr AND_EXPR collection.
function collectPredicates(where: unknown): EqualityPredicate[] {
  const out: EqualityPredicate[] = [];
  const recurse = (node: unknown): void => {
    if (!isObj(node) || node.type !== "binary_expr") return;
    const op = node.operator;
    if (op === "AND") {
      recurse(node.left);
      recurse(node.right);
      return;
    }
    if (op === "=") {
      const lcol = columnRefOf(node.left);
      const rlit = literalOf(node.right);
      if (lcol && rlit !== null) out.push({ ...lcol, literal: rlit });
      const rcol = columnRefOf(node.right);
      const llit = literalOf(node.left);
      if (rcol && llit !== null) out.push({ ...rcol, literal: llit });
    }
  };
  recurse(where);
  return out;
}

// ── Scope (tenant_scope) collection ─────────────────────────────────────────

// Base tables visible AT a SELECT scope: the from[] entries that are real
// tables (subqueries are skipped — their interior is its own scope). UNFILTERED
// by config and NOT CTE-filtered — the PG adapter treats a CTE reference in FROM
// as a base table for tenant_scope too (the rule applies requiredColumnFor + the
// information_schema carve-out).
function scopeBaseTables(from: unknown, database: string | null): TableRef[] {
  if (!Array.isArray(from)) return [];
  const out: TableRef[] = [];
  for (const entry of from) {
    const ref = toTableRef(entry, database);
    if (ref) out.push(ref);
  }
  return out;
}

// Recursively find direct subquery selects ({ ast: <select> }) within an
// expression, WITHOUT descending into a found subquery (its own where/from is
// handled when that select is itself walked). Covers WHERE IN/EXISTS/scalar
// subqueries and SELECT-list scalar subqueries.
function findSubquerySelects(node: unknown): Obj[] {
  const out: Obj[] = [];
  const visit = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (!isObj(v)) return;
    if (isObj(v.ast) && (v.ast as Obj).type === "select") {
      out.push(v.ast as Obj);
      return; // do not descend — the subquery is walked on its own
    }
    for (const k of Object.keys(v)) visit(v[k]);
  };
  visit(node);
  return out;
}

// Emit a scope unit for a SELECT and recurse into every nested SELECT (CTEs,
// FROM-subqueries, WHERE/HAVING/column subqueries, UNION arms). Mirrors the PG
// adapter's per-SelectStmt scope walk.
function emitSelectScopes(select: Obj, database: string | null, out: Out): void {
  out.scopeUnits.push({
    kind: "scope",
    tables: scopeBaseTables(select.from, database),
    predicates: collectPredicates(select.where),
  });

  // CTE bodies: with[].stmt.ast
  if (Array.isArray(select.with)) {
    for (const cte of select.with) {
      const inner = isObj(cte) && isObj(cte.stmt) ? (cte.stmt as Obj).ast : undefined;
      if (isObj(inner) && inner.type === "select") emitSelectScopes(inner, database, out);
    }
  }

  // FROM-subqueries: from[].expr.ast
  if (Array.isArray(select.from)) {
    for (const entry of select.from) {
      const inner = isObj(entry) && isObj(entry.expr) ? (entry.expr as Obj).ast : undefined;
      if (isObj(inner) && inner.type === "select") emitSelectScopes(inner, database, out);
    }
  }

  // WHERE / HAVING / SELECT-list subqueries
  for (const region of [select.where, select.having, select.columns]) {
    for (const sub of findSubquerySelects(region)) emitSelectScopes(sub, database, out);
  }

  // UNION / set-op arms
  if (isObj(select._next) && select._next.type === "select") {
    emitSelectScopes(select._next, database, out);
  }
}

// ── Read (table_access) collection ──────────────────────────────────────────

// Emit `read` AccessChecks for every base table read anywhere in a SELECT tree,
// excluding CTE-shadowed references (a FROM entry whose bare name matches a CTE
// defined in scope is a virtual table, not a real one — mirrors the PG adapter's
// isCteReference exclusion). CTE bodies / subqueries / UNION arms recurse.
//
// `defining` carries the names of CTEs whose own body we're currently inside.
// A non-recursive CTE's name does NOT bind in its own definition, so a body
// reference to a real table that shares the CTE name is a REAL read and must be
// checked — not skipped as a CTE reference (the self-shadow bypass). A RECURSIVE
// WITH leaves the exclusion off, so a self-reference stays a CTE ref.
function emitSelectReads(
  select: Obj,
  cteStack: Set<string>[],
  defining: string[],
  database: string | null,
  out: Out,
): void {
  const cteNames = collectCteNames(select);
  const recursive =
    Array.isArray(select.with) && select.with.some((c) => isObj(c) && (c as Obj).recursive === true);
  if (cteNames) cteStack.push(cteNames);

  const isCteRef = (ref: TableRef): boolean => {
    if (ref.schema !== null) return false;
    if (defining.includes(ref.relname)) return false;
    for (const scope of cteStack) if (scope.has(ref.relname)) return true;
    return false;
  };

  if (Array.isArray(select.from)) {
    for (const entry of select.from) {
      const ref = toTableRef(entry, database);
      if (ref && !isCteRef(ref)) out.accessChecks.push({ kind: "read", ref });
      // FROM-subquery interior
      const inner = isObj(entry) && isObj((entry as Obj).expr) ? ((entry as Obj).expr as Obj).ast : undefined;
      if (isObj(inner) && inner.type === "select") emitSelectReads(inner, cteStack, defining, database, out);
    }
  }

  // CTE bodies — each walked with its OWN name excluded (unless the WITH is
  // RECURSIVE), so a body read of a real table sharing the CTE name is checked.
  if (Array.isArray(select.with)) {
    for (const cte of select.with) {
      const inner = isObj(cte) && isObj((cte as Obj).stmt) ? ((cte as Obj).stmt as Obj).ast : undefined;
      const cteName = isObj(cte) && isObj((cte as Obj).name) ? asString(((cte as Obj).name as Obj).value) : null;
      if (isObj(inner) && inner.type === "select") {
        const exclude = cteName !== null && !recursive;
        if (exclude) defining.push(cteName);
        emitSelectReads(inner, cteStack, defining, database, out);
        if (exclude) defining.pop();
      }
    }
  }

  // WHERE / HAVING / SELECT-list subqueries (part of the main query — they see
  // this select's CTE names via cteStack, and `defining` is back to its incoming
  // state here since each CTE body push/pop is balanced above).
  for (const region of [select.where, select.having, select.columns]) {
    for (const sub of findSubquerySelects(region)) emitSelectReads(sub, cteStack, defining, database, out);
  }

  // UNION arms
  if (isObj(select._next) && select._next.type === "select") {
    emitSelectReads(select._next, cteStack, defining, database, out);
  }

  if (cteNames) cteStack.pop();
}

function collectCteNames(select: Obj): Set<string> | null {
  if (!Array.isArray(select.with)) return null;
  const names = new Set<string>();
  for (const cte of select.with) {
    const n = isObj(cte) && isObj((cte as Obj).name) ? asString(((cte as Obj).name as Obj).value) : null;
    if (n) names.add(n);
  }
  return names.size > 0 ? names : null;
}

// ── Per-statement dispatch ──────────────────────────────────────────────────

function emitUnsupported(keyword: string, stmt: Obj, database: string | null, out: Out): void {
  const touched = collectTableRefsFlat(stmt, database);
  out.unsupported.push({ keyword, touchedTables: touched });
  out.accessChecks.push({ kind: "no_target", keyword });
  collectRelnames(stmt, out);
}

// A no_target deny WITHOUT an `unsupported` entry — for side-effect statements
// that have no per-table grant target and no tenant-scoped table to verify
// (CALL, SET). Mirrors the PG adapter's no_target for CallStmt / VariableSetStmt.
function emitNoTarget(keyword: string, out: Out): void {
  out.accessChecks.push({ kind: "no_target", keyword });
}

// Flat list of every table ref in a statement — for an unsupported entry's
// touchedTables, so tenant_scope fails closed if any is scoped.
function collectTableRefsFlat(stmt: Obj, database: string | null): TableRef[] {
  const out: TableRef[] = [];
  const visit = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (!isObj(v)) return;
    if (v.type !== "column_ref" && !("column" in v) && asString(v.table)) {
      const ref = toTableRef(v, database);
      if (ref) out.push(ref);
    }
    for (const k of Object.keys(v)) visit(v[k]);
  };
  visit(stmt);
  return out;
}

function normalizeStatement(stmt: Obj, database: string | null, out: Out): void {
  const type = asString(stmt.type);

  // USE is denied unconditionally (RED) — do NOT lean on multi_statement.
  if (type === "use") {
    emitUnsupported("USE", stmt, database, out);
    return;
  }

  // Cross-DB reference guard (RED): a foreign db qualifier poisons the whole
  // statement. Caught before normal processing so it can never slip through a
  // read/scope path.
  if (hasForeignDbRef(stmt, database)) {
    emitUnsupported("cross-database reference", stmt, database, out);
    return;
  }

  switch (type) {
    case "select":
      collectRelnames(stmt, out);
      emitSelectReads(stmt, [], [], database, out);
      emitSelectScopes(stmt, database, out);
      return;
    case "insert":
      handleInsert(stmt, database, out, false);
      return;
    case "replace":
      // REPLACE = delete-then-insert; it can clobber another tenant's row by a
      // unique-key collision, so it gets the upsert deny path (onConflictDoUpdate).
      handleInsert(stmt, database, out, true);
      return;
    case "update":
      handleUpdate(stmt, database, out);
      return;
    case "delete":
      handleDelete(stmt, database, out);
      return;
    case "drop":
    case "truncate":
      handleDropTruncate(stmt, database, out);
      return;
    case "create":
      handleCreate(stmt, database, out);
      return;
    case "alter":
    case "rename":
      handleAlterRename(stmt, database, out);
      return;
    case "call":
    case "set":
      // Side-effect statements: no per-table target, no scoped table to verify.
      emitNoTarget((type ?? "").toUpperCase(), out);
      return;
    default:
      // Fail-closed: anything we don't explicitly model is denied.
      emitUnsupported((type ?? "UNKNOWN").toUpperCase(), stmt, database, out);
      return;
  }
}

// ── write-statement handlers ─────────────────────────────────────────────────

// INSERT / REPLACE. Write target(s) first (first-failure ordering), then reads
// for an INSERT…SELECT source, then the tenant_scope insert unit.
function handleInsert(stmt: Obj, database: string | null, out: Out, forceUpsert: boolean): void {
  collectRelnames(stmt, out);
  const targets = tableRefArray(stmt.table, database);
  for (const t of targets) out.accessChecks.push({ kind: "write", ref: t });

  // INSERT … SELECT: `values` is a select AST. Its source tables are reads.
  if (isObj(stmt.values) && stmt.values.type === "select") {
    emitSelectReads(stmt.values as Obj, [], [], database, out);
    emitSelectScopes(stmt.values as Obj, database, out);
  }

  const shape = insertShape(stmt, database, forceUpsert);
  if (shape) out.scopeUnits.push({ kind: "insert", shape });
}

function insertShape(stmt: Obj, database: string | null, forceUpsert: boolean): InsertShape | null {
  const target = tableRefArray(stmt.table, database)[0];
  if (!target) return null;

  const colsRaw = stmt.columns;
  const hasExplicitColumns = Array.isArray(colsRaw) && colsRaw.length > 0;
  const columns: string[] = hasExplicitColumns
    ? (colsRaw as unknown[]).map((c) => asString(c) ?? "")
    : [];

  // VALUES rows: stmt.values = { type:'values', values:[{ type:'expr_list', value:[lit,…] }] }.
  // INSERT…SELECT and INSERT…SET have no static VALUES rows → null (deny path).
  let valuesRows: (string | null)[][] | null = null;
  if (isObj(stmt.values) && stmt.values.type === "values" && Array.isArray(stmt.values.values)) {
    valuesRows = [];
    for (const row of stmt.values.values as unknown[]) {
      const list = isObj(row) ? (row as Obj).value : undefined;
      const items = Array.isArray(list) ? (list as unknown[]) : [];
      valuesRows.push(items.map((it) => literalOf(it)));
    }
  }

  // `INSERT … ON DUPLICATE KEY UPDATE` re-opens the row to writes → deny path,
  // exactly like PG's ON CONFLICT DO UPDATE. REPLACE forces the same path.
  const onConflictDoUpdate = forceUpsert || isObj(stmt.on_duplicate_update);

  return { target, hasExplicitColumns, columns, valuesRows, onConflictDoUpdate };
}

// UPDATE. The written tables are those named by the SET list (by qualifier);
// joined tables that are only read get a read check + appear in the scope unit.
// Single-table UPDATE (no qualifiers) → the sole base table is the write target.
function handleUpdate(stmt: Obj, database: string | null, out: Out): void {
  collectRelnames(stmt, out);
  const bases = tableRefArray(stmt.table, database);
  const setArr = Array.isArray(stmt.set) ? (stmt.set as unknown[]) : [];
  const writtenQualifiers = new Set<string>();
  let hasUnqualifiedSet = false;
  for (const s of setArr) {
    const q = isObj(s) ? asString(s.table) : null;
    if (q === null) hasUnqualifiedSet = true;
    else writtenQualifiers.add(q);
  }

  const isWrite = (t: TableRef, idx: number): boolean => {
    if (writtenQualifiers.has(t.effectiveName)) return true;
    // An unqualified SET (the single-table case) writes the primary target.
    return hasUnqualifiedSet && idx === 0;
  };

  // Write checks first (for first-failure ordering), then reads for every base
  // table, then the scope unit over all base tables.
  bases.forEach((t, i) => {
    if (isWrite(t, i)) out.accessChecks.push({ kind: "write", ref: t });
  });
  for (const t of bases) out.accessChecks.push({ kind: "read", ref: t });
  // Subqueries in SET values / WHERE are read + scoped too.
  for (const sub of findSubquerySelects([stmt.set, stmt.where])) {
    emitSelectReads(sub, [], [], database, out);
    emitSelectScopes(sub, database, out);
  }
  out.scopeUnits.push({ kind: "scope", tables: bases, predicates: collectPredicates(stmt.where) });
}

// DELETE. The delete target(s) are named in `table[]` (by real name for a
// single-table delete, by alias for a multi-table one); `from[]` holds the real
// source tables. A base table is a write target iff its name/alias is a delete
// target; the rest are reads. All base tables are scoped.
function handleDelete(stmt: Obj, database: string | null, out: Out): void {
  collectRelnames(stmt, out);
  const fromArr = Array.isArray(stmt.from) ? stmt.from : stmt.table;
  const bases = tableRefArray(fromArr, database);
  const targetNames = new Set<string>();
  for (const t of tableRefArray(stmt.table, database)) {
    targetNames.add(t.relname);
    if (t.alias) targetNames.add(t.alias);
  }

  const isTarget = (t: TableRef): boolean =>
    targetNames.has(t.relname) || targetNames.has(t.effectiveName);

  bases.forEach((t) => {
    if (isTarget(t)) out.accessChecks.push({ kind: "write", ref: t });
  });
  for (const t of bases) out.accessChecks.push({ kind: "read", ref: t });
  for (const sub of findSubquerySelects(stmt.where)) {
    emitSelectReads(sub, [], [], database, out);
    emitSelectScopes(sub, database, out);
  }
  out.scopeUnits.push({ kind: "scope", tables: bases, predicates: collectPredicates(stmt.where) });
}

// DROP / TRUNCATE: every named table is a write target. No WHERE → no scope unit
// (a scoped table can't carry a predicate here, so tenant_scope can't apply; the
// write check is what denies under default-deny).
function handleDropTruncate(stmt: Obj, database: string | null, out: Out): void {
  collectRelnames(stmt, out);
  const targets = tableRefArray(stmt.name, database);
  if (targets.length === 0) {
    out.accessChecks.push({ kind: "no_target", keyword: (asString(stmt.type) ?? "").toUpperCase() });
    return;
  }
  for (const t of targets) out.accessChecks.push({ kind: "write", ref: t });
}

// CREATE TABLE/INDEX/VIEW/…: the created/owning table is a write target. CREATE
// INDEX exposes `table` as a single object (not an array); CREATE … AS SELECT
// also reads its source. Forms with no table target (CREATE DATABASE/FUNCTION/…)
// → no_target deny.
function handleCreate(stmt: Obj, database: string | null, out: Out): void {
  collectRelnames(stmt, out);
  const targets = tableRefArray(stmt.table, database);
  if (targets.length === 0) {
    out.accessChecks.push({ kind: "no_target", keyword: "CREATE" });
    return;
  }
  for (const t of targets) out.accessChecks.push({ kind: "write", ref: t });
  // CREATE TABLE AS SELECT / CREATE VIEW AS SELECT — the query source is a read.
  const q = stmt.query_expr ?? stmt.as ?? stmt.query;
  if (isObj(q) && q.type === "select") {
    emitSelectReads(q, [], [], database, out);
    emitSelectScopes(q, database, out);
  }
}

// ALTER / RENAME: the target table is a write.
function handleAlterRename(stmt: Obj, database: string | null, out: Out): void {
  collectRelnames(stmt, out);
  const targets = tableRefArray(stmt.table, database);
  if (targets.length === 0) {
    out.accessChecks.push({ kind: "no_target", keyword: (asString(stmt.type) ?? "").toUpperCase() });
    return;
  }
  for (const t of targets) out.accessChecks.push({ kind: "write", ref: t });
}

// Normalize a `table` / `from` / `name` slot (array OR single object) into
// TableRefs, skipping FROM-subquery entries.
function tableRefArray(slot: unknown, database: string | null): TableRef[] {
  const entries = Array.isArray(slot) ? slot : slot === undefined || slot === null ? [] : [slot];
  const out: TableRef[] = [];
  for (const e of entries) {
    const ref = toTableRef(e, database);
    if (ref) out.push(ref);
  }
  return out;
}
