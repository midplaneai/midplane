// Rule interface. Each rule walks the AST via the shared visitor and
// finalizes a verdict after the walk completes. Rules accumulate state
// during the walk (e.g. write-nodes seen, tables-without-scope) and emit
// a single verdict at the end.

import type { ParseResult } from "../../parser/parse.ts";
import type { VisitorRule, VisitorScope } from "../visitor.ts";

export interface EngineContextLike {
  tenant_id: string;
  agent_name: string | null;
  agent_version: string | null;
  role?: string;
  tenant_scope?: { mappings: Record<string, string> };
}

export interface RuleEvalContext {
  parse: ParseResult;
  ctx: EngineContextLike;
}

export type RuleVerdict =
  | { decision: "ALLOW" }
  | {
      decision: "DENY";
      reason: string; // rule name (e.g. "table_access") — wire-level identifier
      // Optional polished, agent-facing sentence. When present, the engine
      // uses it verbatim for both the audit DECIDED `reason` field and the
      // MCP tool's user-facing message. When absent, the engine falls back
      // to a generic sentence keyed off the rule name.
      message?: string;
    };

export interface Rule extends VisitorRule {
  readonly name: string;

  // Called once before each engine.handle() so stateful rules can reset
  // accumulators between queries. Rule instances are reused across calls.
  reset(rctx: RuleEvalContext): void;

  // Called by the visitor for every node — inherited from VisitorRule.
  visit?(node: unknown, kind: string | null, scope: VisitorScope): void;

  // Called after the walk. Emits final verdict.
  finalize(rctx: RuleEvalContext): RuleVerdict;
}
