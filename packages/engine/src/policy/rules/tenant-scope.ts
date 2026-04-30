// tenant_scope rule (V1: conservative semantics, opt-in).
//
// "Deny if a mapped table appears anywhere without a literal
//  `WHERE column = context.tenant_id` predicate at the same scope, where
//   the predicate's qualifier resolves to that exact table."
//
// Same scope = the immediately enclosing SelectStmt (including UNION arms,
// CTE bodies, subqueries — each is its own SelectStmt). Predicates extracted
// only through AND_EXPR conjunctions; OR/NOT do NOT propagate.
//
// Qualifier resolution: a predicate `u.org_id = 42` only counts for the
// table whose effective name (alias if set, otherwise relname) is `u`.
// An UNQUALIFIED predicate `org_id = 42` counts only when there's a
// single mapped table at this scope; multi-mapped-table SELECTs require
// qualified predicates on each. This closes the cross-table bypass where
// `u.org_id = 42` appeared to satisfy every mapped org_id table.
//
// Conservative tradeoff: false positives (legitimate queries denied) are
// acceptable; bypasses are not.

import type { Rule, RuleEvalContext, RuleVerdict } from "./index.ts";
import { PolicyRule } from "../../audit/types.ts";

type Predicate = { qualifier: string | null; column: string; literal: string };
type MappedTable = { effectiveName: string; relname: string };

interface ScopeFailure {
  table: string;
  column: string;
}

export function tenantScope(): Rule {
  return {
    name: PolicyRule.TENANT_SCOPE_MISSING,
    reset() {},
    finalize(rctx: RuleEvalContext): RuleVerdict {
      if (!rctx.parse.ok) return { decision: "ALLOW" };
      const mappings = rctx.ctx.tenant_scope?.mappings;
      if (!mappings || Object.keys(mappings).length === 0) {
        return { decision: "ALLOW" };
      }
      let firstFailure: ScopeFailure | null = null;
      visitForTenantScope(
        rctx.parse.ast.stmts,
        mappings,
        rctx.ctx.tenant_id,
        (failure) => {
          if (firstFailure === null) firstFailure = failure;
        },
      );
      if (firstFailure === null) return { decision: "ALLOW" };
      const f = firstFailure as ScopeFailure;
      return {
        decision: "DENY",
        reason: PolicyRule.TENANT_SCOPE_MISSING,
        message:
          `Midplane denied this query because table \`${f.table}\` is in the ` +
          `tenant_scope mapping but the query is missing a literal ` +
          `\`WHERE ${f.column} = <tenant_id>\` predicate at the same ` +
          `SELECT scope. Add \`${f.column} = <tenant_id>\` (joined by AND, ` +
          `not OR) at every reference, including inside subqueries, CTEs, ` +
          `and UNION arms.`,
      };
    },
  };
}

function visitForTenantScope(
  stmts: Array<{ stmt: Record<string, unknown> }>,
  mappings: Record<string, string>,
  tenantId: string,
  flagDeny: (failure: ScopeFailure) => void,
): void {
  const checkSelectStmt = (selectStmt: Record<string, unknown>): void => {
    const tables = collectMappedRangeVarsInFrom(selectStmt.fromClause, mappings);
    if (tables.length === 0) return;

    const predicates = collectPredicates(selectStmt.whereClause);

    for (const table of tables) {
      const tenantCol = mappings[table.relname]!;
      const matched = predicates.some((p) => {
        if (p.column !== tenantCol) return false;
        if (p.literal !== tenantId) return false;
        if (p.qualifier !== null) {
          return p.qualifier === table.effectiveName;
        }
        // Unqualified predicates only count when there's exactly one mapped
        // table at this scope — otherwise the predicate is ambiguous.
        return tables.length === 1;
      });
      if (!matched) {
        flagDeny({ table: table.relname, column: tenantCol });
        return;
      }
    }
  };

  // Walk the parse tree recursively, calling checkSelectStmt at each
  // SelectStmt scope (including UNION arms, CTE bodies, subqueries) and
  // flagging mapped DML targets directly.
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
      if (inner !== null && typeof inner === "object" && !Array.isArray(inner) && /^[A-Z]/.test(kind)) {
        const innerObj = inner as Record<string, unknown>;
        if (kind === "SelectStmt") {
          checkSelectStmt(innerObj);
          walkSelectStmtChildren(innerObj);
          return;
        }
        if (kind === "InsertStmt" || kind === "UpdateStmt" || kind === "DeleteStmt" || kind === "MergeStmt") {
          // DML target relation is a bare RangeVar-shaped object. If it's
          // mapped, deny — writes are blocked elsewhere by table_access
          // (default deny when no YAML), so this only fires when
          // tenant_scope is used standalone or the target is read_write.
          const relation = innerObj.relation as Record<string, unknown> | undefined;
          const relname = relation?.relname as string | undefined;
          if (relname && mappings[relname]) {
            flagDeny({ table: relname, column: mappings[relname]! });
          }
          for (const k of Object.keys(innerObj)) walk(innerObj[k]);
          return;
        }
        for (const k of Object.keys(innerObj)) walk(innerObj[k]);
        return;
      }
    }

    for (const k of keys) walk(obj[k]);
  };

  // SelectStmt's larg/rarg are bare SelectStmt-shaped objects (UNION etc.)
  // and must be treated as full SelectStmt scopes for the per-arm check.
  const walkSelectStmtChildren = (selectStmt: Record<string, unknown>): void => {
    for (const k of Object.keys(selectStmt)) {
      const v = selectStmt[k];
      if ((k === "larg" || k === "rarg") && v && typeof v === "object" && !Array.isArray(v)) {
        const arm = v as Record<string, unknown>;
        checkSelectStmt(arm);
        walkSelectStmtChildren(arm);
      } else {
        walk(v);
      }
    }
  };

  for (const stmtWrapper of stmts) {
    walk(stmtWrapper.stmt);
  }
}

// Walk a SelectStmt's fromClause to collect mapped RangeVars with their
// effective name (alias.aliasname if set, else relname). Skips
// RangeSubselects (their inner SelectStmt is its own scope).
function collectMappedRangeVarsInFrom(
  fromClause: unknown,
  mappings: Record<string, string>,
): MappedTable[] {
  const out: MappedTable[] = [];
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
      const relname = rangeVar.relname as string | undefined;
      if (relname && mappings[relname]) {
        const alias = (rangeVar.alias as Record<string, unknown> | undefined)?.aliasname as
          | string
          | undefined;
        out.push({ effectiveName: alias ?? relname, relname });
      }
      return;
    }

    const joinExpr = obj.JoinExpr as Record<string, unknown> | undefined;
    if (joinExpr) {
      visit(joinExpr.larg);
      visit(joinExpr.rarg);
      return;
    }

    // RangeSubselect / RangeFunction / RangeTableSample: opaque at this
    // scope — their interior tables are checked when the inner SelectStmt
    // is visited (or are not mapped at all).
    if (obj.RangeSubselect || obj.RangeFunction || obj.RangeTableSample) return;
  };
  visit(fromClause);
  return out;
}

// Collect equality predicates from a WHERE clause, recursing only through
// AND. OR/NOT do not strengthen the constraint and are excluded.
function collectPredicates(whereClause: unknown): Predicate[] {
  const out: Predicate[] = [];
  const recurse = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;

    const aExpr = obj.A_Expr as Record<string, unknown> | undefined;
    if (aExpr && aExpr.kind === "AEXPR_OP" && nameIsEquals(aExpr.name)) {
      const lcol = extractColumnRef(aExpr.lexpr);
      const rlit = extractConstLiteral(aExpr.rexpr);
      if (lcol && rlit !== null) out.push({ ...lcol, literal: rlit });
      // Reversed: `literal = column`
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

function nameIsEquals(name: unknown): boolean {
  if (!Array.isArray(name)) return false;
  const last = name[name.length - 1] as Record<string, unknown> | undefined;
  if (!last) return false;
  const s = last.String as Record<string, unknown> | undefined;
  return s?.sval === "=";
}

// Extracts `{ qualifier, column }` from a ColumnRef — qualifier is the
// table alias / relname when the column is qualified (`u.org_id`), null
// when unqualified (`org_id`). Returns null if the node is not a usable
// ColumnRef.
function extractColumnRef(node: unknown): { qualifier: string | null; column: string } | null {
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
  // Two or more fields: take the last as column, the second-to-last as
  // the qualifier (could be table alias or schema-qualified — V1 keeps
  // it simple and uses the immediate qualifier).
  const col = stringAt(fields.length - 1);
  const qual = stringAt(fields.length - 2);
  if (!col || !qual) return null;
  return { qualifier: qual, column: col };
}

function extractConstLiteral(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const aConst = (node as Record<string, unknown>).A_Const as Record<string, unknown> | undefined;
  if (!aConst) return null;
  const ival = aConst.ival as Record<string, unknown> | undefined;
  if (ival && typeof ival.ival === "number") return String(ival.ival);
  const sval = aConst.sval as Record<string, unknown> | undefined;
  if (sval && typeof sval.sval === "string") return sval.sval as string;
  const fval = aConst.fval as Record<string, unknown> | undefined;
  if (fval && typeof fval.fval === "string") return fval.fval as string;
  return null;
}
