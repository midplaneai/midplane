// writes_require_approval rule (T1 / T4).
//
// V1 default: writes denied. The visitor flags ANY occurrence of a write
// statement kind anywhere in the AST — top level, inside a CTE, inside
// a subquery. Recursive AST detection per T4 catches the
// `WITH x AS (DELETE … RETURNING *) SELECT * FROM x` bypass.
//
// DoStmt is in the write set even though it's nominally procedural:
// libpg-query keeps the body of `DO $$ ... $$` as an opaque string
// literal, so AST scanning cannot see writes inside. Conservative
// answer is to deny DO outright at V1.

import type { Rule, RuleEvalContext, RuleVerdict } from "./index.ts";
import type { VisitorScope } from "../visitor.ts";
import { PolicyRule } from "../../audit/types.ts";

const WRITE_KINDS = new Set([
  "InsertStmt",
  "UpdateStmt",
  "DeleteStmt",
  "MergeStmt",
  "DropStmt",
  "TruncateStmt",
  "AlterTableStmt",
  "AlterDomainStmt",
  "GrantStmt",
  "GrantRoleStmt",
  "RevokeStmt",
  "CreateStmt",
  "CreateTableAsStmt",
  "CreateSchemaStmt",
  "CreateRoleStmt",
  "CreateFunctionStmt",
  "CreatedbStmt",
  "ExecuteStmt",
  "CallStmt",
  "CopyStmt",
  "DoStmt",
  "ViewStmt",
  "IndexStmt",
  "RuleStmt",
  "RefreshMatViewStmt",
]);

export function writesRequireApproval(): Rule {
  let writeFound: string | null = null;

  return {
    name: PolicyRule.WRITES_REQUIRE_APPROVAL,
    reset() {
      writeFound = null;
    },
    visit(_node: unknown, kind: string | null, _scope: VisitorScope) {
      if (kind && WRITE_KINDS.has(kind) && writeFound === null) {
        writeFound = kind;
      }
    },
    finalize(rctx: RuleEvalContext): RuleVerdict {
      if (!rctx.parse.ok) return { decision: "ALLOW" };
      if (writeFound !== null) {
        return { decision: "DENY", reason: PolicyRule.WRITES_REQUIRE_APPROVAL };
      }
      return { decision: "ALLOW" };
    },
  };
}
