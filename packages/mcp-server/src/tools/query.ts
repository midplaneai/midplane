// query tool — main MCP entrypoint for arbitrary SQL.
//
// Pipeline: parse → policy → audit → execute is all owned by engine.handle().
// We translate Decision into MCP tool content; AuditUnavailableError bubbles
// to the transport layer (where the SDK surfaces it as an MCP error response).

import { z } from "zod";
import type { Engine, EngineContext } from "@midplane/engine";

export const QueryInputSchema = {
  sql: z
    .string()
    .min(1, "sql cannot be empty")
    .max(1_048_576, "sql exceeds 1 MiB"),
};

export interface QueryArgs {
  sql: string;
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
