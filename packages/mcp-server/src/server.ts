// Builds an McpServer with the three V1 tools registered. Pure construction —
// no listen/connect side effects (those live in transport/*).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EngineHandle } from "./engine-factory.ts";
import {
  QueryInputSchema,
  handleQuery,
  type QueryArgs,
} from "./tools/query.ts";
import {
  ListTablesInputSchema,
  handleListTables,
  type ListTablesArgs,
} from "./tools/list-tables.ts";
import {
  DescribeTableInputSchema,
  handleDescribeTable,
  type DescribeTableArgs,
} from "./tools/describe-table.ts";

export interface BuildServerOptions {
  handle: EngineHandle;
  agentIdentity?: () => string | null;
}

export function buildServer(opts: BuildServerOptions): McpServer {
  const server = new McpServer({
    name: "midplane-mcp-server",
    version: "0.0.1",
  });

  const ctx = () => ({
    ...opts.handle.ctxBase,
    agent_identity: opts.agentIdentity?.() ?? opts.handle.ctxBase.agent_identity,
  });

  server.registerTool(
    "query",
    {
      title: "Run a SQL query against the configured Postgres database",
      description:
        "Parses the SQL with libpg_query, applies Midplane policy (writes_require_approval, multi_statement, tenant_scope, parse_error), audits the call, and returns rows on ALLOW. Denials return policy_rule + reason; the call is still audited.",
      inputSchema: QueryInputSchema,
    },
    async (args: QueryArgs) =>
      handleQuery({ engine: opts.handle.engine, ctx: ctx(), args }),
  );

  server.registerTool(
    "list_tables",
    {
      title: "List tables in a Postgres schema",
      description:
        "Routed through the same policy + audit pipeline. Defaults to the 'public' schema.",
      inputSchema: ListTablesInputSchema,
    },
    async (args: ListTablesArgs) =>
      handleListTables({ engine: opts.handle.engine, ctx: ctx(), args }),
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe columns of a Postgres table",
      description:
        "Returns column name, data type, nullability, and default. Routed through the policy + audit pipeline.",
      inputSchema: DescribeTableInputSchema,
    },
    async (args: DescribeTableArgs) =>
      handleDescribeTable({ engine: opts.handle.engine, ctx: ctx(), args }),
  );

  return server;
}
