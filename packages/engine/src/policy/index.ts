// Policy module — orchestrates the single-walk visitor + rule callbacks +
// finalization.

import type { ParseResult } from "../dialects/postgres/parse.ts";
import { postgresDialect } from "../dialects/postgres/index.ts";
import type { Dialect } from "../dialects/types.ts";
import type { NormalizedProgram } from "../ir/types.ts";
import type { Rule, RuleEvalContext, RuleVerdict } from "./rules/index.ts";

export type { Rule, RuleVerdict, RuleEvalContext } from "./rules/index.ts";
export { tableAccess } from "./rules/table-access.ts";
export type { TableAccessConfig, TableAccessLevel } from "./rules/table-access.ts";
export { multiStatement } from "./rules/multi-statement.ts";
export { tenantScope } from "./rules/tenant-scope.ts";
export type { TenantScopeConfig, TenantScopeSource } from "./rules/tenant-scope.ts";
export { parseError } from "./rules/parse-error.ts";

export interface EvaluateInput {
  parse: ParseResult;
  ctx: RuleEvalContext["ctx"];
  rules: Rule[];
  // Dialect that owns normalize(). Optional + defaults to postgres so existing
  // callers/embedders compile unchanged. Only consumed by the IR-equivalence
  // assertion today; in the cut-over it becomes the source of the program the
  // rules evaluate.
  dialect?: Dialect;
}

export interface EvaluateResult {
  verdict: RuleVerdict;
  statementType: string | null;
  tablesTouched: string[];
}

// Evaluates all rules in a single AST walk.
//
// Rule evaluation order on DENY: the rule list is checked in array order;
// the first DENY verdict wins. Order parse_error → multi_statement →
// table_access → tenant_scope so the most-specific failure surfaces.
export function evaluate(input: EvaluateInput): EvaluateResult {
  const rctx: RuleEvalContext = { parse: input.parse, ctx: input.ctx };

  // Project the parsed statement into the dialect-agnostic IR once; the rules
  // read only this. On a parse failure there's no AST to normalize — parse_error
  // owns that case and every other rule short-circuits ALLOW on !parse.ok, so an
  // empty program is the correct input.
  const program: NormalizedProgram = input.parse.ok
    ? (input.dialect ?? postgresDialect).normalize(input.parse.ast)
    : EMPTY_PROGRAM;

  let verdict: RuleVerdict = { decision: "ALLOW" };
  for (const r of input.rules) {
    const v = r.evaluateIR(program, rctx);
    if (v.decision === "DENY") {
      verdict = v;
      break;
    }
  }

  return {
    verdict,
    // Audit statement_type + tables_touched come straight from the IR (the
    // dialect's normalize computes them). Proven byte-identical to the former
    // inline AST accumulator by the IR-equivalence harness before the cut-over.
    statementType: program.auditStatementType,
    tablesTouched: program.allRelnames,
  };
}

// Input for a parse failure: no AST, nothing to normalize. parse_error denies;
// every other rule short-circuits ALLOW on !parse.ok, so the contents are inert.
const EMPTY_PROGRAM: NormalizedProgram = {
  statementCount: 0,
  auditStatementType: null,
  allRelnames: [],
  accessChecks: [],
  scopeUnits: [],
  unsupported: [],
};
