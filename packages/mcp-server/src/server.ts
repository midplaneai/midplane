// Builds an McpServer with the V1 tool surface registered.
//
// 0.2.0: tool schemas reshape based on the registry's DB count, captured
// at server construction. Single-DB (count==1) → identical to 0.1.x: no
// `database` field appears anywhere, no `list_databases` tool. Multi-DB
// (count>=2) → `query` and `describe_table` require a `database` enum
// arg, `list_tables` accepts an optional `database` (omitted = fan out
// across all), and `list_databases` is registered.
//
// The reshape happens at session-start: each MCP session calls
// buildServer() via the transport's serverFactory, so an `/admin/policy`
// reload that adds or removes a DB will be reflected the next time the
// agent reconnects (or asks tools/list on a new session).
//
// 0.3.0: every tool handler resolves the calling agent's identity via
// `server.server.getClientVersion()` (populated by the SDK after the
// MCP `initialize` handshake) and the per-call agent intent via
// resolveAgentIntent(). Both ride on every audit row the engine emits
// from this session.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentIntent, EngineContext } from "@midplane/engine";
import type { EngineHandle } from "./engine-factory.ts";
import type { TelemetryHandle } from "./telemetry/index.ts";
import { resolveAgentIntent } from "./intent.ts";
import {
  QueryInputSchema,
  QueryMultiInputSchema,
  handleQuery,
  type QueryArgs,
  type QueryMultiArgs,
} from "./tools/query.ts";
import {
  ListTablesInputSchema,
  ListTablesMultiInputSchema,
  handleListTables,
  handleListTablesAcrossAll,
  type ListTablesArgs,
  type ListTablesMultiArgs,
} from "./tools/list-tables.ts";
import {
  DescribeTableInputSchema,
  DescribeTableMultiInputSchema,
  handleDescribeTable,
  type DescribeTableArgs,
  type DescribeTableMultiArgs,
} from "./tools/describe-table.ts";
import { handleListDatabases } from "./tools/list-databases.ts";

export interface BuildServerOptions {
  handle: EngineHandle;
  telemetry?: TelemetryHandle;
}

const NOOP_TELEMETRY: TelemetryHandle = {
  wrap: (w) => w,
  recordToolCall: () => {},
  markReady: () => {},
  async shutdown() {},
};

// Subset of the SDK's RequestHandlerExtra we read inside tool handlers.
// Pulling it out keeps the imports off the public surface (the SDK type
// is generic over server request/notification unions which we don't need).
interface ToolExtra {
  _meta?: Record<string, unknown> | undefined;
  requestInfo?: {
    headers?: Record<string, string | string[] | undefined> | undefined;
  };
}

export function buildServer(opts: BuildServerOptions): McpServer {
  const server = new McpServer({
    name: "midplane-mcp-server",
    version: "0.4.0",
  });

  const telemetry = opts.telemetry ?? NOOP_TELEMETRY;
  const registry = opts.handle.registry;

  // Resolve agent name+version dynamically from the SDK's per-session
  // clientInfo (populated after MCP `initialize`). Both fields are
  // optional in the MCP spec — we coerce missing/empty to null. For
  // non-MCP callers (audit CLI, raw HTTP) the path that builds the ctx
  // never runs through here, so this seam is MCP-only by construction.
  const agentInfo = (): { name: string | null; version: string | null } => {
    const info = server.server.getClientVersion();
    if (!info) return { name: null, version: null };
    const name = typeof info.name === "string" ? info.name.trim() : "";
    const version =
      typeof info.version === "string" ? info.version.trim() : "";
    return {
      name: name.length > 0 ? name : null,
      version: version.length > 0 ? version : null,
    };
  };

  const ctxFor = (dbName: string): EngineContext => {
    const entry = registry.get(dbName);
    const { name, version } = agentInfo();
    return {
      ...entry.ctxBase,
      agent_name: name,
      agent_version: version,
    };
  };

  // Per-call: pick intent from `_meta`/SQL comment/header. The resolver
  // also strips a recognized SQL-comment hint from the forwarded SQL —
  // tools that pass synthetic SQL (list_tables, describe_table) just see
  // the original string back since they never include the hint.
  const resolveIntent = (
    sql: string,
    extra: ToolExtra,
  ): { cleanSql: string; intent: AgentIntent | null } => {
    const r = resolveAgentIntent({
      meta: extra._meta,
      sql,
      headers: extra.requestInfo?.headers,
    });
    return { cleanSql: r.cleanSql, intent: r.intent };
  };

  // Tool handlers wrap their engine call in try/finally so the per-tool
  // counter is recorded on every exit path — including the case where the
  // engine rethrows a Postgres execution error (audited as FAILED). A
  // throw counts as a deny so tools.{name}.calls/allow/deny stays
  // consistent with exec_failures.count in the same heartbeat window.

  if (registry.count() === 1) {
    // ── Single-DB tool surface (identical to 0.1.x) ────────────────────
    const onlyDb = registry.names()[0]!;

    server.registerTool(
      "query",
      {
        title: "Run a SQL query against the configured Postgres database",
        description:
          "Parses the SQL with libpg_query, applies Midplane policy (table_access, multi_statement, tenant_scope, parse_error), audits the call, and returns rows on ALLOW. Denials return policy_rule + reason; the call is still audited.",
        inputSchema: QueryInputSchema,
      },
      async (args: QueryArgs, extra: ToolExtra) => {
        let allowed = false;
        try {
          const entry = registry.get(onlyDb);
          const { cleanSql, intent } = resolveIntent(args.sql, extra);
          const result = await handleQuery({
            engine: entry.engine,
            ctx: ctxFor(onlyDb),
            args: { sql: cleanSql },
            intent,
          });
          allowed = !result.isError;
          return result;
        } finally {
          telemetry.recordToolCall("query", allowed, onlyDb);
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
      async (args: ListTablesArgs, extra: ToolExtra) => {
        let allowed = false;
        try {
          const entry = registry.get(onlyDb);
          // Server-generated SQL — no comment hint can ride on it; only
          // _meta + header channels meaningfully apply. Pass the SQL
          // through resolveAgentIntent anyway for consistency (it's a
          // no-op on synthetic queries).
          const { intent } = resolveIntent("", extra);
          const result = await handleListTables({
            engine: entry.engine,
            ctx: ctxFor(onlyDb),
            args,
            intent,
          });
          allowed = !result.isError;
          return result;
        } finally {
          telemetry.recordToolCall("list_tables", allowed, onlyDb);
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
      async (args: DescribeTableArgs, extra: ToolExtra) => {
        let allowed = false;
        try {
          const entry = registry.get(onlyDb);
          const { intent } = resolveIntent("", extra);
          const result = await handleDescribeTable({
            engine: entry.engine,
            ctx: ctxFor(onlyDb),
            args,
            intent,
          });
          allowed = !result.isError;
          return result;
        } finally {
          telemetry.recordToolCall("describe_table", allowed, onlyDb);
        }
      },
    );

    return server;
  }

  // ── Multi-DB tool surface ────────────────────────────────────────────
  // `database` is a zod enum over the registered names. zod requires a
  // tuple type; build it explicitly. The registry returns names() sorted
  // for stability across reconnects.
  const names = registry.names() as [string, ...string[]];
  const dbEnum = z.enum(names);

  const queryMultiSchema = QueryMultiInputSchema(dbEnum);
  server.registerTool(
    "query",
    {
      title: "Run a SQL query against one of the configured Postgres databases",
      description:
        `Required \`database\` selects the target Postgres. Configured databases: ${names.join(", ")}. ` +
        "Parses the SQL with libpg_query, applies Midplane policy for that DB (table_access, multi_statement, tenant_scope, parse_error), audits the call, and returns rows on ALLOW. Denials return policy_rule + reason; the call is still audited.",
      inputSchema: queryMultiSchema,
    },
    async (args: QueryMultiArgs, extra: ToolExtra) => {
      let allowed = false;
      const dbName = args.database;
      try {
        const entry = registry.get(dbName);
        const { cleanSql, intent } = resolveIntent(args.sql, extra);
        const result = await handleQuery({
          engine: entry.engine,
          ctx: ctxFor(dbName),
          args: { sql: cleanSql },
          intent,
        });
        allowed = !result.isError;
        return result;
      } finally {
        telemetry.recordToolCall("query", allowed, dbName);
      }
    },
  );

  const listTablesMultiSchema = ListTablesMultiInputSchema(dbEnum);
  server.registerTool(
    "list_tables",
    {
      title: "List tables across one or all configured Postgres databases",
      description:
        `Optional \`database\` (one of: ${names.join(", ")}) targets a single DB. Omitted → fan out across all DBs and group results by DB name. ` +
        "Each underlying call is routed through the per-DB policy + audit pipeline.",
      inputSchema: listTablesMultiSchema,
    },
    async (args: ListTablesMultiArgs, extra: ToolExtra) => {
      let allowed = false;
      const dbName = args.database;
      try {
        const { intent } = resolveIntent("", extra);
        if (dbName !== undefined) {
          const entry = registry.get(dbName);
          const result = await handleListTables({
            engine: entry.engine,
            ctx: ctxFor(dbName),
            args: { schema: args.schema },
            intent,
          });
          allowed = !result.isError;
          return result;
        }
        // Fan out. Each per-DB call goes through its engine and gets its
        // own audit row. Per-DB telemetry is recorded for each leg.
        const result = await handleListTablesAcrossAll({
          registry,
          ctxFor,
          args: { schema: args.schema },
          intent,
          recordToolCall: (db, allow) => telemetry.recordToolCall("list_tables", allow, db),
        });
        allowed = !result.isError;
        return result;
      } finally {
        // The fan-out path already reported per-DB; for the single-DB
        // case we also report once with the explicit name.
        if (dbName !== undefined) {
          telemetry.recordToolCall("list_tables", allowed, dbName);
        }
      }
    },
  );

  const describeMultiSchema = DescribeTableMultiInputSchema(dbEnum);
  server.registerTool(
    "describe_table",
    {
      title: "Describe columns of a Postgres table in one of the configured databases",
      description:
        `Required \`database\` selects the target Postgres. Configured databases: ${names.join(", ")}. ` +
        "Returns column name, data type, nullability, and default. Routed through the policy + audit pipeline.",
      inputSchema: describeMultiSchema,
    },
    async (args: DescribeTableMultiArgs, extra: ToolExtra) => {
      let allowed = false;
      const dbName = args.database;
      try {
        const entry = registry.get(dbName);
        const { intent } = resolveIntent("", extra);
        const result = await handleDescribeTable({
          engine: entry.engine,
          ctx: ctxFor(dbName),
          args: { table: args.table, schema: args.schema },
          intent,
        });
        allowed = !result.isError;
        return result;
      } finally {
        telemetry.recordToolCall("describe_table", allowed, dbName);
      }
    },
  );

  // list_databases: trivial registry-introspection. Only registered when
  // there's more than one DB — single-DB users don't need a tool that
  // would return one entry.
  server.registerTool(
    "list_databases",
    {
      title: "List the Postgres databases this Midplane instance is configured to serve",
      description:
        "Returns each database's name, whether tenant_scope is enforced, and its table_access default. Use this to discover which `database` values to pass to `query`, `describe_table`, and `list_tables`.",
      inputSchema: {},
    },
    async () => {
      let allowed = false;
      try {
        const result = handleListDatabases({ registry });
        allowed = !result.isError;
        return result;
      } finally {
        telemetry.recordToolCall("list_databases", allowed, null);
      }
    },
  );

  return server;
}
