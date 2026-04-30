// Builds an McpServer with the three V1 tools registered. Pure construction —
// no listen/connect side effects (those live in transport/*).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EngineHandle } from "./engine-factory.ts";
import type { TelemetryHandle } from "./telemetry/index.ts";
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
  telemetry?: TelemetryHandle;
}

const NOOP_TELEMETRY: TelemetryHandle = {
  wrap: (w) => w,
  recordToolCall: () => {},
  async shutdown() {},
};

export function buildServer(opts: BuildServerOptions): McpServer {
  const server = new McpServer({
    name: "midplane-mcp-server",
    version: "0.0.1",
  });

  const telemetry = opts.telemetry ?? NOOP_TELEMETRY;

  const ctx = () => ({
    ...opts.handle.ctxBase,
    agent_identity: opts.agentIdentity?.() ?? opts.handle.ctxBase.agent_identity,
  });

  // Tool handlers wrap their engine call in try/finally so the per-tool
  // counter is recorded on every exit path — including the case where the
  // engine rethrows a Postgres execution error (audited as FAILED). A
  // throw counts as a deny so tools.{name}.calls/allow/deny stays
  // consistent with exec_failures.count in the same heartbeat window.

  server.registerTool(
    "query",
    {
      title: "Run a SQL query against the configured Postgres database",
      description:
        "Parses the SQL with libpg_query, applies Midplane policy (table_access, multi_statement, tenant_scope, parse_error), audits the call, and returns rows on ALLOW. Denials return policy_rule + reason; the call is still audited.",
      inputSchema: QueryInputSchema,
    },
    async (args: QueryArgs) => {
      let allowed = false;
      try {
        const result = await handleQuery({ engine: opts.handle.engine, ctx: ctx(), args });
        allowed = !result.isError;
        return result;
      } finally {
        telemetry.recordToolCall("query", allowed);
      }
    },
  );

  server.registerTool(
    "list_tables",
    {
      title: "List tables in a Postgres schema",
      description:
        "Routed through the same policy + audit pipeline. Defaults to the 'public' schema.",
      inputSchema: ListTablesInputSchema,
    },
    async (args: ListTablesArgs) => {
      let allowed = false;
      try {
        const result = await handleListTables({ engine: opts.handle.engine, ctx: ctx(), args });
        allowed = !result.isError;
        return result;
      } finally {
        telemetry.recordToolCall("list_tables", allowed);
      }
    },
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe columns of a Postgres table",
      description:
        "Returns column name, data type, nullability, and default. Routed through the policy + audit pipeline.",
      inputSchema: DescribeTableInputSchema,
    },
    async (args: DescribeTableArgs) => {
      let allowed = false;
      try {
        const result = await handleDescribeTable({ engine: opts.handle.engine, ctx: ctx(), args });
        allowed = !result.isError;
        return result;
      } finally {
        telemetry.recordToolCall("describe_table", allowed);
      }
    },
  );

  return server;
}
