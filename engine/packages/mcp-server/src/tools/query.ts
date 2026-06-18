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
  const decision = await input.engine.handle({
    sql: input.args.sql,
    ctx: input.ctx,
    intent: input.args.intent,
  });

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
