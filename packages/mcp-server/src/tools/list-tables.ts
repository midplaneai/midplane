// list_tables tool — canned information_schema.tables query, routed through
// engine.handle() so audit + policy still record the call. Both `table_access`
// and `tenant_scope` carve out `information_schema` unconditionally, so
// discovery works under default-deny / strict-mode policies.
//
// Multi-DB shape: optional `database` arg. Omitted = fan out across all
// configured DBs and group rows by DB name. Each leg of the fan-out is a
// real engine.handle() call so it gets its own audit row.

import { z } from "zod";
import type { Engine, EngineContext } from "@midplane/engine";
import type { ToolResult } from "./query.ts";
import type { EngineRegistry } from "../engine-factory.ts";

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export const ListTablesInputSchema = {
  schema: z.string().regex(IDENT).optional(),
};

export interface ListTablesArgs {
  schema?: string;
}

export function ListTablesMultiInputSchema<T extends [string, ...string[]]>(
  dbEnum: z.ZodEnum<{ [K in T[number]]: K }>,
) {
  return {
    database: dbEnum.optional(),
    schema: z.string().regex(IDENT).optional(),
  };
}

export interface ListTablesMultiArgs {
  database?: string;
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

  const decision = await input.engine.handle({
    sql,
    ctx: input.ctx,
    intent: null,
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

// Fan-out: list_tables across every DB in the registry, in parallel.
// Result groups tables by DB name. Per-DB failures land under
// `databases[name].error` so a single bad DB doesn't kill the call —
// the agent gets actionable per-DB results either way.
export async function handleListTablesAcrossAll(input: {
  registry: EngineRegistry;
  ctxFor: (db: string) => EngineContext;
  args: { schema?: string };
  recordToolCall?: (db: string, allowed: boolean) => void;
}): Promise<ToolResult> {
  const schema = input.args.schema ?? "public";
  if (!IDENT.test(schema)) {
    throw new Error(`Invalid schema identifier: ${schema}`);
  }
  const names = input.registry.names();

  const settled = await Promise.all(
    names.map(async (db) => {
      const entry = input.registry.get(db);
      let allowed = false;
      try {
        const result = await handleListTables({
          engine: entry.engine,
          ctx: input.ctxFor(db),
          args: { schema },
        });
        const data = JSON.parse(result.content[0]!.text) as
          | { allowed: true; tables: Array<{ schema: string; name: string }>; auditId: string }
          | { allowed: false; policy_rule: string; auditId: string };
        allowed = !result.isError;
        return { db, ok: true as const, data, isError: !!result.isError };
      } catch (err) {
        return {
          db,
          ok: false as const,
          error: (err as Error).message,
          isError: true as const,
        };
      } finally {
        input.recordToolCall?.(db, allowed);
      }
    }),
  );

  const databases: Record<string, unknown> = {};
  for (const r of settled) {
    if (r.ok) {
      databases[r.db] = r.data;
    } else {
      databases[r.db] = { allowed: false, error: r.error };
    }
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ databases }),
      },
    ],
  };
}
