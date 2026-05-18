// tenant_scope rule.
//
// "Deny if a scoped table appears anywhere without a literal
//  `WHERE column = context.tenant_id` predicate at the same scope, where
//   the predicate's qualifier resolves to that exact table."
//
// A table is **scoped** when the resolved TenantScopeConfig says so:
//
//   1. `exempt[table]` ⇒ never scoped (explicit opt-out).
//   2. `overrides[table]` ⇒ scoped, using that override column.
//   3. `defaultColumn` set ⇒ scoped, using the default column ("strict
//      mode": every queried table needs the predicate or an exempt entry).
//   4. Otherwise ⇒ not scoped (legacy mode: only `overrides` listed
//      tables get checked, matches pre-0.5.0 `mappings`-only semantics).
//
// Same scope = the immediately enclosing SelectStmt (including UNION arms,
// CTE bodies, subqueries — each is its own SelectStmt). Predicates extracted
// only through AND_EXPR conjunctions; OR/NOT do NOT propagate.
//
// Qualifier resolution: a predicate `u.org_id = 42` only counts for the
// table whose effective name (alias if set, otherwise relname) is `u`.
// An UNQUALIFIED predicate `org_id = 42` counts only when there's a
// single scoped table at this scope; multi-scoped-table SELECTs require
// qualified predicates on each. This closes the cross-table bypass where
// `u.org_id = 42` appeared to satisfy every scoped org_id table.
//
// DML semantics:
//   • UPDATE / DELETE — the target relation is treated as the in-scope
//     table; the statement's WHERE clause carries the predicate. Same
//     matcher as SELECT. `UPDATE t SET ... WHERE t.tenant_col = <ctx>`
//     is allowed; bare `UPDATE t SET ...` denies.
//   • INSERT … VALUES — when the column list explicitly includes the
//     tenant column, every VALUES row's literal at that position must
//     equal `ctx.tenant_id`. Without an explicit column list (or with
//     `INSERT … SELECT`), the target is conservatively denied — operators
//     who genuinely need bulk-insert against unscoped sources should
//     `exempt` the target.
//   • MERGE — conservatively denied on a scoped target. Source/match
//     conditions are structurally too varied to verify tenant-correctness
//     statically; operators must `exempt` to use MERGE on a scoped table.
//
// `information_schema` is carved out unconditionally — same as
// `table_access` (table-access.ts:447). Discovery via `list_tables` /
// `describe_table` must work under strict mode without forcing operators
// to enumerate every system table in `exempt`. `pg_catalog` is NOT
// carved out — it exposes pg_roles, pg_proc bodies, pg_settings, etc.
// which go beyond schema discovery and stay subject to policy.
//
// Conservative tradeoff: false positives (legitimate queries denied) are
// acceptable; bypasses are not.

import type { Rule, RuleEvalContext, RuleVerdict } from "./index.ts";
import { PolicyRule } from "../../audit/types.ts";

type Predicate = { qualifier: string | null; column: string; literal: string };
type ScopedTable = { effectiveName: string; relname: string; column: string };

interface ScopeFailure {
  table: string;
  column: string;
}

// Resolved configuration the rule actually evaluates against. The rule
// normalizes every accepted source shape (legacy flat record, rich config,
// ctx fallback) into this single type before walking the AST.
export interface TenantScopeConfig {
  // Universal default tenant column. When set, every queried table is
  // scoped unless `exempt` excludes it or `overrides` redirects to a
  // different column. When null, only tables listed in `overrides` get
  // checked (legacy 0.4.x `mappings`-only behavior).
  defaultColumn: string | null;
  // Per-table column overrides — `relname → column`. Takes precedence
  // over `defaultColumn` for the named table.
  overrides: Record<string, string>;
  // Tables that are intentionally not tenant-scoped (e.g. global lookup
  // tables, audit logs). Listed `relname`s skip the scoping check entirely.
  exempt: string[];
}

// Accepts:
//   - A static rich TenantScopeConfig (snapshot at construction).
//   - A static legacy flat record (table → column); equivalent to a config
//     with `defaultColumn: null`, `overrides: <record>`, `exempt: []`.
//   - A getter returning either shape on each evaluation (used by mcp-server
//     to hot-swap config without rebuilding the engine — mirrors `tableAccess`).
//   - undefined ⇒ rule reads `ctx.tenant_scope` from the per-call EngineContext
//     (back-compat with pre-source-arg test fixtures).
export type TenantScopeSource =
  | TenantScopeConfig
  | Record<string, string>
  | (() => TenantScopeConfig | Record<string, string> | undefined)
  | undefined;

export function tenantScope(source?: TenantScopeSource): Rule {
  const resolve = (rctx: RuleEvalContext): TenantScopeConfig | null => {
    let raw: TenantScopeConfig | Record<string, string> | undefined;
    if (typeof source === "function") raw = source();
    else if (source !== undefined) raw = source;
    else raw = ctxToRaw(rctx);
    return normalizeConfig(raw);
  };
  return {
    name: PolicyRule.TENANT_SCOPE_MISSING,
    reset() {},
    finalize(rctx: RuleEvalContext): RuleVerdict {
      if (!rctx.parse.ok) return { decision: "ALLOW" };
      const cfg = resolve(rctx);
      if (cfg === null) return { decision: "ALLOW" };
      let firstFailure: ScopeFailure | null = null;
      visitForTenantScope(
        rctx.parse.ast.stmts,
        cfg,
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
          `Midplane denied this query because table \`${f.table}\` is ` +
          `tenant-scoped but the query is missing the required ` +
          `\`${f.column} = <tenant_id>\` predicate. For SELECT/UPDATE/DELETE, ` +
          `add it to the WHERE clause (joined by AND, not OR) at every ` +
          `reference, including subqueries, CTEs, and UNION arms. For ` +
          `INSERT, include \`${f.column}\` in the column list and set it ` +
          `to the tenant id in every VALUES row. MERGE on tenant-scoped ` +
          `tables is not supported — \`exempt\` the table to use it. To ` +
          `exempt this table entirely, list it under \`tenant_scope.exempt\` ` +
          `in your policy YAML.`,
      };
    },
  };
}

// Resolve the required tenant column for a given bare relname per the
// strict precedence: exempt → overrides → defaultColumn. Returns null
// when the table doesn't need scoping (exempt, or legacy mode with no
// override and no default).
function requiredColumnFor(
  relname: string,
  cfg: TenantScopeConfig,
): string | null {
  if (cfg.exempt.includes(relname)) return null;
  const override = cfg.overrides[relname];
  if (override !== undefined) return override;
  return cfg.defaultColumn;
}

function ctxToRaw(
  rctx: RuleEvalContext,
): TenantScopeConfig | Record<string, string> | undefined {
  const ts = rctx.ctx.tenant_scope;
  if (!ts) return undefined;
  // Rich-shape ctx (new tests can wire defaultColumn/overrides/exempt
  // directly via context without going through a holder).
  if (
    ts.defaultColumn !== undefined ||
    ts.overrides !== undefined ||
    ts.exempt !== undefined
  ) {
    return {
      defaultColumn: ts.defaultColumn ?? null,
      overrides: ts.overrides ?? {},
      exempt: ts.exempt ?? [],
    };
  }
  // Legacy `mappings`-only ctx (pre-0.5.0 test fixtures, still supported).
  if (ts.mappings) return ts.mappings;
  return undefined;
}

// Normalize any accepted source shape into TenantScopeConfig | null.
// `null` means "nothing to enforce" — short-circuit ALLOW. A config with
// an empty overrides and null defaultColumn also normalizes to null
// (legacy "no mappings" branch).
function normalizeConfig(
  raw: TenantScopeConfig | Record<string, string> | undefined,
): TenantScopeConfig | null {
  if (raw === undefined) return null;
  let cfg: TenantScopeConfig;
  if (isRichConfig(raw)) {
    cfg = {
      defaultColumn: raw.defaultColumn ?? null,
      overrides: raw.overrides ?? {},
      exempt: raw.exempt ?? [],
    };
  } else {
    cfg = { defaultColumn: null, overrides: raw, exempt: [] };
  }
  // No default + no overrides ⇒ nothing to enforce, regardless of exempt
  // (exempt without anything to scope is a no-op).
  if (cfg.defaultColumn === null && Object.keys(cfg.overrides).length === 0) {
    return null;
  }
  return cfg;
}

function isRichConfig(
  raw: TenantScopeConfig | Record<string, string>,
): raw is TenantScopeConfig {
  return (
    "defaultColumn" in raw || "overrides" in raw || "exempt" in raw
  );
}

function visitForTenantScope(
  stmts: Array<{ stmt: Record<string, unknown> }>,
  cfg: TenantScopeConfig,
  tenantId: string,
  flagDeny: (failure: ScopeFailure) => void,
): void {
  // Shared per-scope check: given the set of scoped tables at this scope
  // and the WHERE/qualifying clause, verify every table has a literal
  // predicate matching the context tenant_id. Used by SELECT, UPDATE,
  // and DELETE (which all share the "tables at scope + WHERE clause"
  // structure).
  const checkScope = (
    tables: ScopedTable[],
    whereClause: unknown,
  ): ScopeFailure | null => {
    if (tables.length === 0) return null;
    const predicates = collectPredicates(whereClause);
    for (const table of tables) {
      const tenantCol = table.column;
      const matched = predicates.some((p) => {
        if (p.column !== tenantCol) return false;
        if (p.literal !== tenantId) return false;
        if (p.qualifier !== null) {
          return p.qualifier === table.effectiveName;
        }
        // Unqualified predicates only count when there's exactly one scoped
        // table at this scope — otherwise the predicate is ambiguous.
        return tables.length === 1;
      });
      if (!matched) return { table: table.relname, column: tenantCol };
    }
    return null;
  };

  const checkSelectStmt = (selectStmt: Record<string, unknown>): void => {
    const tables = collectScopedRangeVarsInFrom(selectStmt.fromClause, cfg);
    const failure = checkScope(tables, selectStmt.whereClause);
    if (failure) flagDeny(failure);
  };

  // UPDATE / DELETE: target relation is the in-scope table; the
  // statement's fromClause/usingClause adds any additional join sources;
  // the whereClause carries the predicate. Same matcher as SELECT.
  const checkUpdateOrDelete = (stmt: Record<string, unknown>): void => {
    const tables: ScopedTable[] = [];
    const target = stmt.relation as Record<string, unknown> | undefined;
    if (target) {
      const t = rangeVarToScopedTable(target, cfg);
      if (t) tables.push(t);
    }
    // UPDATE uses `fromClause`; DELETE uses `usingClause`. Either may
    // also be absent (single-target statement). Walk whichever is set.
    const aux = stmt.fromClause ?? stmt.usingClause;
    for (const t of collectScopedRangeVarsInFrom(aux, cfg)) tables.push(t);
    const failure = checkScope(tables, stmt.whereClause);
    if (failure) flagDeny(failure);
  };

  // INSERT: if the target is scoped, the tenant column MUST appear in the
  // explicit column list AND every VALUES row's literal at that position
  // must equal ctx.tenant_id. Cases we can't statically verify (no
  // column list, INSERT … SELECT, ON CONFLICT … DO UPDATE) are
  // conservatively denied — operators must `exempt` the target.
  const checkInsert = (stmt: Record<string, unknown>): void => {
    const target = stmt.relation as Record<string, unknown> | undefined;
    if (!target) return;
    if (isSystemSchemaRangeVar(target)) return;
    const relname = target.relname as string | undefined;
    if (!relname) return;
    const col = requiredColumnFor(relname, cfg);
    if (col === null) return;

    const deny = (): void => flagDeny({ table: relname, column: col });

    // 1. Need an explicit column list — without one, the tenant column's
    //    position depends on the table schema we don't introspect.
    const cols = stmt.cols as unknown[] | undefined;
    if (!cols || cols.length === 0) {
      deny();
      return;
    }
    let tenantColPos = -1;
    for (let i = 0; i < cols.length; i++) {
      const entry = cols[i] as Record<string, unknown> | undefined;
      const resTarget = entry?.ResTarget as Record<string, unknown> | undefined;
      if (resTarget?.name === col) {
        tenantColPos = i;
        break;
      }
    }
    if (tenantColPos === -1) {
      // Tenant column omitted from INSERT — definitively missing.
      deny();
      return;
    }

    // 2. Source must be a VALUES list (not an INSERT … SELECT, which we
    //    can't statically verify column-by-column).
    const selectWrapper = stmt.selectStmt as Record<string, unknown> | undefined;
    const inner = selectWrapper?.SelectStmt as Record<string, unknown> | undefined;
    const valuesLists = inner?.valuesLists as unknown[] | undefined;
    if (!valuesLists || valuesLists.length === 0) {
      deny();
      return;
    }

    // 3. Every row's literal at tenantColPos must equal ctx.tenant_id.
    for (const row of valuesLists) {
      const list = (row as Record<string, unknown>).List as
        | Record<string, unknown>
        | undefined;
      const items = list?.items as unknown[] | undefined;
      if (!items || tenantColPos >= items.length) {
        deny();
        return;
      }
      const literal = extractConstLiteral(items[tenantColPos]);
      if (literal === null || literal !== tenantId) {
        deny();
        return;
      }
    }

    // 4. ON CONFLICT DO UPDATE re-opens the row to writes that may
    //    silently overwrite tenant fields; refuse to statically bless
    //    that path. ON CONFLICT DO NOTHING is fine (no write).
    const onConflict = stmt.onConflictClause as Record<string, unknown> | undefined;
    if (onConflict && onConflict.action === "ONCONFLICT_UPDATE") {
      deny();
      return;
    }
  };

  // MERGE on a scoped target: conservative blanket-deny. MERGE's WHEN
  // MATCHED / NOT MATCHED branches mix matching predicates with arbitrary
  // source rows; verifying tenant-correctness statically is out of
  // scope. Operators must `exempt` the target to use MERGE on it.
  const checkMerge = (stmt: Record<string, unknown>): void => {
    const target = stmt.relation as Record<string, unknown> | undefined;
    if (!target) return;
    if (isSystemSchemaRangeVar(target)) return;
    const relname = target.relname as string | undefined;
    if (!relname) return;
    const col = requiredColumnFor(relname, cfg);
    if (col !== null) flagDeny({ table: relname, column: col });
  };

  // Walk the parse tree recursively, dispatching to the per-statement
  // checker at each statement-kind node. Continues walking children so
  // nested SelectStmts (subqueries in WHERE / VALUES / SET / RETURNING)
  // get their own scope check.
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
        if (kind === "UpdateStmt" || kind === "DeleteStmt") {
          checkUpdateOrDelete(innerObj);
          for (const k of Object.keys(innerObj)) walk(innerObj[k]);
          return;
        }
        if (kind === "InsertStmt") {
          checkInsert(innerObj);
          for (const k of Object.keys(innerObj)) walk(innerObj[k]);
          return;
        }
        if (kind === "MergeStmt") {
          checkMerge(innerObj);
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

// `information_schema` is unconditionally carved out — it's a read-only
// set of SQL-standard views over schema (not row data), structurally
// tenant-free. Matches the existing `table_access` carve-out at
// table-access.ts:447. `pg_catalog` is NOT carved out — it exposes
// pg_roles, pg_proc bodies, pg_settings, etc. beyond schema discovery;
// operators who need queries against pg_catalog tables must `exempt`
// them explicitly.
function isSystemSchemaRangeVar(rangeVar: Record<string, unknown>): boolean {
  const schemaname = rangeVar.schemaname;
  return schemaname === "information_schema";
}

// Lift a single RangeVar into a ScopedTable when the table requires
// scoping. Returns null for system-schema refs and for tables the
// resolved config says are exempt or unmapped.
function rangeVarToScopedTable(
  rangeVar: Record<string, unknown>,
  cfg: TenantScopeConfig,
): ScopedTable | null {
  if (isSystemSchemaRangeVar(rangeVar)) return null;
  const relname = rangeVar.relname as string | undefined;
  if (!relname) return null;
  const column = requiredColumnFor(relname, cfg);
  if (column === null) return null;
  const alias = (rangeVar.alias as Record<string, unknown> | undefined)?.aliasname as
    | string
    | undefined;
  return { effectiveName: alias ?? relname, relname, column };
}

// Walk a SelectStmt's fromClause to collect every scoped RangeVar with its
// effective name (alias.aliasname if set, else relname) and required column.
// Skips RangeSubselects (their inner SelectStmt is its own scope) and
// information_schema refs (carved out — see isSystemSchemaRangeVar).
function collectScopedRangeVarsInFrom(
  fromClause: unknown,
  cfg: TenantScopeConfig,
): ScopedTable[] {
  const out: ScopedTable[] = [];
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
      const scoped = rangeVarToScopedTable(rangeVar, cfg);
      if (scoped) out.push(scoped);
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
    // is visited (or are not scoped at all).
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
