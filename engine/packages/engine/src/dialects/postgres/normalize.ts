// Postgres → normalized IR adapter.
//
// This is the ONLY file in the engine that may name libpg_query AST nodes
// after the IR cut-over. It externalizes what the two rule walkers (and the
// audit accumulator) used to compute inline, emitting the dialect-agnostic IR
// the rules now consume. The logic is a faithful relocation of the walkers
// from policy/rules/table-access.ts and policy/rules/tenant-scope.ts — same
// helpers, same traversal order — so verdicts stay byte-identical. The
// verdict-equivalence harness proves it over the whole corpus.
//
// Three independent passes, mirroring the three legacy traversals:
//   1. table_access  → AccessCheck[]   (DFS order; first failure = the cause)
//   2. tenant_scope   → ScopeUnit[]     (recursion order; per-node checks)
//   3. accumulator    → allRelnames + auditStatementType (the shared visitor walk)
// libpg_query is the real Postgres parser, so nothing is `unsupported` here.

import type { PgParseTree } from "./parse.ts";
import { walk as visitorWalk } from "./visitor.ts";
import type {
  AccessCheck,
  DangerousStatement,
  EqualityPredicate,
  InsertShape,
  NormalizedProgram,
  ScopeUnit,
  TableRef,
} from "../../ir/types.ts";

export function normalize(ast: unknown): NormalizedProgram {
  const tree = ast as PgParseTree;
  const stmts = Array.isArray(tree?.stmts) ? tree.stmts : [];
  const { allRelnames, auditStatementType } = collectAccumulator(tree);
  return {
    statementCount: stmts.length,
    auditStatementType,
    allRelnames,
    accessChecks: collectAccessChecks(stmts),
    scopeUnits: collectScopeUnits(stmts),
    dangerousStatements: collectDangerousStatements(stmts),
    unsupported: [], // libpg_query faithfully parses everything it accepts
  };
}

// ── shared low-level extractors (relocated verbatim) ───────────────────────

interface BareRef {
  schema: string | null;
  relname: string;
}

function rangeVarToBareRef(rv: Record<string, unknown>): BareRef | null {
  const relname = rv.relname;
  if (typeof relname !== "string" || relname.length === 0) return null;
  const schemaname = rv.schemaname;
  return {
    schema:
      typeof schemaname === "string" && schemaname.length > 0 ? schemaname : null,
    relname,
  };
}

// Full TableRef including effectiveName/alias (tenant_scope needs them for
// predicate-qualifier matching; table_access ignores them).
function rangeVarToTableRef(rv: Record<string, unknown>): TableRef | null {
  const bare = rangeVarToBareRef(rv);
  if (!bare) return null;
  const alias = (rv.alias as Record<string, unknown> | undefined)?.aliasname as
    | string
    | undefined;
  return {
    schema: bare.schema,
    relname: bare.relname,
    effectiveName: alias ?? bare.relname,
    alias: alias ?? null,
  };
}

function bareToTableRef(b: BareRef): TableRef {
  return { schema: b.schema, relname: b.relname, effectiveName: b.relname, alias: null };
}

// ── 1. table_access → AccessCheck[] (port of table-access.ts visitForTableAccess) ──

const WRITE_STATEMENT_KINDS = new Set([
  "InsertStmt",
  "UpdateStmt",
  "DeleteStmt",
  "MergeStmt",
  "DropStmt",
  "TruncateStmt",
  "AlterTableStmt",
  "AlterDomainStmt",
  "GrantStmt",
  "GrantRoleStmt",
  "RevokeStmt",
  "CreateStmt",
  "CreateTableAsStmt",
  "CreateSchemaStmt",
  "CreateRoleStmt",
  "CreateFunctionStmt",
  "CreatedbStmt",
  "ExecuteStmt",
  "CallStmt",
  "CopyStmt",
  "DoStmt",
  "ViewStmt",
  "IndexStmt",
  "RuleStmt",
  "RefreshMatViewStmt",
  "NotifyStmt",
  "ListenStmt",
  "UnlistenStmt",
  "LockStmt",
  "VariableSetStmt",
]);

// Every ALTER form libpg_query models. Most are their own `Alter…Stmt` node
// kind (AlterTableStmt, AlterEnumStmt = `ALTER TYPE … ADD VALUE`, AlterRoleStmt,
// AlterObjectSchemaStmt = `ALTER … SET SCHEMA`, …); `ALTER … RENAME` is the
// outlier modeled as `RenameStmt`. Matched as a family so both the table_access
// classifier and the dangerous_statement guardrail cover the whole `ALTER`
// surface — fail closed rather than enumerate a list that drifts as PG grows.
function isAlterKind(kind: string): boolean {
  return /^Alter[A-Za-z]+Stmt$/.test(kind) || kind === "RenameStmt";
}

// Human keyword for an ALTER-family node, for deny messages. A few get a clean
// SQL-shaped label; the rest derive `ALTER <X>` from the node name
// (AlterRoleStmt → "ALTER ROLE", AlterTableMoveAllStmt → "ALTER TABLE MOVE ALL").
function alterKeyword(kind: string): string {
  switch (kind) {
    case "RenameStmt":
      return "ALTER … RENAME";
    case "AlterObjectSchemaStmt":
      return "ALTER … SET SCHEMA";
    case "AlterEnumStmt":
      return "ALTER TYPE";
    default: {
      const body = kind.replace(/^Alter/, "").replace(/Stmt$/, "");
      return body
        ? `ALTER ${body.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toUpperCase()}`
        : "ALTER";
    }
  }
}

function humanStatement(kind: string): string {
  switch (kind) {
    case "GrantRoleStmt":
      return "GRANT ROLE";
    case "CreateSchemaStmt":
      return "CREATE SCHEMA";
    case "CreateRoleStmt":
      return "CREATE ROLE";
    case "CreatedbStmt":
      return "CREATE DATABASE";
    case "CreateFunctionStmt":
      return "CREATE FUNCTION";
    case "VariableSetStmt":
      return "SET";
    default:
      // ALTER family (incl. AlterDomainStmt, AlterEnumStmt, RenameStmt, …) →
      // a readable `ALTER …` keyword for the no_target message.
      if (isAlterKind(kind)) return alterKeyword(kind);
      return kind.replace(/Stmt$/, "").toUpperCase();
  }
}

// A WITH scope: the CTE names it defines + whether it's RECURSIVE. `recursive`
// decides whether a CTE's own name binds inside its own body (it does for
// RECURSIVE — that's the recursion; it does NOT for a plain WITH).
interface CteScope {
  names: Set<string>;
  recursive: boolean;
}

function collectCteNames(node: Record<string, unknown>): CteScope | null {
  const wc = node.withClause as Record<string, unknown> | undefined;
  const ctes = wc?.ctes;
  if (!Array.isArray(ctes)) return null;
  const names = new Set<string>();
  for (const entry of ctes) {
    const cte = (entry as Record<string, unknown>)?.CommonTableExpr as
      | Record<string, unknown>
      | undefined;
    const name = cte?.ctename;
    if (typeof name === "string" && name.length > 0) names.add(name);
  }
  return names.size > 0 ? { names, recursive: wc?.recursive === true } : null;
}

function extractWriteTargets(kind: string, node: Record<string, unknown>): BareRef[] {
  switch (kind) {
    case "InsertStmt":
    case "UpdateStmt":
    case "DeleteStmt":
    case "MergeStmt":
    case "AlterTableStmt":
    case "CreateStmt":
    case "IndexStmt":
    case "RuleStmt":
    case "RefreshMatViewStmt":
    // `ALTER … RENAME` / `ALTER … SET SCHEMA` on a TABLE carry the target in
    // `relation` (so it's checked as a write on that table, like ADD COLUMN);
    // the same node on a non-table object (type, function, …) has no `relation`
    // and falls through to `[]` → no_target → deny.
    case "RenameStmt":
    case "AlterObjectSchemaStmt":
      return refsFromRelation(node.relation);
    case "TruncateStmt":
      return refsFromList(node.relations);
    case "ViewStmt":
      return refsFromRelation(node.view);
    case "CreateTableAsStmt": {
      const into = node.into as Record<string, unknown> | undefined;
      return refsFromRelation(into?.rel);
    }
    case "DropStmt":
      return refsFromObjectsList(node.objects);
    case "GrantStmt":
    case "RevokeStmt":
      return refsFromList(node.objects);
    default:
      return [];
  }
}

function refsFromRelation(rel: unknown): BareRef[] {
  if (!rel || typeof rel !== "object" || Array.isArray(rel)) return [];
  const ref = rangeVarToBareRef(rel as Record<string, unknown>);
  return ref ? [ref] : [];
}

function refsFromList(list: unknown): BareRef[] {
  if (!Array.isArray(list)) return [];
  const out: BareRef[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rangeVar = (item as Record<string, unknown>).RangeVar as
      | Record<string, unknown>
      | undefined;
    if (!rangeVar) continue;
    const ref = rangeVarToBareRef(rangeVar);
    if (ref) out.push(ref);
  }
  return out;
}

function refsFromObjectsList(objects: unknown): BareRef[] {
  if (!Array.isArray(objects)) return [];
  const out: BareRef[] = [];
  for (const entry of objects) {
    const items = (entry as Record<string, unknown>)?.List as
      | Record<string, unknown>
      | undefined;
    const itemList = items?.items;
    if (!Array.isArray(itemList)) continue;
    const parts: string[] = [];
    for (const part of itemList) {
      const s = (part as Record<string, unknown>)?.String as
        | Record<string, unknown>
        | undefined;
      if (typeof s?.sval === "string") parts.push(s.sval as string);
    }
    if (parts.length === 1) {
      out.push({ schema: null, relname: parts[0]! });
    } else if (parts.length >= 2) {
      out.push({ schema: parts[parts.length - 2]!, relname: parts[parts.length - 1]! });
    }
  }
  return out;
}

function collectAccessChecks(
  stmts: Array<{ stmt: Record<string, unknown> }>,
): AccessCheck[] {
  const checks: AccessCheck[] = [];
  const cteScopes: CteScope[] = [];
  // Names of CTEs whose own body we are currently inside (non-recursive only).
  // A plain CTE's name does NOT bind in its own definition, so a body reference
  // to a real table that happens to share the CTE name is a REAL read and must
  // be checked — not silently skipped as a CTE reference (the self-shadow
  // bypass). Recursive CTEs keep their name bound in the body (the recursion).
  const definingStack: string[] = [];
  const isCteReference = (ref: BareRef): boolean => {
    if (ref.schema !== null) return false;
    if (definingStack.includes(ref.relname)) return false;
    for (const scope of cteScopes) if (scope.names.has(ref.relname)) return true;
    return false;
  };

  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== "object") return;

    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);

    if (keys.length === 1) {
      const kind = keys[0]!;
      const inner = obj[kind];
      const isTaggedUnion =
        inner !== null &&
        typeof inner === "object" &&
        !Array.isArray(inner) &&
        /^[A-Z]/.test(kind);
      if (isTaggedUnion) {
        const innerObj = inner as Record<string, unknown>;
        if (kind === "RangeVar") {
          const ref = rangeVarToBareRef(innerObj);
          if (ref && !isCteReference(ref)) {
            checks.push({ kind: "read", ref: bareToTableRef(ref) });
          }
          return; // RangeVar leaves have no nested tables of interest
        }
        if (kind === "CommonTableExpr") {
          // Walk the CTE body with its own name excluded from the CTE-reference
          // set (non-recursive scoping) so a real-table read inside it isn't
          // mistaken for the CTE itself. The enclosing WITH scope is the top of
          // cteScopes (just pushed by the parent stmt); RECURSIVE leaves the
          // exclusion off so a self-reference stays a CTE ref (the recursion).
          // Walk order is otherwise unchanged — only the ctequery sub-walk is
          // wrapped — so non-shadowing cases keep identical check sequences.
          const ctename =
            typeof innerObj.ctename === "string" ? (innerObj.ctename as string) : null;
          const enclosing = cteScopes[cteScopes.length - 1];
          const excludeSelf = ctename !== null && enclosing !== undefined && !enclosing.recursive;
          for (const k of Object.keys(innerObj)) {
            if (k === "ctequery" && excludeSelf) {
              definingStack.push(ctename!);
              walk(innerObj[k]);
              definingStack.pop();
            } else {
              walk(innerObj[k]);
            }
          }
          return;
        }
        const cteNames = collectCteNames(innerObj);
        if (cteNames) cteScopes.push(cteNames);
        // The whole ALTER family counts as a write/side-effect, not just the
        // two kinds in WRITE_STATEMENT_KINDS — otherwise `ALTER … RENAME`,
        // `ALTER TYPE … ADD VALUE`, etc. would fall through to a bare read
        // check and a `read` table could be renamed/altered when block_ddl is
        // off. Relation-bearing ALTERs check their target table; the rest emit
        // no_target (deny regardless of policy), matching DROP-on-non-table.
        if (WRITE_STATEMENT_KINDS.has(kind) || isAlterKind(kind)) {
          const targets = extractWriteTargets(kind, innerObj);
          if (targets.length === 0) {
            checks.push({ kind: "no_target", keyword: humanStatement(kind) });
          } else {
            for (const t of targets) {
              if (!isCteReference(t)) checks.push({ kind: "write", ref: bareToTableRef(t) });
            }
          }
        }
        // `SELECT … INTO new_table` is the legacy spelling of CREATE TABLE AS:
        // libpg models it as a SelectStmt carrying a non-null `intoClause` (the
        // new relation), NOT a CreateTableAsStmt. Without this, the creation
        // target is walked as a plain RangeVar `read` and a `default: read`
        // policy ALLOWS it — letting a read-only agent materialize a table
        // (snapshot a table it can read, or fill disk). Emit a `write` check on
        // the target so it is governed exactly like CreateTableAsStmt's
        // `into.rel`: denied unless the target is read_write, and denied by a
        // read-only scope ceiling. (block_ddl deliberately does not cover table
        // creation in v1 — same as CREATE TABLE AS — so table_access is the
        // control surface here.)
        if (kind === "SelectStmt" && innerObj.intoClause) {
          const into = innerObj.intoClause as Record<string, unknown>;
          for (const t of refsFromRelation(into.rel)) {
            if (!isCteReference(t)) checks.push({ kind: "write", ref: bareToTableRef(t) });
          }
        }
        for (const k of Object.keys(innerObj)) walk(innerObj[k]);
        if (cteNames) cteScopes.pop();
        return;
      }
    }

    for (const k of keys) walk(obj[k]);
  };

  for (const s of stmts) walk(s.stmt);
  return checks;
}

// ── 2. tenant_scope → ScopeUnit[] (port of tenant-scope.ts visitForTenantScope) ──

function nameIsEquals(name: unknown): boolean {
  if (!Array.isArray(name)) return false;
  const last = name[name.length - 1] as Record<string, unknown> | undefined;
  if (!last) return false;
  const s = last.String as Record<string, unknown> | undefined;
  return s?.sval === "=";
}

function extractColumnRef(
  node: unknown,
): { qualifier: string | null; column: string } | null {
  if (!node || typeof node !== "object") return null;
  const colRef = (node as Record<string, unknown>).ColumnRef as
    | Record<string, unknown>
    | undefined;
  if (!colRef) return null;
  const fields = colRef.fields as unknown[] | undefined;
  if (!fields || fields.length === 0) return null;
  const stringAt = (i: number): string | null => {
    const entry = fields[i] as Record<string, unknown> | undefined;
    if (!entry) return null;
    const s = entry.String as Record<string, unknown> | undefined;
    return typeof s?.sval === "string" ? (s.sval as string) : null;
  };
  if (fields.length === 1) {
    const col = stringAt(0);
    return col ? { qualifier: null, column: col } : null;
  }
  const col = stringAt(fields.length - 1);
  const qual = stringAt(fields.length - 2);
  if (!col || !qual) return null;
  return { qualifier: qual, column: col };
}

function extractConstLiteral(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const aConst = (node as Record<string, unknown>).A_Const as
    | Record<string, unknown>
    | undefined;
  if (!aConst) return null;
  const ival = aConst.ival as Record<string, unknown> | undefined;
  if (ival && typeof ival.ival === "number") return String(ival.ival);
  const sval = aConst.sval as Record<string, unknown> | undefined;
  if (sval && typeof sval.sval === "string") return sval.sval as string;
  const fval = aConst.fval as Record<string, unknown> | undefined;
  if (fval && typeof fval.fval === "string") return fval.fval as string;
  return null;
}

function collectPredicates(whereClause: unknown): EqualityPredicate[] {
  const out: EqualityPredicate[] = [];
  const recurse = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const aExpr = obj.A_Expr as Record<string, unknown> | undefined;
    if (aExpr && aExpr.kind === "AEXPR_OP" && nameIsEquals(aExpr.name)) {
      const lcol = extractColumnRef(aExpr.lexpr);
      const rlit = extractConstLiteral(aExpr.rexpr);
      if (lcol && rlit !== null) out.push({ ...lcol, literal: rlit });
      const rcol = extractColumnRef(aExpr.rexpr);
      const llit = extractConstLiteral(aExpr.lexpr);
      if (rcol && llit !== null) out.push({ ...rcol, literal: llit });
      return;
    }
    const boolExpr = obj.BoolExpr as Record<string, unknown> | undefined;
    if (boolExpr && boolExpr.boolop === "AND_EXPR") {
      const args = boolExpr.args as unknown[] | undefined;
      if (args) for (const a of args) recurse(a);
    }
  };
  recurse(whereClause);
  return out;
}

// Base tables visible AT a scope (skips subselects — their interior is its own
// scope). UNFILTERED by config: emits every base RangeVar (incl. information_schema
// and unmapped); the rule applies requiredColumnFor + the info_schema carve-out.
function collectBaseTablesInFrom(fromClause: unknown): TableRef[] {
  const out: TableRef[] = [];
  const visit = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const rangeVar = obj.RangeVar as Record<string, unknown> | undefined;
    if (rangeVar) {
      const ref = rangeVarToTableRef(rangeVar);
      if (ref) out.push(ref);
      return;
    }
    const joinExpr = obj.JoinExpr as Record<string, unknown> | undefined;
    if (joinExpr) {
      visit(joinExpr.larg);
      visit(joinExpr.rarg);
      return;
    }
    if (obj.RangeSubselect || obj.RangeFunction || obj.RangeTableSample) return;
  };
  visit(fromClause);
  return out;
}

function extractInsertShape(stmt: Record<string, unknown>): InsertShape | null {
  const target =
    stmt.relation && typeof stmt.relation === "object"
      ? rangeVarToTableRef(stmt.relation as Record<string, unknown>)
      : null;
  if (!target) return null;

  const cols = stmt.cols as unknown[] | undefined;
  const hasExplicitColumns = Array.isArray(cols) && cols.length > 0;
  const columns: string[] = [];
  if (hasExplicitColumns) {
    for (const entry of cols as unknown[]) {
      const resTarget = (entry as Record<string, unknown> | undefined)?.ResTarget as
        | Record<string, unknown>
        | undefined;
      columns.push(typeof resTarget?.name === "string" ? (resTarget.name as string) : "");
    }
  }

  const selectWrapper = stmt.selectStmt as Record<string, unknown> | undefined;
  const inner = selectWrapper?.SelectStmt as Record<string, unknown> | undefined;
  const valuesLists = inner?.valuesLists as unknown[] | undefined;
  let valuesRows: (string | null)[][] | null = null;
  if (Array.isArray(valuesLists) && valuesLists.length > 0) {
    valuesRows = [];
    for (const row of valuesLists) {
      const list = (row as Record<string, unknown>).List as
        | Record<string, unknown>
        | undefined;
      const items = (list?.items as unknown[] | undefined) ?? [];
      valuesRows.push(items.map((it) => extractConstLiteral(it)));
    }
  }

  const onConflict = stmt.onConflictClause as Record<string, unknown> | undefined;
  const onConflictDoUpdate = onConflict?.action === "ONCONFLICT_UPDATE";

  return { target, hasExplicitColumns, columns, valuesRows, onConflictDoUpdate };
}

function collectScopeUnits(
  stmts: Array<{ stmt: Record<string, unknown> }>,
): ScopeUnit[] {
  const units: ScopeUnit[] = [];

  const emitSelect = (selectStmt: Record<string, unknown>): void => {
    units.push({
      kind: "scope",
      tables: collectBaseTablesInFrom(selectStmt.fromClause),
      predicates: collectPredicates(selectStmt.whereClause),
    });
  };

  const emitUpdateOrDelete = (stmt: Record<string, unknown>): void => {
    const tables: TableRef[] = [];
    const target = stmt.relation as Record<string, unknown> | undefined;
    if (target) {
      const t = rangeVarToTableRef(target);
      if (t) tables.push(t);
    }
    const aux = stmt.fromClause ?? stmt.usingClause;
    for (const t of collectBaseTablesInFrom(aux)) tables.push(t);
    units.push({ kind: "scope", tables, predicates: collectPredicates(stmt.whereClause) });
  };

  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);

    if (keys.length === 1) {
      const kind = keys[0]!;
      const inner = obj[kind];
      if (
        inner !== null &&
        typeof inner === "object" &&
        !Array.isArray(inner) &&
        /^[A-Z]/.test(kind)
      ) {
        const innerObj = inner as Record<string, unknown>;
        if (kind === "SelectStmt") {
          emitSelect(innerObj);
          walkSelectStmtChildren(innerObj);
          return;
        }
        if (kind === "UpdateStmt" || kind === "DeleteStmt") {
          emitUpdateOrDelete(innerObj);
          for (const k of Object.keys(innerObj)) walk(innerObj[k]);
          return;
        }
        if (kind === "InsertStmt") {
          const shape = extractInsertShape(innerObj);
          if (shape) units.push({ kind: "insert", shape });
          for (const k of Object.keys(innerObj)) walk(innerObj[k]);
          return;
        }
        if (kind === "MergeStmt") {
          const target = innerObj.relation as Record<string, unknown> | undefined;
          const ref = target ? rangeVarToTableRef(target) : null;
          if (ref) units.push({ kind: "merge", target: ref });
          for (const k of Object.keys(innerObj)) walk(innerObj[k]);
          return;
        }
        for (const k of Object.keys(innerObj)) walk(innerObj[k]);
        return;
      }
    }

    for (const k of keys) walk(obj[k]);
  };

  const walkSelectStmtChildren = (selectStmt: Record<string, unknown>): void => {
    for (const k of Object.keys(selectStmt)) {
      const v = selectStmt[k];
      if ((k === "larg" || k === "rarg") && v && typeof v === "object" && !Array.isArray(v)) {
        const arm = v as Record<string, unknown>;
        emitSelect(arm);
        walkSelectStmtChildren(arm);
      } else {
        walk(v);
      }
    }
  };

  for (const s of stmts) walk(s.stmt);
  return units;
}

// ── dangerous_statement → DangerousStatement[] (destructive-op guardrails) ──

// The DDL the `block_ddl` guardrail covers: DROP, TRUNCATE, and the WHOLE ALTER
// family (every `Alter…Stmt` node plus `RenameStmt` — see isAlterKind), so the
// "DROP / TRUNCATE / ALTER" contract has no gaps as Postgres adds ALTER forms
// (`ALTER TYPE … ADD VALUE`, `ALTER ROLE …`, etc.). CREATE is deliberately
// excluded in v1. The operation label comes from dropLabel / alterKeyword and
// is for the deny message only — the deny decision does not depend on it.
function ddlOperation(kind: string, node: Record<string, unknown>): string | null {
  if (kind === "DropStmt") return dropLabel(node);
  if (kind === "TruncateStmt") return "TRUNCATE";
  if (isAlterKind(kind)) return alterKeyword(kind);
  return null;
}

// "OBJECT_TABLE" → "DROP TABLE"; falls back to a bare "DROP" when removeType is
// missing or unrecognized. The label is for the operator-facing message only —
// the deny decision does not depend on it.
function dropLabel(node: Record<string, unknown>): string {
  const t = node.removeType;
  if (typeof t === "string" && t.startsWith("OBJECT_")) {
    return `DROP ${t.slice("OBJECT_".length).replace(/_/g, " ")}`;
  }
  return "DROP";
}

// The display name of a DELETE/UPDATE target (schema-qualified when written so),
// for the unqualified-DML message. Falls back to "the target table" when the
// relation can't be read (shouldn't happen for a parsed DELETE/UPDATE).
function dmlTargetName(node: Record<string, unknown>): string {
  const rel = node.relation;
  if (rel && typeof rel === "object" && !Array.isArray(rel)) {
    const ref = rangeVarToBareRef(rel as Record<string, unknown>);
    if (ref) return ref.schema !== null ? `${ref.schema}.${ref.relname}` : ref.relname;
  }
  return "the target table";
}

// Walk every statement node (top-level AND nested) and flag the destructive
// sites the guardrails block: DELETE/UPDATE with no WHERE clause, and
// DROP/TRUNCATE/ALTER DDL. The walk descends into children of flagged nodes too,
// so a no-WHERE DELETE hidden in a CTE (`WITH d AS (DELETE FROM t RETURNING *)
// …`) is caught — it wipes the table just the same. Emitted in DFS order; the
// rule denies on the first match for whichever guardrail is enabled.
function collectDangerousStatements(
  stmts: Array<{ stmt: Record<string, unknown> }>,
): DangerousStatement[] {
  const out: DangerousStatement[] = [];

  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);

    if (keys.length === 1) {
      const kind = keys[0]!;
      const inner = obj[kind];
      if (
        inner !== null &&
        typeof inner === "object" &&
        !Array.isArray(inner) &&
        /^[A-Z]/.test(kind)
      ) {
        const innerObj = inner as Record<string, unknown>;
        if (kind === "DeleteStmt" || kind === "UpdateStmt") {
          // No `whereClause` field ⇒ no WHERE ⇒ whole-table write. A present
          // whereClause (any expression, even `WHERE true`) is "qualified" — the
          // guardrail is specifically the missing-WHERE footgun, not a predicate
          // strength check (that's tenant_scope's job).
          if (innerObj.whereClause === null || innerObj.whereClause === undefined) {
            out.push({
              kind: "unqualified_dml",
              operation: kind === "DeleteStmt" ? "DELETE" : "UPDATE",
              table: dmlTargetName(innerObj),
            });
          }
          for (const k of Object.keys(innerObj)) walk(innerObj[k]);
          return;
        }
        const op = ddlOperation(kind, innerObj);
        if (op !== null) {
          out.push({ kind: "ddl", operation: op });
          for (const k of Object.keys(innerObj)) walk(innerObj[k]);
          return;
        }
        for (const k of Object.keys(innerObj)) walk(innerObj[k]);
        return;
      }
    }

    for (const k of keys) walk(obj[k]);
  };

  for (const s of stmts) walk(s.stmt);
  return out;
}

// ── 3. accumulator → allRelnames + auditStatementType (the shared visitor walk) ──

function collectAccumulator(tree: PgParseTree): {
  allRelnames: string[];
  auditStatementType: string | null;
} {
  let auditStatementType: string | null = null;
  const relnames = new Set<string>();
  if (Array.isArray(tree?.stmts)) {
    visitorWalk(tree, [
      {
        visit(node: unknown, kind: string | null) {
          if (kind && /Stmt$/.test(kind) && auditStatementType === null) {
            auditStatementType = kind.replace(/Stmt$/, "").toUpperCase();
          }
          if (kind === "RangeVar") {
            const relname = (node as Record<string, unknown>)?.relname;
            if (typeof relname === "string") relnames.add(relname);
          }
        },
      },
    ]);
  }
  return { allRelnames: [...relnames], auditStatementType };
}
