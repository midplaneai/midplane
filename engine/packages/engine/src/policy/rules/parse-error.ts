// parse_error rule.
//
// Doesn't walk the AST (there is no AST when this rule fires). Emits a
// DENY verdict whenever the parse stage produced `ok: false`. This is the
// implicit "if it doesn't parse, we don't run it" rule from policy-rules.md.

import type { Rule, RuleEvalContext, RuleVerdict } from "./index.ts";
import { PolicyRule } from "../../audit/types.ts";

function verdict(rctx: RuleEvalContext): RuleVerdict {
  if (rctx.parse.ok) return { decision: "ALLOW" };
  return {
    decision: "DENY",
    reason: PolicyRule.PARSE_ERROR,
    message:
      `Midplane denied this query because it could not be parsed as ` +
      `Postgres SQL (${rctx.parse.error}). Anything Midplane can't ` +
      `parse is denied — it can't enforce policy on text it can't read.`,
  };
}

export function parseError(): Rule {
  return {
    name: PolicyRule.PARSE_ERROR,
    // parse_error owns the ok:false case and ignores the program entirely.
    evaluateIR: (_program, rctx) => verdict(rctx),
  };
}
