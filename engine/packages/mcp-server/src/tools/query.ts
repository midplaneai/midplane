// query tool — main MCP entrypoint for arbitrary SQL.
//
// Pipeline: parse → policy → audit → execute is all owned by engine.handle().
// We translate Decision into MCP tool content; AuditUnavailableError bubbles
// to the transport layer (where the SDK surfaces it as an MCP error response).
//
// Two zod schemas live here: the single-DB shape (no `database` arg, used
// when the registry has exactly one DB) and a builder for the multi-DB
// shape (required `database` enum, built per-server because the enum
// values come from the registry's names).
//
// `intent` is a required structured field (0.4.0). It carries the agent's
// per-call free-text task description straight from the MCP tool args
// through to every audit row. No comment-parsing, no header sniffing,
// no _meta channel — just one declared field on the tool's JSON schema
// the LLM can be relied on to fill.

import { z } from "zod";
import type { Engine, EngineContext } from "@midplane/engine";
import { ApprovalPendingError, ApprovalUnavailableError } from "@midplane/engine";

const SqlSchema = z
  .string()
  .min(1, "sql cannot be empty")
  .max(1_048_576, "sql exceeds 1 MiB");

// Required, ≤ 500 chars to match the audit-row column. The description is
// what the LLM reads — calibrated to nudge it toward a 1-sentence "why"
// rather than restating the SQL.
//
// Sanitizes before length-checking: strips control chars (0x00-0x1F + 0x7F,
// including tab/LF/CR — intent renders as a single audit-log cell, not a
// multi-line block) and trims surrounding whitespace. Rejects values that
// are blank or control-only AFTER sanitization so an agent passing `" "`
// or `"\n\t"` doesn't stamp a non-null-but-useless `agent_intent` on
// every audit row. The sanitized value is what flows to the audit
// pipeline, so leading/trailing whitespace never reaches storage.
const IntentSchema = z
  .string()
  .max(500, "intent exceeds 500 chars")
  .transform((v) => v.replace(/[\x00-\x1f\x7f]/g, "").trim())
  .refine((v) => v.length > 0, {
    message:
      "intent must contain non-whitespace, non-control characters (got blank or control-only string)",
  })
  .describe(
    "Brief (≤ 1 sentence) statement of WHY this query is being run — e.g., \"confirm seed data after migration\" or \"investigate slow user lookup\". Visible in audit logs for human review. State the goal, not what the SQL does.",
  );

export const QueryInputSchema = {
  sql: SqlSchema,
  intent: IntentSchema,
};

export interface QueryArgs {
  sql: string;
  intent: string;
}

// Builder for the multi-DB shape. `dbEnum` is built by the server from the
// registry's names — keeping this a function (not a constant) ensures the
// enum values match the live engine count.
export function QueryMultiInputSchema<T extends [string, ...string[]]>(
  dbEnum: z.ZodEnum<{ [K in T[number]]: K }>,
) {
  return {
    database: dbEnum,
    sql: SqlSchema,
    intent: IntentSchema,
  };
}

export interface QueryMultiArgs {
  database: string;
  sql: string;
  intent: string;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export async function handleQuery(input: {
  engine: Engine;
  ctx: EngineContext;
  args: QueryArgs;
}): Promise<ToolResult> {
  let decision;
  try {
    decision = await input.engine.handle({
      sql: input.args.sql,
      ctx: input.ctx,
      intent: input.args.intent,
    });
  } catch (err) {
    // Write approvals raise rather than return, because neither state is a
    // DECISION (see engine/src/errors.ts). But a thrown error reaches the agent
    // as its `message` and nothing else — the SDK discards the instance — so
    // rendering them here is the only way the approval id, the deadline and the
    // review URL survive the MCP boundary.
    const held = approvalHoldResult(err, input.args);
    if (held) return held;
    throw err;
  }

  if (decision.allowed) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            allowed: true,
            rows: decision.result.rows,
            rowCount: decision.result.rowCount,
            auditId: decision.auditId,
          }),
        },
      ],
    };
  }

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          allowed: false,
          policy_rule: decision.reason,
          reason: decision.message,
          auditId: decision.auditId,
        }),
      },
    ],
  };
}

// Render the two approval non-decisions as structured tool output, matching the
// shape a denial gets so an agent can branch on one JSON contract.
//
// `isError: true` on both: nothing ran, and an agent that treats this as success
// would report a write it never performed. `retryable` distinguishes them —
// pending means a human has to act, unavailable means the control plane blinked
// and the same call may well succeed shortly.
function approvalHoldResult(
  err: unknown,
  args: { sql: string; intent: string },
): ToolResult | null {
  if (err instanceof ApprovalPendingError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            allowed: false,
            status: "awaiting_approval",
            policy_rule: "approval_pending",
            // Stated flatly and first. An agent that skims this and reports
            // success to its user has done the worst possible thing here:
            // claimed a write happened that did not.
            executed: false,
            reason: err.message,
            approval_id: err.details.approvalId,
            expires_at: new Date(err.details.expiresAt).toISOString(),
            ...(err.details.reviewUrl ? { review_url: err.details.reviewUrl } : {}),
            retryable: true,
            // The resume contract, spelled out and CARRYING ITS OWN INPUTS.
            //
            // The grant is keyed on (database, sql, intent, token), so a retry
            // that differs by one character — in EITHER field — opens a second
            // request instead of collecting the first. Telling the agent to
            // "re-run the identical statement" while making it reconstruct that
            // statement from memory is a trap; handing both strings back closes
            // it.
            resume: {
              instructions:
                "This write has NOT run yet. Do not report it as done. Track it as an open task: poll check_approval with this approval_id, and when it returns \"approved\", call query again passing the sql and intent below EXACTLY as given. Polling is cheap and does not consume the approval; calling query again is what executes it.",
              tool: "check_approval",
              sql: args.sql,
              intent: args.intent,
              warning:
                "sql and intent must match byte-for-byte. Any difference is treated as a different request and will need its own approval.",
            },
          }),
        },
      ],
    };
  }
  if (err instanceof ApprovalUnavailableError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            allowed: false,
            executed: false,
            status: "approval_unavailable",
            policy_rule: "approval_unavailable",
            // Deliberately NOT phrased as a refusal: nobody denied this write.
            reason:
              "This write needs human approval, but the approval service could not be reached. Nothing was executed and nothing was denied — try again.",
            retryable: true,
          }),
        },
      ],
    };
  }
  return null;
}
