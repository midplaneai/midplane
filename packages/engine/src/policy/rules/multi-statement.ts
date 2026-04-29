// multi_statement rule.
//
// Denies any query whose AST contains more than one top-level statement.
// Catches the Datadog Security Labs SQLi vector against the deprecated
// Anthropic Postgres MCP — `SELECT 1; DROP TABLE users;`.
//
// The parser handles comment-stripping correctly, so we count
// tree.stmts.length (not semicolons in the raw text).

import type { Rule, RuleEvalContext, RuleVerdict } from "./index.ts";
import { PolicyRule } from "../../audit/types.ts";

export function multiStatement(): Rule {
  return {
    name: PolicyRule.MULTI_STATEMENT,
    reset() {},
    finalize(rctx: RuleEvalContext): RuleVerdict {
      if (!rctx.parse.ok) return { decision: "ALLOW" }; // parse_error owns this case
      const n = rctx.parse.ast.stmts.length;
      if (n > 1) {
        return { decision: "DENY", reason: PolicyRule.MULTI_STATEMENT };
      }
      return { decision: "ALLOW" };
    },
  };
}
