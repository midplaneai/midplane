// list_tables tool — canned information_schema.tables query, routed through
// engine.handle() so audit + policy still record the call (table_access
// has an unconditional carve-out for information_schema so this works under
// default-deny policies too; tenant_scope mappings shouldn't include it).

import { z } from "zod";
import type { Engine, EngineContext } from "@midplane/engine";
import type { ToolResult } from "./query.ts";

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export const ListTablesInputSchema = {
  schema: z.string().regex(IDENT).optional(),
};

export interface ListTablesArgs {
  schema?: string;
}

export async function handleListTables(input: {
  engine: Engine;
  ctx: EngineContext;
  args: ListTablesArgs;
}): Promise<ToolResult> {
  const schema = input.args.schema ?? "public";
  if (!IDENT.test(schema)) {
    throw new Error(`Invalid schema identifier: ${schema}`);
  }

  // Embedded literal is safe: schema has passed strict identifier regex.
  const sql = `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = '${schema}' ORDER BY table_name`;

  const decision = await input.engine.handle({ sql, ctx: input.ctx });

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

  const tables = (decision.result.rows as Array<{ table_schema: string; table_name: string }>).map(
    (r) => ({ schema: r.table_schema, name: r.table_name }),
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ allowed: true, tables, auditId: decision.auditId }),
      },
    ],
  };
}
