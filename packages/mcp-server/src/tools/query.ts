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

import { z } from "zod";
import type { Engine, EngineContext } from "@midplane/engine";

const SqlSchema = z
  .string()
  .min(1, "sql cannot be empty")
  .max(1_048_576, "sql exceeds 1 MiB");

export const QueryInputSchema = {
  sql: SqlSchema,
};

export interface QueryArgs {
  sql: string;
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
  };
}

export interface QueryMultiArgs {
  database: string;
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
