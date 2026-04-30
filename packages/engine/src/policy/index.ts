// Policy module — orchestrates the single-walk visitor + rule callbacks +
// finalization.

import type { ParseResult } from "../parser/parse.ts";
import { walk } from "./visitor.ts";
import type { Rule, RuleEvalContext, RuleVerdict } from "./rules/index.ts";

export type { Rule, RuleVerdict, RuleEvalContext } from "./rules/index.ts";
export { tableAccess } from "./rules/table-access.ts";
export type { TableAccessConfig, TableAccessLevel } from "./rules/table-access.ts";
export { multiStatement } from "./rules/multi-statement.ts";
export { tenantScope } from "./rules/tenant-scope.ts";
export { parseError } from "./rules/parse-error.ts";

export interface EvaluateInput {
  parse: ParseResult;
  ctx: RuleEvalContext["ctx"];
  rules: Rule[];
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
  for (const r of input.rules) r.reset(rctx);

  // statement_type + tables_touched accumulators (always-on, used by audit)
  let statementType: string | null = null;
  const tablesTouched = new Set<string>();

  if (input.parse.ok) {
    const accumulator = {
      visit(_node: unknown, kind: string | null) {
        if (kind && /Stmt$/.test(kind) && statementType === null) {
          statementType = kind.replace(/Stmt$/, "").toUpperCase();
        }
        if (kind === "RangeVar") {
          const relname = (_node as Record<string, unknown>)?.relname;
          if (typeof relname === "string") tablesTouched.add(relname);
        }
      },
    };

    walk(input.parse.ast, [accumulator, ...input.rules]);
  }

  let verdict: RuleVerdict = { decision: "ALLOW" };
  for (const r of input.rules) {
    const v = r.finalize(rctx);
    if (v.decision === "DENY") {
      verdict = v;
      break;
    }
  }

  return {
    verdict,
    statementType,
    tablesTouched: [...tablesTouched],
  };
}
