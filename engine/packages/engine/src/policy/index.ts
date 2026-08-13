// Policy module — orchestrates the single-walk visitor + rule callbacks +
// finalization.

import type { ParseResult } from "../dialects/postgres/parse.ts";
import { postgresDialect } from "../dialects/postgres/index.ts";
import type { Dialect } from "../dialects/types.ts";
import type { NormalizedProgram } from "../ir/types.ts";
import type { Rule, RuleEvalContext, RuleVerdict } from "./rules/index.ts";

export type { Rule, RuleVerdict, RuleEvalContext } from "./rules/index.ts";
export { tableAccess, resolveTableAccessForName } from "./rules/table-access.ts";
export type {
  TableAccessConfig,
  TableAccessLevel,
  TableAccessResolution,
} from "./rules/table-access.ts";
export { multiStatement } from "./rules/multi-statement.ts";
export { tenantScope, resolveTenantColumn } from "./rules/tenant-scope.ts";
export type { TenantScopeConfig, TenantScopeSource } from "./rules/tenant-scope.ts";
export { dangerousStatement } from "./rules/dangerous-statement.ts";
export type {
  DangerousStatementConfig,
  DangerousStatementSource,
} from "./rules/dangerous-statement.ts";
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

/** The three classes of write a policy states a rule for. One statement can
 *  carry more than one (a CTE that deletes rows under a top-level whole-table
 *  update), which is why the evaluator reports a set rather than a winner. */
export type WriteClass =
  | "row_changes"
  | "whole_table_writes"
  | "schema_changes";

export interface EvaluateResult {
  verdict: RuleVerdict;
  statementType: string | null;
  tablesTouched: string[];
  // True when the statement writes to at least one relation — the trigger for
  // write approvals.
  //
  // Read from the SAME accessChecks sequence table_access replays, not from
  // statementType, and that is the point: `WITH d AS (DELETE FROM orders …)
  // SELECT count(*) FROM d` has auditStatementType "SELECT" and would sail past
  // a keyword check while deleting rows. Because the adapter emits a write
  // check for every write-target node anywhere in the tree (CTEs and
  // subqueries included), this cannot drift from the permission decision.
  hasWriteTarget: boolean;
  // Which write classes this statement contains, for the approval stage. Every
  // class present is reported, and the stage holds if ANY of them is set to
  // ask — a statement that both changes rows and alters the schema must not
  // slip through because only one of the two is held.
  //
  // A write with no site at all (CREATE TABLE, CREATE TABLE AS, CREATE INDEX)
  // reports "row_changes". Those are not refusable — no guardrail emits a site
  // for them — but they ARE writes, and letting them fall out of the classified
  // set would silently stop holding statements a single `writes: true` used to
  // hold.
  writeClasses: WriteClass[];
}

// Evaluates all rules in a single AST walk.
//
// Rule evaluation order on DENY: the rule list is checked in array order;
// the first DENY verdict wins. Order parse_error → multi_statement →
// table_access → tenant_scope → dangerous_statement so the most-specific
// failure surfaces (the destructive-op guardrail runs last and only adds
// denials for statements every other rule permitted).
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

  const hasWriteTarget = program.accessChecks.some((c) => c.kind === "write");
  return {
    verdict,
    // Audit statement_type + tables_touched come straight from the IR (the
    // dialect's normalize computes them). Proven byte-identical to the former
    // inline AST accumulator by the IR-equivalence harness before the cut-over.
    statementType: program.auditStatementType,
    tablesTouched: program.allRelnames,
    hasWriteTarget,
    writeClasses: classifyWriteClasses(program, hasWriteTarget),
  };
}

// Which write classes a program contains. Reads the same site list the
// guardrail rule replays, so "what may be refused" and "what may be held" can
// never disagree about what a statement is.
function classifyWriteClasses(
  program: NormalizedProgram,
  hasWriteTarget: boolean,
): WriteClass[] {
  const classes = new Set<WriteClass>();
  for (const d of program.dangerousStatements) {
    if (d.kind === "row_dml") classes.add("row_changes");
    else if (d.kind === "unqualified_dml") classes.add("whole_table_writes");
    else classes.add("schema_changes");
  }
  // A write the dialect emitted no site for is still a write (CREATE TABLE and
  // friends). Classify it as a row change so it stays inside the approval
  // stage's reach; nothing refuses it, because refusal reads sites, not this.
  if (classes.size === 0 && hasWriteTarget) classes.add("row_changes");
  return [...classes];
}

// Input for a parse failure: no AST, nothing to normalize. parse_error denies;
// every other rule short-circuits ALLOW on !parse.ok, so the contents are inert.
const EMPTY_PROGRAM: NormalizedProgram = {
  statementCount: 0,
  auditStatementType: null,
  allRelnames: [],
  accessChecks: [],
  scopeUnits: [],
  dangerousStatements: [],
  unsupported: [],
};
