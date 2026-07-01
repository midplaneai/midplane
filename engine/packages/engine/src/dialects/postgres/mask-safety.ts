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
// SAFETY CRITERION (the reasoning the allowlist rests on). Under source-rewrite the
// mask is applied at the RTE, so any argument sourced from a masked column is ALREADY
// masked before a function sees it. A function is therefore mask-safe iff every value
// it can observe is derivable from its SYNTACTIC ARGUMENTS plus non-secret, fixed
// SESSION CONTEXT (the clock, TimeZone, locale) — i.e. a pure / non-data-reading
// scalar or aggregate builtin. Session context is fine because it exposes no masked
// ROW data: now()/age()/timestamptz formatting read only the clock/TimeZone, never a
// relation, a file, or a SECRET GUC (current_setting can target the mask salt, so it
// stays excluded; the date/time builtins can reach only TimeZone). Closed under
// composition:
// f(g(x)) is safe when f and g are, so a curated set of pure builtins is safe in any
// combination. UNSAFE = anything that reaches data OUTSIDE its arguments: dynamic SQL,
// filesystem / large-object, session/GUC introspection (incl. the mask salt),
// reflective catalog/admin functions, functions that dereference an object NAME /
// regclass argument (they read the object, not the value), and — deferred, not because
// they leak but because each family needs its own analysis — whole-row / JSON
// serialization and set-returning functions. See the EXCLUSIONS block at the end.
//
// Threat-modeled + expanded 2026-06-30 (security review). Still DENY-BY-DEFAULT, so a
// name we forgot only OVER-rejects; the only residual risk is a name WRONGLY included
// that secretly reads data — every entry below was checked against the criterion and
// re-checked by an adversarial cross-model pass. SQLValueFunction constants
// (current_date/current_user/current_timestamp/…) parse as their own node, not
// FuncCall, so they bypass this gate entirely — acceptable: they expose session
// identity/clock, never masked row data.

import { parseSync } from "libpg-query";
import type { TxClient } from "../../executor.ts";
import type { GateOutcome, ShadowUsed, ShapeOutcome } from "../../masking/source-rewrite.ts";

// Pure, non-reflective scalar + aggregate builtins safe to run over a masked
// projection (see SAFETY CRITERION above). Bare names only — schema-qualified calls
// are denied outright (below). Deny-by-default: absence = reject, never leak.
export const MASK_SAFE_FUNCTIONS: ReadonlySet<string> = new Set([
  // ── aggregates (fold their arguments; a masked arg is already masked) ──
  "count", "sum", "avg", "min", "max", "every", "bool_and", "bool_or", "bit_and", "bit_or",
  "stddev", "stddev_pop", "stddev_samp", "variance", "var_pop", "var_samp",
  "corr", "covar_pop", "covar_samp",
  "regr_avgx", "regr_avgy", "regr_count", "regr_intercept", "regr_r2", "regr_slope",
  "regr_sxx", "regr_sxy", "regr_syy",
  "mode", "percentile_cont", "percentile_disc",
  "string_agg", "array_agg", // aggregate the masked scalar values into text / an array
  // ── window functions (pure; the frame is already-masked rows) ──
  "row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile",
  "lag", "lead", "first_value", "last_value", "nth_value",
  // ── math (all pure) ──
  "abs", "ceil", "ceiling", "floor", "round", "trunc", "sign", "mod", "power",
  "sqrt", "cbrt", "exp", "ln", "log", "log10", "pi", "div", "gcd", "lcm",
  "greatest", "least", "width_bucket", "scale", "min_scale", "trim_scale",
  "degrees", "radians", "sin", "cos", "tan", "cot", "asin", "acos", "atan", "atan2",
  "sinh", "cosh", "tanh", "factorial",
  // ── string (pure; a masked text arg is already redacted before we see it) ──
  "length", "char_length", "character_length", "bit_length", "octet_length",
  "lower", "upper", "initcap", "trim", "btrim", "ltrim", "rtrim",
  "substr", "substring", "left", "right", "lpad", "rpad", "repeat", "reverse",
  "replace", "translate", "overlay", "concat", "concat_ws", "format",
  "split_part", "position", "strpos", "starts_with", "ascii", "chr",
  "regexp_replace", "regexp_count", "regexp_instr", "regexp_substr",
  "encode", "decode", "md5", "sha224", "sha256", "sha384", "sha512",
  // ── date/time (pure; clock funcs read the clock, not masked data) ──
  "date_trunc", "date_bin", "date_part", "extract", "age", "isfinite",
  "to_char", "to_number", "to_date", "to_timestamp",
  "make_date", "make_time", "make_timestamp", "make_timestamptz", "make_interval",
  "justify_days", "justify_hours", "justify_interval", "now",
  // ── json CONSTRUCTION from explicit scalar arguments (B6) ──
  // These build json from an explicit key/value/element LIST — every argument is an
  // ordinary expression, so an argument sourced from a masked column is already masked
  // by the wrap (verified live: json_build_object('cc', credit_card) → {"cc":"***"}).
  // They have NO whole-row/composite overload and take no object-name/rowtype argument,
  // so they can't reach raw data the way to_jsonb(c)/row_to_json/json_agg(c) can — see
  // the WHOLE-ROW / JSON SERIALIZATION exclusion note below for why those stay out.
  "json_build_object", "jsonb_build_object", "json_build_array", "jsonb_build_array",
]);

// Allowlisted operator spellings (binary/unary). Schema-qualified operators
// (OPERATOR(schema.op)) are denied. Boolean AND/OR/NOT are BoolExpr nodes, not
// A_Expr, so they're inherently safe and not listed here.
export const MASK_SAFE_OPERATORS: ReadonlySet<string> = new Set([
  "=", "<>", "!=", "<", ">", "<=", ">=", // comparison
  "+", "-", "*", "/", "%", "^", // arithmetic
  "||", // string/array concat (operands are wrapped if from a masked table)
  "~", "~*", "!~", "!~*", // POSIX regex match — pure comparison on the (masked) value
  "&", "|", "#", "<<", ">>", // bitwise — pure
]);
// The shadow scan (below) resolves BOTH function identity (pg_proc) AND operator
// identity (pg_operator), so a user-schema operator that redefines a builtin spelling
// ahead of pg_catalog — whose body could call current_setting / query_to_xml — is
// caught, not just off-allowlist spellings (Codex allowlist review, High).

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
export function checkMaskSafeShape(sql: string): ShapeOutcome {
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
  const usedOps = new Set<string>();
  for (const op of operators) {
    if (op.schema !== null) {
      return { ok: false, reason: `operator "${op.schema}.${op.name}" is not mask-safe (schema-qualified operator)` };
    }
    if (!MASK_SAFE_OPERATORS.has(op.name)) {
      return { ok: false, reason: `operator "${op.name}" is not on the mask-safe allowlist` };
    }
    usedOps.add(op.name);
  }
  return { ok: true, allowlistedFns: [...used], allowlistedOps: [...usedOps] };
}

// Schemas searched ahead of pg_catalog under the executor's pinned search_path; a
// function defined here shadows the builtin of the same bare name. Mirrors
// PgPoolExecutor's PINNED_SEARCH_PATH_SCHEMAS (public first).
const SHADOWING_SCHEMAS = ["public"] as const;

/** Stage 2 — per-connection. Reject if any used allowlisted bare name is shadowed by
 *  a user-schema definition ahead of pg_catalog — a FUNCTION (`sum` → a UDF) or an
 *  OPERATOR (`||` → a user operator whose body calls current_setting/query_to_xml;
 *  Codex allowlist review, High). Runs on the same TxClient as resolve+execute. No
 *  names → no round-trip. */
export async function shadowScan(tx: TxClient, used: ShadowUsed): Promise<GateOutcome> {
  if (used.functions.length > 0) {
    const rows = await tx.query(
      `SELECT n.nspname AS schema, p.proname AS name
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = ANY($1::text[]) AND n.nspname = ANY($2::text[])`,
      [used.functions, [...SHADOWING_SCHEMAS]],
    );
    if (rows.length > 0) {
      const r = rows[0] as { schema: string; name: string };
      return {
        ok: false,
        reason: `builtin function "${r.name}" is shadowed by ${r.schema}.${r.name}; cannot prove it is mask-safe while masking is active`,
      };
    }
  }
  if (used.operators.length > 0) {
    const rows = await tx.query(
      `SELECT n.nspname AS schema, p.oprname AS name
         FROM pg_operator p JOIN pg_namespace n ON n.oid = p.oprnamespace
        WHERE p.oprname = ANY($1::text[]) AND n.nspname = ANY($2::text[])`,
      [used.operators, [...SHADOWING_SCHEMAS]],
    );
    if (rows.length > 0) {
      const r = rows[0] as { schema: string; name: string };
      return {
        ok: false,
        reason: `builtin operator "${r.name}" is shadowed by ${r.schema}."${r.name}"; cannot prove it is mask-safe while masking is active`,
      };
    }
  }
  return { ok: true };
}

// DELIBERATE EXCLUSIONS (must NOT be added to MASK_SAFE_FUNCTIONS). Each violates the
// SAFETY CRITERION by reaching data outside its syntactic arguments — deny-by-default
// already blocks them; listed so the reasoning survives future edits:
//   DYNAMIC SQL (the core covert-read channel — execute a string the parser can't see):
//     query_to_xml / query_to_xmlschema / query_to_xml_and_xmlschema, cursor_to_xml*,
//     table_to_xml* / schema_to_xml* / database_to_xml*, dblink* / dblink_exec.
//   SESSION / CONFIG INTROSPECTION (current_setting would read the mask-salt GUC):
//     current_setting, set_config, pg_settings-style readers.
//   FILESYSTEM / LARGE OBJECT: pg_read_file, pg_read_binary_file, pg_read_server_files,
//     pg_ls_dir, pg_stat_file, lo_import / lo_export / lo_get / loread.
//   OBJECT-NAME / REGCLASS DEREFERENCE (read the named object, not the arg value):
//     pg_relation_size / pg_total_relation_size, currval / nextval / setval,
//     pg_get_serial_sequence, pg_get_expr / pg_get_viewdef, has_*_privilege.
//   REFLECTIVE / ADMIN / DoS: pg_* system-admin functions, txid_* / pg_current_xact_id,
//     pg_backend_pid, pg_sleep (DoS), pg_stat_* readers.
//   WHOLE-ROW / JSON / XML SERIALIZATION — reviewed 2026-07-01 (B6, adversarial pass).
//     Only the json *construction* helpers (json_build_object/_array + jsonb variants)
//     proved cleanly safe and were ADDED above — they take an explicit scalar arg list,
//     have no whole-row overload, and deref no object name. The rest stay EXCLUDED:
//       - to_json / to_jsonb / row_to_json / json_agg / jsonb_agg / json_object_agg /
//         xmlelement / xmlforest / xmlagg: composite-CAPABLE. The wrap masks the SIMPLE
//         wrapped-alias case (to_jsonb(c) → the masked derived rowtype), but this gate
//         keys on the function NAME, not the argument type, and there is NO whole-row-
//         composite reject implemented (systemColumnReject covers only literal system
//         columns, not fn args). So the NAME-exclusion here is the sole defense against
//         the whole-row form; do not add these without first adding an AST guard that
//         rejects a composite/whole-row argument to a function while masking is active.
//       - json_populate_record / jsonb_populate_record(set) / json_to_record /
//         jsonb_to_record: the first argument is a rowtype/table-name DEREF
//         (null::some_table) — Postgres reads that table's shape out of the catalog,
//         bypassing the source wrap entirely. A REAL leak path. Exclude.
//       - hstore, xpath, table_to_xml/query_to_xml (already covered under dynamic SQL).
//   SET-RETURNING: generate_series, unnest, regexp_matches / regexp_split_to_table,
//     string_to_table, json*_array_elements* / json*_each* — safe-on-DATA (input is the
//     already-masked passed value) but deferred for target-list SRF semantics, a
//     separate concern from data-reach.
