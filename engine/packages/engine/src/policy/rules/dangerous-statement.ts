// dangerous_statement rule (guardrails).
//
// Blocks categorically-destructive operations REGARDLESS of table_access /
// tenant_scope policy — the "an agent can't nuke prod" safety net. Two
// independently-toggled guards:
//   • block_unqualified_dml — DELETE/UPDATE with no WHERE clause (whole-table
//     write).
//   • block_ddl             — DROP / TRUNCATE / ALTER (schema-changing DDL).
//
// Consumes the dialect-agnostic IR (NormalizedProgram.dangerousStatements) — a
// DFS-ordered list of destructive sites the dialect's normalize() surfaced
// (including DELETE/UPDATE nested in CTEs). The rule replays the sequence and
// denies on the FIRST site whose guardrail is enabled, so the surfaced message
// names a specific operation. All AST traversal lives in the adapter; this rule
// is dialect-blind, like every other rule.
//
// Ordering: wired LAST in the chain (after table_access + tenant_scope) so that
// when a more-specific rule would also deny, that rule's reason surfaces; this
// rule only adds NEW denials for statements every other rule permitted. The
// "regardless of table policy" guarantee holds either way — the guard fires even
// when a table is marked read_write.
//
// Default posture is set by the wiring, not the rule: an undefined source is
// inert (the engine-library default — an embedder that doesn't wire guardrails
// gets none). The server (@midplane/mcp-server) defaults the YAML `guardrails`
// section to ON, so a self-host deployment is protected out of the box.

import type { Rule, RuleEvalContext, RuleVerdict } from "./index.ts";
import type { DangerousStatement, NormalizedProgram } from "../../ir/types.ts";
import { PolicyRule } from "../../audit/types.ts";

// Which destructive operations are blocked. Both flags independent so an
// operator can keep DDL blocked while allowing intentional whole-table DML, or
// vice versa.
export interface DangerousStatementConfig {
  blockUnqualifiedDml: boolean;
  blockDdl: boolean;
}

// Accepts a static config, a getter (used by the mcp-server to hot-swap via the
// policy holder — the rule reads the pointer once per query), or undefined
// (inert: no guardrails). Mirrors tableAccess's source shape.
export type DangerousStatementSource =
  | DangerousStatementConfig
  | (() => DangerousStatementConfig | undefined)
  | undefined;

export function dangerousStatement(source?: DangerousStatementSource): Rule {
  const resolveConfig = (): DangerousStatementConfig | undefined =>
    typeof source === "function" ? source() : source;
  return {
    name: PolicyRule.DANGEROUS_STATEMENT,
    evaluateIR(program: NormalizedProgram, rctx: RuleEvalContext): RuleVerdict {
      if (!rctx.parse.ok) return { decision: "ALLOW" }; // parse_error owns this case
      const cfg = resolveConfig();
      if (!cfg) return { decision: "ALLOW" }; // not wired ⇒ inert
      if (!cfg.blockUnqualifiedDml && !cfg.blockDdl) return { decision: "ALLOW" };
      for (const d of program.dangerousStatements) {
        if (d.kind === "unqualified_dml" && cfg.blockUnqualifiedDml) {
          return denyUnqualifiedDml(d);
        }
        if (d.kind === "ddl" && cfg.blockDdl) {
          return denyDdl(d);
        }
      }
      return { decision: "ALLOW" };
    },
  };
}

function denyUnqualifiedDml(
  d: Extract<DangerousStatement, { kind: "unqualified_dml" }>,
): RuleVerdict {
  return {
    decision: "DENY",
    reason: PolicyRule.DANGEROUS_STATEMENT,
    message:
      `Midplane denied this query because this ${d.operation} on ` +
      `\`${d.table}\` has no WHERE clause, which would affect every row in ` +
      `the table. Add a WHERE clause that scopes the rows you intend to ` +
      `change. This guardrail blocks whole-table writes regardless of ` +
      `table-access policy; set \`guardrails.block_unqualified_dml: false\` ` +
      `in your policy YAML to disable it.`,
  };
}

function denyDdl(d: Extract<DangerousStatement, { kind: "ddl" }>): RuleVerdict {
  return {
    decision: "DENY",
    reason: PolicyRule.DANGEROUS_STATEMENT,
    message:
      `Midplane denied this query because \`${d.operation}\` is a ` +
      `schema-changing (DDL) operation, which Midplane blocks regardless of ` +
      `table-access policy. Set \`guardrails.block_ddl: false\` in your ` +
      `policy YAML to allow DROP/TRUNCATE/ALTER.`,
  };
}
