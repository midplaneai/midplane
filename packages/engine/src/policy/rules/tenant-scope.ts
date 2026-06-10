// tenant_scope rule.
//
// "Deny if a scoped table appears anywhere without a literal
//  `WHERE column = context.tenant_id` predicate at the same scope, where the
//   predicate's qualifier resolves to that exact table."
//
// Consumes the dialect-agnostic IR (NormalizedProgram.scopeUnits + unsupported)
// — one unit per SELECT/UPDATE/DELETE scope, INSERT, or MERGE the dialect's
// normalize() surfaced (including nested ones in CTEs / subqueries / UNION
// arms). The rule checks each unit independently and denies on the FIRST
// failure, matching the legacy single-walk firstFailure. All AST traversal
// lives in the adapter now; this rule is dialect-blind.
//
// A table is **scoped** when the resolved TenantScopeConfig says so:
//   1. `exempt[table]` ⇒ never scoped.
//   2. `overrides[table]` ⇒ scoped on that override column.
//   3. `defaultColumn` set ⇒ scoped on the default column (strict mode).
//   4. Otherwise ⇒ not scoped (legacy: only `overrides` tables checked).
//
// Same scope = one ScopeUnit. Predicates are AND-only equality (OR/NOT excluded
// by the adapter). Unqualified predicate counts only when exactly one scoped
// table is at the scope. INSERT verified from InsertShape; MERGE blanket-denied
// on a scoped target. information_schema is carved out (in toScopedRef);
// pg_catalog is NOT. Conservative: false positives acceptable, bypasses are not.

import type { Rule, RuleEvalContext, RuleVerdict } from "./index.ts";
import type {
  EqualityPredicate,
  InsertShape,
  NormalizedProgram,
  TableRef,
} from "../../ir/types.ts";
import { PolicyRule } from "../../audit/types.ts";

type ScopedTable = { effectiveName: string; relname: string; column: string };

interface ScopeFailure {
  table: string;
  column: string;
}

// Resolved configuration the rule evaluates against. Every accepted source
// shape (legacy flat record, rich config, ctx fallback) is normalized into this.
export interface TenantScopeConfig {
  defaultColumn: string | null;
  overrides: Record<string, string>;
  exempt: string[];
}

// Accepts a static rich config, a static legacy flat `table → column` record, a
// getter returning either (used by mcp-server to hot-swap), or undefined (read
// `ctx.tenant_scope` — back-compat for test fixtures without a holder).
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
    evaluateIR(program: NormalizedProgram, rctx: RuleEvalContext): RuleVerdict {
      if (!rctx.parse.ok) return { decision: "ALLOW" };
      const cfg = resolve(rctx);
      if (cfg === null) return { decision: "ALLOW" };
      const tid = rctx.ctx.tenant_id;
      // Fail closed on anything the dialect parser couldn't model: if such a
      // statement touches a tenant-scoped table we can't verify the predicate,
      // so deny. A no-op for Postgres (libpg_query models everything, so
      // `unsupported` is always empty — the verdict baseline proves it); the
      // real guard arrives with MySQL/SQLite.
      for (const u of program.unsupported) {
        const failure = checkScopeUnit(u.touchedTables, [], cfg, tid);
        if (failure) return denyTenantScope(failure);
      }
      for (const u of program.scopeUnits) {
        const failure =
          u.kind === "scope"
            ? checkScopeUnit(u.tables, u.predicates, cfg, tid)
            : u.kind === "insert"
              ? checkInsertUnit(u.shape, cfg, tid)
              : checkMergeUnit(u.target, cfg);
        if (failure) return denyTenantScope(failure);
      }
      return { decision: "ALLOW" };
    },
  };
}

// The single deny verdict for a tenant-scope failure.
function denyTenantScope(f: ScopeFailure): RuleVerdict {
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
}

// Resolve the required tenant column for a bare relname: exempt → overrides →
// defaultColumn. null = the table doesn't need scoping.
function requiredColumnFor(relname: string, cfg: TenantScopeConfig): string | null {
  if (cfg.exempt.includes(relname)) return null;
  const override = cfg.overrides[relname];
  if (override !== undefined) return override;
  return cfg.defaultColumn;
}

// Public wrapper over `requiredColumnFor` for callers outside the rule (the
// cloud dry-run): given a bare relname and a resolved TenantScopeConfig, return
// the tenant column the table must filter on, or null when the table isn't
// scoped (exempt, unmapped, or an inert config). The dry-run uses this BOTH to
// synthesize a correctly-scoped probe statement and to label the
// `tenant_scope:<table>.<column>` matched_rule — the same `requiredColumnFor`
// the live rule applies, so neither can drift from the verdict.
export function resolveTenantColumn(
  relname: string,
  cfg: TenantScopeConfig,
): string | null {
  return requiredColumnFor(relname, cfg);
}

// Lift an IR TableRef into a ScopedTable when it requires scoping. Returns null
// for the information_schema carve-out and for exempt/unmapped tables.
function toScopedRef(ref: TableRef, cfg: TenantScopeConfig): ScopedTable | null {
  if (ref.schema === "information_schema") return null;
  const column = requiredColumnFor(ref.relname, cfg);
  if (column === null) return null;
  return { effectiveName: ref.effectiveName, relname: ref.relname, column };
}

function checkScopeUnit(
  tables: TableRef[],
  predicates: EqualityPredicate[],
  cfg: TenantScopeConfig,
  tenantId: string,
): ScopeFailure | null {
  const scoped = tables
    .map((t) => toScopedRef(t, cfg))
    .filter((x): x is ScopedTable => x !== null);
  if (scoped.length === 0) return null;
  for (const tb of scoped) {
    const matched = predicates.some((p) => {
      if (p.column !== tb.column) return false;
      if (p.literal !== tenantId) return false;
      if (p.qualifier !== null) return p.qualifier === tb.effectiveName;
      // Unqualified predicate counts only when there's exactly one scoped table
      // at this scope — otherwise it's ambiguous.
      return scoped.length === 1;
    });
    if (!matched) return { table: tb.relname, column: tb.column };
  }
  return null;
}

// INSERT: a scoped target requires the tenant column in the explicit column
// list AND every VALUES row's literal at that position equals ctx.tenant_id.
// Forms we can't statically verify (no column list, INSERT…SELECT, ON CONFLICT
// DO UPDATE) are conservatively denied — operators must `exempt` the target.
function checkInsertUnit(
  shape: InsertShape,
  cfg: TenantScopeConfig,
  tenantId: string,
): ScopeFailure | null {
  if (shape.target.schema === "information_schema") return null;
  const col = requiredColumnFor(shape.target.relname, cfg);
  if (col === null) return null;
  const fail: ScopeFailure = { table: shape.target.relname, column: col };

  if (!shape.hasExplicitColumns) return fail;
  const pos = shape.columns.indexOf(col);
  if (pos === -1) return fail;
  if (shape.valuesRows === null) return fail;
  for (const row of shape.valuesRows) {
    if (pos >= row.length) return fail;
    const lit = row[pos];
    if (lit === null || lit !== tenantId) return fail;
  }
  if (shape.onConflictDoUpdate) return fail;
  return null;
}

// MERGE on a scoped target: conservative blanket-deny (WHEN MATCHED / NOT
// MATCHED branches are too varied to verify statically). `exempt` to use it.
function checkMergeUnit(target: TableRef, cfg: TenantScopeConfig): ScopeFailure | null {
  if (target.schema === "information_schema") return null;
  const col = requiredColumnFor(target.relname, cfg);
  return col !== null ? { table: target.relname, column: col } : null;
}

// Read tenant_scope from the per-call EngineContext (back-compat for tests that
// don't construct a holder). Accepts the rich shape or the legacy `mappings`.
function ctxToRaw(
  rctx: RuleEvalContext,
): TenantScopeConfig | Record<string, string> | undefined {
  const ts = rctx.ctx.tenant_scope;
  if (!ts) return undefined;
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
  if (ts.mappings) return ts.mappings;
  return undefined;
}

// Normalize any accepted source shape into TenantScopeConfig | null. `null`
// means "nothing to enforce" — short-circuit ALLOW. A config with empty
// overrides and null defaultColumn also normalizes to null (legacy "no mappings").
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
  if (cfg.defaultColumn === null && Object.keys(cfg.overrides).length === 0) {
    return null;
  }
  return cfg;
}

function isRichConfig(
  raw: TenantScopeConfig | Record<string, string>,
): raw is TenantScopeConfig {
  return "defaultColumn" in raw || "overrides" in raw || "exempt" in raw;
}
