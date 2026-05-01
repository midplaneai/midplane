// describe_table tool — canned information_schema.columns query for a
// specific table. Identifier regex enforced BEFORE the SQL string is built.
//
// Multi-DB shape: required `database` enum arg. Cross-DB ambiguity on a
// schema lookup is a footgun; we always require the operator to name the
// target DB.

import { z } from "zod";
import type { AgentIntent, Engine, EngineContext } from "@midplane/engine";
import type { ToolResult } from "./query.ts";

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export const DescribeTableInputSchema = {
  table: z.string().regex(IDENT),
  schema: z.string().regex(IDENT).optional(),
};

export interface DescribeTableArgs {
  table: string;
  schema?: string;
}

export function DescribeTableMultiInputSchema<T extends [string, ...string[]]>(
  dbEnum: z.ZodEnum<{ [K in T[number]]: K }>,
) {
  return {
    database: dbEnum,
    table: z.string().regex(IDENT),
    schema: z.string().regex(IDENT).optional(),
  };
}

export interface DescribeTableMultiArgs {
  database: string;
  table: string;
  schema?: string;
}

export async function handleDescribeTable(input: {
  engine: Engine;
  ctx: EngineContext;
  args: DescribeTableArgs;
  intent?: AgentIntent | null;
}): Promise<ToolResult> {
  const table = input.args.table;
  const schema = input.args.schema ?? "public";

  if (!IDENT.test(table)) {
    throw new Error(`Invalid table identifier: ${table}`);
  }
  if (!IDENT.test(schema)) {
    throw new Error(`Invalid schema identifier: ${schema}`);
  }

  // Embedded literals are safe: both have passed strict identifier regex.
  const sql =
    `SELECT column_name, data_type, is_nullable, column_default ` +
    `FROM information_schema.columns ` +
    `WHERE table_schema = '${schema}' AND table_name = '${table}' ` +
    `ORDER BY ordinal_position`;

  const decision = await input.engine.handle({
    sql,
    ctx: input.ctx,
    intent: input.intent ?? null,
  });

  if (!decision.allowed) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            allowed: false,
            policy_rule: decision.reason,
            auditId: decision.auditId,
          }),
        },
      ],
    };
  }

  const columns = (
    decision.result.rows as Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>
  ).map((r) => ({
    name: r.column_name,
    type: r.data_type,
    nullable: r.is_nullable === "YES",
    default: r.column_default,
  }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ allowed: true, columns, auditId: decision.auditId }),
      },
    ],
  };
}
