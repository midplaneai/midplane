// Write approvals — hold a write the policy already permits until a human says yes.
//
// See docs/designs/write-approvals-mlp.md. The short version:
//
//   • The engine decides WHETHER to ask (a boolean and a write-target check).
//     The control plane decides the ANSWER. This module is the seam.
//   • Approvals sit UNDER the policy, never over it. The stage runs only after
//     evaluate() has already returned ALLOW, so an approval can never resurrect
//     a statement a guardrail or table_access refused. There is no path from
//     "denied" to "approved".
//   • Deliberately no row estimate. An earlier design routed on EXPLAIN row
//     counts and had to carry a post-execution rowCount guard, stale-statistics
//     escalation, and per-table bands to contain an estimator that errs LOW by
//     up to 400,000x. Holding every write has nothing to estimate.
//
// The gate is injected (like AuditWriter and Executor) so the engine package
// stays dependency-free and an embedder can supply its own.

import { ApprovalUnavailableError } from "./errors.ts";

/** What the engine needs a human to rule on. Everything here is already known
 *  by the time policy has returned ALLOW — the gate adds no parsing. */
export interface ApprovalRequest {
  /** Correlates with the ATTEMPTED audit row for this attempt. */
  queryId: string;
  /** Engine-side database alias (the agent-facing name, never a DSN). */
  database: string;
  /** The statement verbatim. The control plane binds the grant to it. */
  sql: string;
  /** Agent's stated reason, as supplied to the query tool. */
  intent: string;
  statementType: string;
  /** Every relation the statement touches, for the approver's context. */
  tablesTouched: string[];
  tenantId: string | null;
  agentName: string | null;
  agentVersion: string | null;
  mcpTokenId: string | null;
}

/** The gate's answer.
 *
 *  `approved` carries the deciding human so the engine can attribute the
 *  execution. `denied` carries their note, which reaches the agent — a denial
 *  that says "use the refunds table instead" is worth far more than a refusal.
 *  `pending` means nobody has ruled yet; the engine turns it into an
 *  ApprovalPendingError and the agent re-runs to collect. */
export type ApprovalOutcome =
  | { status: "approved"; by: string | null; note: string | null }
  | { status: "denied"; by: string | null; note: string | null }
  | { status: "expired" }
  | { status: "pending"; approvalId: string; expiresAt: number; reviewUrl?: string };

/** Read-only answer for `check_approval`. `executed` means the grant was
 *  already consumed — the agent ran this once and re-running would ask again,
 *  which is the difference that stops it from silently opening a duplicate. */
export type ApprovalStatus =
  | { status: "pending"; expiresAt: number }
  | { status: "approved"; by: string | null; note: string | null }
  | { status: "executed" }
  /** The grant was consumed but no EXECUTED audit row confirms the outcome —
   *  the claim happens before execution, so a statement can still fail in
   *  Postgres afterwards. Distinct from `executed` because telling an agent a
   *  write landed when it may not have is the worst answer this can give. */
  | { status: "consumed" }
  | { status: "denied"; by: string | null; note: string | null }
  | { status: "expired" }
  | { status: "not_found" };

export interface ApprovalGate {
  /** Ask for a decision. Implementations MAY block for a bounded window before
   *  answering `pending` — the engine does not impose one, but the caller's
   *  transport does, so an implementation that blocks past an MCP client's
   *  timeout is a bug in the implementation.
   *
   *  Throw ApprovalUnavailableError for infrastructure failure. Never return
   *  `denied` to mean "I couldn't ask" — that would manufacture a refusal
   *  nobody made. */
  request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome>;

  /** Status of one approval, WITHOUT claiming it.
   *
   *  Optional so an embedder with a simpler gate stays valid; the tool is only
   *  registered when a gate implements it. Scoped by `mcpTokenId` — the engine
   *  speaks for a project, not for one agent inside it, so the caller's token
   *  is what limits which requests it can see. */
  check?(
    approvalId: string,
    mcpTokenId: string | null,
    signal?: AbortSignal,
  ): Promise<ApprovalStatus>;
}

/** The gate used when a policy enables approvals but nothing was injected.
 *
 *  Fails closed, and does so as an ERROR rather than a denial: a missing gate
 *  is a deployment fault, not a human's judgement, and the two must not look
 *  alike in the audit log. The mcp-server refuses to boot in this state anyway
 *  (MIDPLANE_APPROVAL_URL and _TOKEN are required together); this exists so an
 *  embedder that wires approvals without a gate cannot silently run writes. */
export const REFUSING_APPROVAL_GATE: ApprovalGate = {
  async request(): Promise<ApprovalOutcome> {
    throw new ApprovalUnavailableError(
      "policy requires approval for writes but no approval gate is configured — refusing to execute",
    );
  },
};

/** Engine-side approval settings, mirroring the `approvals:` policy block.
 *  All-off = the stage never runs and costs nothing.
 *
 *  Per write class rather than one flag, so "ask a human" is a value of the
 *  same rule that refuses and allows: holding schema changes should not force
 *  an operator to hold every UPDATE. A statement carrying more than one class
 *  is held if ANY of its classes is set. */
export interface ApprovalConfig {
  /** WHERE-qualified INSERT / UPDATE / DELETE / MERGE, and CREATE-family
   *  writes — everything that changes rows rather than the schema. */
  rowChanges: boolean;
  /** DELETE / UPDATE with no WHERE clause. */
  wholeTableWrites: boolean;
  /** DROP / TRUNCATE / ALTER. */
  schemaChanges: boolean;
}

/** Nothing held. The shape an embedder that never heard of approvals gets. */
export const NO_APPROVALS: ApprovalConfig = {
  rowChanges: false,
  wholeTableWrites: false,
  schemaChanges: false,
};
