// Function/operator inventory over a libpg_query AST.
//
// Extracted from mask-safety.ts so the ALWAYS-ON path can share the one walker
// the masking gate already relies on. Two consumers, one traversal:
//   • normalize.ts   — populates NormalizedProgram.functionsInvoked, which the
//     always-on `dangerous_function` rule reads (denylist).
//   • mask-safety.ts — the masking-only shape gate (deny-by-default allowlist),
//     which additionally needs the operator inventory.
//
// The walk is FULLY RECURSIVE and descends into every child of every node. That
// is load-bearing, not incidental: PostgreSQL Anonymizer's
// GHSA-468r-mhwc-vxjc was bypassed precisely because its allowlist did not
// recurse — `pg_catalog.upper(public.elevate()::text)` presented a benign outer
// call wrapping an untrusted inner one. A nested call is a call.
//
// Both callers key on the LAST name part. libpg_query reports a qualified call
// `pg_catalog.query_to_xml(…)` as funcname ["pg_catalog", "query_to_xml"] and a
// bare call as ["query_to_xml"], so the pair (schema, name) below lets a
// denylist match on name alone (qualification cannot be used to evade it) while
// the masking allowlist can still reject any non-pg_catalog qualification.

// A function or operator as WRITTEN in the statement. `schema` is the explicit
// qualifier, or null for a bare call; `name` is the final name part.
export interface QualName {
  schema: string | null;
  name: string;
}

export interface Invocations {
  functions: QualName[];
  operators: QualName[];
}

function svals(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((n) => (n as { String?: { sval?: string } }).String?.sval)
    .filter((s): s is string => typeof s === "string");
}

function toQualName(parts: string[]): QualName {
  return parts.length >= 2
    ? { schema: parts[parts.length - 2]!, name: parts[parts.length - 1]! }
    : { schema: null, name: parts[0]! };
}

/** Every function and operator invoked anywhere in the tree, in walk order. */
export function inventory(ast: unknown): Invocations {
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
        if (parts.length > 0) functions.push(toQualName(parts));
      }
      if (o.A_Expr) {
        const a = o.A_Expr as { kind?: string; name?: unknown };
        // Only AEXPR_OP carries an operator spelling we gate; LIKE/IN/BETWEEN/etc.
        // are builtin comparison constructs (no user-resolvable operator name).
        if (a.kind === "AEXPR_OP" || a.kind === undefined) {
          const parts = svals(a.name);
          if (parts.length > 0) operators.push(toQualName(parts));
        }
      }
      for (const k of Object.keys(o)) walk(o[k]);
    }
  })(ast);
  return { functions, operators };
}
