// parse_error rule.
//
// Doesn't walk the AST (there is no AST when this rule fires). Emits a
// DENY verdict whenever the parse stage produced `ok: false`. This is the
// implicit "if it doesn't parse, we don't run it" rule from policy-rules.md.

import type { Rule, RuleEvalContext, RuleVerdict } from "./index.ts";
import { PolicyRule } from "../../audit/types.ts";

export function parseError(): Rule {
  return {
    name: PolicyRule.PARSE_ERROR,
    reset() {},
    finalize(rctx: RuleEvalContext): RuleVerdict {
      if (rctx.parse.ok) return { decision: "ALLOW" };
      return {
        decision: "DENY",
        reason: PolicyRule.PARSE_ERROR,
      };
    },
  };
}
