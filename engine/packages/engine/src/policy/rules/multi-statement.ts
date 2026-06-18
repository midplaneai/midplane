// multi_statement rule.
//
// Denies any query whose AST contains more than one top-level statement.
// Catches the Datadog Security Labs SQLi vector against the deprecated
// Anthropic Postgres MCP — `SELECT 1; DROP TABLE users;`.
//
// The parser handles comment-stripping correctly, so we count
// tree.stmts.length (not semicolons in the raw text).

import type { Rule, RuleEvalContext, RuleVerdict } from "./index.ts";
import type { NormalizedProgram } from "../../ir/types.ts";
import { PolicyRule } from "../../audit/types.ts";

function denyFor(n: number): RuleVerdict {
  return {
    decision: "DENY",
    reason: PolicyRule.MULTI_STATEMENT,
    message:
      `Midplane denied this query because it contains ${n} statements ` +
      `separated by semicolons. Send each statement as a separate ` +
      `query (multi-statement input is the canonical SQL-injection ` +
      `vector and is denied unconditionally).`,
  };
}

export function multiStatement(): Rule {
  return {
    name: PolicyRule.MULTI_STATEMENT,
    evaluateIR(program: NormalizedProgram, rctx: RuleEvalContext): RuleVerdict {
      if (!rctx.parse.ok) return { decision: "ALLOW" }; // parse_error owns this case
      return program.statementCount > 1
        ? denyFor(program.statementCount)
        : { decision: "ALLOW" };
    },
  };
}
