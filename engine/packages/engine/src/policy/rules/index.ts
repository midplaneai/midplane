// Rule interface. Each rule reads the dialect-produced NormalizedProgram and
// emits a single verdict. Rules are stateless and dialect-blind — all AST
// traversal happens in the dialect's normalize(); the rules never see an AST.

import type { ParseResult } from "../../dialects/postgres/parse.ts";
import type { NormalizedProgram } from "../../ir/types.ts";

export interface EngineContextLike {
  tenant_id: string;
  agent_name: string | null;
  agent_version: string | null;
  role?: string;
  // tenant_scope is opt-in per-call context. Two shapes accepted:
  //   • legacy flat `mappings` (pre-0.5.0 fixtures, still works)
  //   • rich shape with `defaultColumn` / `overrides` / `exempt` (0.5.0+)
  // Production wires this via the `tenantScope()` source argument; the
  // ctx fallback exists for older tests that don't construct a holder.
  tenant_scope?: {
    mappings?: Record<string, string>;
    defaultColumn?: string | null;
    overrides?: Record<string, string>;
    exempt?: string[];
  };
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

export interface Rule {
  readonly name: string;

  // Emit a verdict from the dialect-agnostic IR. The sole verdict path: no AST,
  // no walk, no per-query reset (rules hold no per-query state).
  evaluateIR(program: NormalizedProgram, rctx: RuleEvalContext): RuleVerdict;
}
