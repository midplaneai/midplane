// Covert-channel mask-safety gate (ET2). The source-rewriter only masks relations
// it can SEE as RangeVars; a function that reads a masked table through a runtime
// string the parser can't see — query_to_xml('SELECT cc FROM customers'), dblink,
// an FDW, a SECURITY DEFINER UDF — is invisible to the rewrite and would return raw
// PII. So when masking is active EVERY function/operator the statement invokes must
// be a vetted mask-safe builtin; anything else fails the query closed.
//
// Two stages (doc "covert-channel guard"):
//   1. SHAPE gate — checkMaskSafeShape(sql): sync, AST-only, runs in the policy phase
//      so decide()/preview sees it. DENY-BY-DEFAULT: any function not on the bare
//      builtin allowlist, any schema-qualified function/operator, or any off-list
//      operator → reject. Catches query_to_xml / dblink / FDW / UDF by name+shape.
//   2. SHADOW scan — shadowScan(tx, names): per-connection DB check that no
//      allowlisted *bare* name (e.g. `sum`) is shadowed by a user-schema function
//      ahead of pg_catalog in the pinned search_path. Catches `public.sum(...)`
//      redefining a builtin (Codex #5 — identity, not spelling). NOT per-query
//      overload resolution (intractable from the raw AST, Codex #2).
//
// SECURITY-REVIEW GATE: MASK_SAFE_FUNCTIONS below is a conservative SEED. Because
// the gate is deny-by-default it is SOUND while incomplete (it over-rejects legit
// analytics, never leaks), but the allowlist must be threat-modeled and expanded
// before Phase-1 ship. Note the deliberate EXCLUSIONS at the bottom — especially
// current_setting (would let an agent read our mask-salt GUC) and the row/xml/file
// readers.

import { parseSync } from "libpg-query";
import type { TxClient } from "../../executor.ts";

export type GateOutcome = { ok: true } | { ok: false; reason: string };

// Pure, non-reflective scalar + aggregate builtins safe to run over a masked
// projection. Bare names only — schema-qualified calls are denied outright (below).
export const MASK_SAFE_FUNCTIONS: ReadonlySet<string> = new Set([
  // aggregates
  "count", "sum", "avg", "min", "max", "every", "bool_and", "bool_or",
  "stddev", "stddev_pop", "stddev_samp", "variance", "var_pop", "var_samp",
  // math
  "abs", "ceil", "ceiling", "floor", "round", "trunc", "sign", "mod", "power",
  "sqrt", "div", "greatest", "least", "width_bucket",
  // string (pure)
  "length", "char_length", "character_length", "lower", "upper", "trim", "btrim",
  "ltrim", "rtrim", "substr", "substring", "left", "right", "lpad", "rpad",
  "replace", "concat", "concat_ws", "initcap", "reverse", "split_part", "position",
  "strpos", "starts_with", "md5",
  // date/time (pure)
  "date_trunc", "date_part", "extract", "age", "to_char", "make_date",
  "make_timestamp", "make_time",
]);

// Allowlisted operator spellings (binary/unary). Schema-qualified operators
// (OPERATOR(schema.op)) are denied. Boolean AND/OR/NOT are BoolExpr nodes, not
// A_Expr, so they're inherently safe and not listed here.
export const MASK_SAFE_OPERATORS: ReadonlySet<string> = new Set([
  "=", "<>", "!=", "<", ">", "<=", ">=", // comparison
  "+", "-", "*", "/", "%", "^", // arithmetic
  "||", // string/array concat (operands are wrapped if from a masked table)
]);

interface QualName {
  schema: string | null;
  name: string;
}

function svals(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((n) => (n as { String?: { sval?: string } }).String?.sval)
    .filter((s): s is string => typeof s === "string");
}

interface Invocations {
  functions: QualName[];
  operators: QualName[];
}

function inventory(ast: unknown): Invocations {
  const functions: QualName[] = [];
  const operators: QualName[] = [];
  (function walk(node: unknown): void {
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (o.FuncCall) {
        const parts = svals((o.FuncCall as { funcname?: unknown }).funcname);
        if (parts.length > 0) {
          functions.push(
            parts.length >= 2
              ? { schema: parts[parts.length - 2]!, name: parts[parts.length - 1]! }
              : { schema: null, name: parts[0]! },
          );
        }
      }
      if (o.A_Expr) {
        const a = o.A_Expr as { kind?: string; name?: unknown };
        // Only AEXPR_OP carries an operator spelling we gate; LIKE/IN/BETWEEN/etc.
        // are builtin comparison constructs (no user-resolvable operator name).
        if (a.kind === "AEXPR_OP" || a.kind === undefined) {
          const parts = svals(a.name);
          if (parts.length > 0) {
            operators.push(
              parts.length >= 2
                ? { schema: parts[parts.length - 2]!, name: parts[parts.length - 1]! }
                : { schema: null, name: parts[0]! },
            );
          }
        }
      }
      for (const k of Object.keys(o)) walk(o[k]);
    }
  })(ast);
  return { functions, operators };
}

/** Stage 1 — sync, AST-only. Reject if any function/operator is off-allowlist or
 *  schema-qualified to a non-builtin. Returns the bare allowlisted function names
 *  used, to feed the shadow scan (stage 2). */
export function checkMaskSafeShape(
  sql: string,
): { ok: true; allowlistedFns: string[] } | { ok: false; reason: string } {
  let ast: unknown;
  try {
    ast = parseSync(sql);
  } catch {
    return { ok: false, reason: "could not parse statement for mask-safety check" };
  }
  const { functions, operators } = inventory(ast);
  const used = new Set<string>();
  for (const f of functions) {
    // A schema-qualified call is only OK if it explicitly targets pg_catalog AND the
    // bare name is allowlisted; any user-schema qualification is denied outright.
    if (f.schema !== null && f.schema !== "pg_catalog") {
      return { ok: false, reason: `function "${f.schema}.${f.name}" is not mask-safe (schema-qualified call while masking is active)` };
    }
    if (!MASK_SAFE_FUNCTIONS.has(f.name)) {
      return { ok: false, reason: `function "${f.name}" is not on the mask-safe allowlist; it could read masked data the rewriter can't see` };
    }
    used.add(f.name);
  }
  for (const op of operators) {
    if (op.schema !== null) {
      return { ok: false, reason: `operator "${op.schema}.${op.name}" is not mask-safe (schema-qualified operator)` };
    }
    if (!MASK_SAFE_OPERATORS.has(op.name)) {
      return { ok: false, reason: `operator "${op.name}" is not on the mask-safe allowlist` };
    }
  }
  return { ok: true, allowlistedFns: [...used] };
}

// Schemas searched ahead of pg_catalog under the executor's pinned search_path; a
// function defined here shadows the builtin of the same bare name. Mirrors
// PgPoolExecutor's PINNED_SEARCH_PATH_SCHEMAS (public first).
const SHADOWING_SCHEMAS = ["public"] as const;

/** Stage 2 — per-connection. Reject if any used allowlisted bare name is shadowed
 *  by a user-schema function ahead of pg_catalog (so `sum` might resolve to a UDF,
 *  not the builtin). Runs on the same TxClient as resolve+execute. No names → no
 *  round-trip. */
export async function shadowScan(tx: TxClient, names: string[]): Promise<GateOutcome> {
  if (names.length === 0) return { ok: true };
  const rows = await tx.query(
    `SELECT n.nspname AS schema, p.proname AS name
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = ANY($1::text[]) AND n.nspname = ANY($2::text[])`,
    [names, [...SHADOWING_SCHEMAS]],
  );
  if (rows.length > 0) {
    const r = rows[0] as { schema: string; name: string };
    return {
      ok: false,
      reason: `builtin "${r.name}" is shadowed by ${r.schema}.${r.name}; cannot prove it is mask-safe while masking is active`,
    };
  }
  return { ok: true };
}

// DELIBERATE EXCLUSIONS (must NOT be added to MASK_SAFE_FUNCTIONS):
//   - current_setting / set_config — would let an agent READ our mask-salt GUC.
//   - query_to_xml / query_to_xmlschema / *_to_xml / cursor_to_xml — execute a SQL
//     string the parser can't see (the core covert-read channel).
//   - dblink* / postgres_fdw helpers — read other databases.
//   - to_jsonb / to_json / row_to_json / json*_agg — whole-row serialization.
//   - pg_read_file / pg_ls_dir / lo_* / pg_read_binary_file — filesystem / large object.
//   - generate_series / unnest / json*_elements and other set-returning functions.
//   - any function with provolatile='v' that reads catalogs/relations reflectively.
