// dangerous_statement rule (guardrails).
//
// Refuses a class of write REGARDLESS of table_access / tenant_scope policy —
// the "an agent can't nuke prod" safety net. Three independently-toggled
// guards, one per write class:
//   • block_dml             — INSERT / MERGE / WHERE-qualified UPDATE / DELETE
//     (a row-scoped change), AND any other write the dialect emits no site for
//     (CREATE TABLE / CREATE TABLE AS / SELECT … INTO). Default OFF; the other
//     two default ON. It must reach exactly what the approval stage classifies
//     as a row change, or moving the rule from Ask to Refuse would permit more.
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

// Which write classes are refused. All three flags independent so an operator
// can keep DDL blocked while allowing intentional whole-table DML, or vice
// versa. `blockDml` is optional so an embedder written against the two-flag
// shape still compiles and keeps its exact posture (undefined ⇒ off).
export interface DangerousStatementConfig {
  blockUnqualifiedDml: boolean;
  blockDdl: boolean;
  blockDml?: boolean;
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
      if (!cfg.blockUnqualifiedDml && !cfg.blockDdl && !cfg.blockDml) {
        return { decision: "ALLOW" };
      }
      for (const d of program.dangerousStatements) {
        if (d.kind === "row_dml" && cfg.blockDml) {
          return denyDml(d);
        }
        if (d.kind === "unqualified_dml" && cfg.blockUnqualifiedDml) {
          return denyUnqualifiedDml(d);
        }
        if (d.kind === "ddl" && cfg.blockDdl) {
          return denyDdl(d);
        }
      }
      // A write the dialect emitted no site for — CREATE TABLE, CREATE TABLE
      // AS, CREATE INDEX, SELECT … INTO. It is a write, and the approval stage
      // already classifies it as a row change (policy/index.ts), so refusal has
      // to reach it too. Otherwise moving row changes from Ask to the stricter
      // Refuse would let these EXECUTE where they had been held for a human —
      // a stricter setting permitting strictly more, which is the one thing a
      // three-way control must never do.
      //
      // Guarded on there being no sites at all, mirroring the classifier: a
      // no-WHERE DELETE is a whole-table write and must not be refused by the
      // row-change flag.
      if (
        cfg.blockDml &&
        program.dangerousStatements.length === 0 &&
        program.accessChecks.some((c) => c.kind === "write")
      ) {
        return denyBareWrite();
      }
      return { decision: "ALLOW" };
    },
  };
}

function denyBareWrite(): RuleVerdict {
  return {
    decision: "DENY",
    reason: PolicyRule.DANGEROUS_STATEMENT,
    message:
      `Midplane denied this query because it writes, and this database ` +
      `refuses writes regardless of table-access policy. That covers ` +
      `creating a relation (\`CREATE TABLE\`, \`CREATE TABLE AS\`, ` +
      `\`SELECT … INTO\`), which materializes data just as a row change ` +
      `does. Reads are unaffected. Set \`guardrails.block_dml: false\` in ` +
      `your policy YAML to allow writes.`,
  };
}

function denyDml(
  d: Extract<DangerousStatement, { kind: "row_dml" }>,
): RuleVerdict {
  return {
    decision: "DENY",
    reason: PolicyRule.DANGEROUS_STATEMENT,
    message:
      `Midplane denied this query because \`${d.operation}\` on ` +
      `\`${d.table}\` changes rows, and this database refuses row changes ` +
      `regardless of table-access policy. Reads are unaffected. Set ` +
      `\`guardrails.block_dml: false\` in your policy YAML to allow row ` +
      `changes.`,
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
