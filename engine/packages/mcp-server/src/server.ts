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
// MCP `initialize` handshake). Identity rides on every audit row the
// engine emits from this session.
//
// 0.4.0: per-call intent is a required structured field on the `query`
// tool — no more multi-channel resolution. The MCP tool's JSON schema
// is the contract; the LLM fills it the same way it fills `sql`. Schema-
// browsing tools (list_tables, describe_table) intentionally don't take
// intent — their event_type is itself the explanation.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { version as PACKAGE_VERSION } from "../package.json" with { type: "json" };
import type { EngineContext } from "@midplane/engine";
import type { EngineHandle } from "./engine-factory.ts";
import type { TelemetryHandle } from "./telemetry/index.ts";
import {
  QueryInputSchema,
  QueryMultiInputSchema,
  handleQuery,
  type QueryArgs,
  type QueryMultiArgs,
  type ToolResult,
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
import { ceilingFor, scopedRegistry, type SessionScope } from "./scope.ts";

export interface BuildServerOptions {
  handle: EngineHandle;
  telemetry?: TelemetryHandle;
  // Per-session context captured by the transport at MCP `initialize`.
  // Carries the cloud-issued `mcp_token_id` (X-Midplane-Token-Id header) and
  // the per-agent DB `scope` (X-Midplane-Scope header). The HTTP transport's
  // per-session serverFactory hands this in; stdio and tests can leave it
  // undefined — null mcp_token_id / null scope are the well-defined
  // "no cloud token attribution" / "no scope (full access)" states.
  /** Approval gate, when one is configured. Only used to register the
   *  `check_approval` tool — the gate's enforcement path lives inside the
   *  engine, not here. Absent (or a gate with no `check`) simply means the tool
   *  is not offered, which is the correct surface for a deployment that has no
   *  approvals. */
  approvalGate?: ApprovalGate;
  sessionContext?: {
    mcp_token_id: string | null;
    // null = no scope header = full access (URL-token / self-host owner-all /
    // stdio). A map = scope active: only these DBs are visible, at the given
    // access (an empty map = scope active with zero DBs → deny-all, fail-closed).
    scope?: SessionScope | null;
  };
}

const NOOP_TELEMETRY: TelemetryHandle = {
  wrap: (w) => w,
  recordToolCall: () => {},
  markReady: () => {},
  async shutdown() {},
};

export function buildServer(opts: BuildServerOptions): McpServer {
  const server = new McpServer({
    name: "midplane-mcp-server",
    version: PACKAGE_VERSION,
  });

  const telemetry = opts.telemetry ?? NOOP_TELEMETRY;
  // Per-agent DB scope, frozen at MCP `initialize`. null = no scope header =
  // full access; a map = scope active (subset gate + read clamp). When active
  // we view the registry through `scopedRegistry` so the tool surface (the
  // `database` enum, `list_databases`, every lookup) only ever sees granted
  // DBs — a non-granted DB is invisible and unreachable. The underlying shared
  // engine is unchanged; the read clamp rides on the per-call ctx below.
  const scope = opts.sessionContext?.scope ?? null;
  const registry = scope ? scopedRegistry(opts.handle.registry, scope) : opts.handle.registry;
  // Frozen for the session's lifetime. Captured by the HTTP transport at
  // MCP `initialize` from the X-Midplane-Token-Id header and stamped on
  // every audit row this session emits. Null when the header was absent
  // or malformed, and on stdio / tests that don't construct one.
  const mcpTokenId = opts.sessionContext?.mcp_token_id ?? null;

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
      mcp_token_id: mcpTokenId,
      // Per-session read-only ceiling from the grant. The table_access rule
      // denies writes when this is "read". Absent scope → undefined (no clamp).
      // dbName is always in scope here: every caller resolves it through the
      // (scoped) registry, which only exposes granted DBs.
      scope_max_access: scope ? ceilingFor(scope.get(dbName)!) : undefined,
    };
  };

  // Scope active but zero DBs granted (a malformed/empty X-Midplane-Scope —
  // fail-closed; the proxy 403s before forwarding in the normal no-grant case).
  // Neither the single- nor multi-DB surface below is valid with no DBs (the
  // multi-DB `database` enum needs >=1 name), so register a degenerate surface
  // that denies cleanly instead of throwing at construction.
  if (scope && registry.count() === 0) {
    registerEmptyScopeSurface(server);
    return server;
  }

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
          "Parses the SQL with libpg_query, applies Midplane policy (table_access, multi_statement, tenant_scope, parse_error), audits the call, and returns rows on ALLOW. Denials return policy_rule + reason; the call is still audited. Required `intent` field captures why the query is being run (visible in audit logs).",
        inputSchema: QueryInputSchema,
      },
      async (args: QueryArgs) => {
        let allowed = false;
        try {
          const entry = registry.get(onlyDb);
          const result = await handleQuery({
            engine: entry.engine,
            ctx: ctxFor(onlyDb),
            args,
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
      async (args: ListTablesArgs) => {
        let allowed = false;
        try {
          const entry = registry.get(onlyDb);
          const result = await handleListTables({
            engine: entry.engine,
            ctx: ctxFor(onlyDb),
            args,
            listTablesSql: entry.listTablesSql,
            defaultSchema: entry.defaultSchema,
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
      async (args: DescribeTableArgs) => {
        let allowed = false;
        try {
          const entry = registry.get(onlyDb);
          const result = await handleDescribeTable({
            engine: entry.engine,
            ctx: ctxFor(onlyDb),
            args,
            describeTableSql: entry.describeTableSql,
            defaultSchema: entry.defaultSchema,
          });
          allowed = !result.isError;
          return result;
        } finally {
          telemetry.recordToolCall("describe_table", allowed, onlyDb);
        }
      },
    );

    registerCheckApproval(server, opts, telemetry);
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
        "Parses the SQL with libpg_query, applies Midplane policy for that DB (table_access, multi_statement, tenant_scope, parse_error), audits the call, and returns rows on ALLOW. Denials return policy_rule + reason; the call is still audited. Required `intent` field captures why the query is being run (visible in audit logs).",
      inputSchema: queryMultiSchema,
    },
    async (args: QueryMultiArgs) => {
      let allowed = false;
      const dbName = args.database;
      try {
        const entry = registry.get(dbName);
        const result = await handleQuery({
          engine: entry.engine,
          ctx: ctxFor(dbName),
          args: { sql: args.sql, intent: args.intent },
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
    async (args: ListTablesMultiArgs) => {
      let allowed = false;
      const dbName = args.database;
      try {
        if (dbName !== undefined) {
          const entry = registry.get(dbName);
          const result = await handleListTables({
            engine: entry.engine,
            ctx: ctxFor(dbName),
            args: { schema: args.schema },
            listTablesSql: entry.listTablesSql,
            defaultSchema: entry.defaultSchema,
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
    async (args: DescribeTableMultiArgs) => {
      let allowed = false;
      const dbName = args.database;
      try {
        const entry = registry.get(dbName);
        const result = await handleDescribeTable({
          engine: entry.engine,
          ctx: ctxFor(dbName),
          args: { table: args.table, schema: args.schema },
          describeTableSql: entry.describeTableSql,
          defaultSchema: entry.defaultSchema,
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
  // would return one entry. Reads the SCOPED registry, so it lists only the
  // agent's granted databases (with the read clamp reflected in the default).
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

  registerCheckApproval(server, opts, telemetry);
  return server;
}

// Registered on EVERY path that serves tools, not just one.
//
// This lived inline in the multi-DB tail and was therefore invisible to
// single-database projects — which is most of them — because that branch
// returns its own server well before reaching it. Extracted so the call site is
// explicit at each return and a future branch cannot silently omit it.
//
// Deliberately NOT registered on the empty-scope surface: that path is
// fail-closed by design and should not grow tools.
//
// Only offered when the gate can actually answer — a deployment without
// approvals should not advertise a tool that always fails.
function registerCheckApproval(
  server: McpServer,
  opts: BuildServerOptions,
  telemetry: TelemetryHandle,
): void {
  const gate = opts.approvalGate;
  if (!gate?.check) return;

  server.registerTool(
    "check_approval",
    {
      title: "Check whether a held write has been approved",
      description:
        "Poll a held write's approval status WITHOUT running anything. Use this to wait — it is cheap, safe to call repeatedly, and never consumes the approval. Returns pending (with its deadline), approved (call query again with the same sql and intent to actually execute it), executed (already ran — do not repeat), denied (with the reviewer's note), or expired. Never returns the statement or its results.",
      inputSchema: { approval_id: ApprovalIdSchema },
    },
    async (args: { approval_id: string }) => {
      let ok = false;
      try {
        const status = await gate.check!(
          args.approval_id,
          opts.sessionContext?.mcp_token_id ?? null,
        );
        ok = true;
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(toStatusWire(status)) },
          ],
        };
      } finally {
        telemetry.recordToolCall("check_approval", ok, null);
      }
    },
  );
}

const ApprovalIdSchema = z
  .string()
  .min(1, "approval_id cannot be empty")
  .max(64, "approval_id is too long");

// Flatten for the wire, and tell the agent what to DO in each state — an agent
// that reads "approved" and does not know to re-run has learned nothing.
function toStatusWire(s: {
  status: string;
  expiresAt?: number;
  by?: string | null;
  note?: string | null;
}): Record<string, unknown> {
  switch (s.status) {
    case "pending":
      return {
        status: "pending",
        executed: false,
        expires_at: s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
        next: "Nobody has decided yet. Keep polling this tool — it is cheap and never consumes the approval. Do NOT re-run the statement to check; that call blocks and is what executes it. Re-run only once this returns \"approved\".",
      };
    case "approved":
      return {
        status: "approved",
        executed: false,
        by: s.by ?? null,
        note: s.note ?? null,
        next: "Approved but NOT yet run — it only executes when you call query again with the same sql and intent. The approval is single-use, so do that once.",
      };
    case "executed":
      return {
        status: "executed",
        executed: true,
        next: "The write ran. This approval is spent — re-running the statement would open a NEW approval request, and would run it a SECOND time.",
      };
    case "consumed":
      return {
        status: "consumed",
        // Deliberately NOT executed:true. The grant was used, but nothing
        // confirms the statement landed — it may have failed in Postgres after
        // the grant was claimed. Saying it ran would be a guess presented as a
        // fact, and a blind retry could double-write if it actually did.
        executed: null,
        next: "This approval was used, but the outcome is unconfirmed — the write may or may not have landed. Do NOT report it as done and do NOT blindly retry: check the data (or the audit log) first, then ask for a new approval if it needs running.",
      };
    case "denied":
      return {
        status: "denied",
        by: s.by ?? null,
        note: s.note ?? null,
        next: "A human refused this statement. Do not retry it unchanged — write a different statement.",
      };
    case "expired":
      return {
        status: "expired",
        next: "Nobody responded in time. Re-run the identical statement to ask again.",
      };
    default:
      return {
        status: "not_found",
        next: "No such request for this agent. It may belong to a different agent, or never existed.",
      };
  }
}

// Tool surface for an active-but-empty scope (a malformed/empty X-Midplane-Scope
// — fail-closed). Every data tool denies with a clear message and list_databases
// returns an empty set, so the agent gets a coherent "nothing in scope" answer
// instead of the server failing to construct. Defensive: in normal flow the
// proxy 403s a credential that has no grant for the connection, so this surface
// is never reached.
function registerEmptyScopeSurface(server: McpServer): void {
  const deniedResult = (): ToolResult => ({
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          allowed: false,
          policy_rule: "scope",
          reason:
            "No databases are in scope for this credential. Its grant authorizes no databases on this connection — adjust the scope in the consent screen (interactive agents) or the token's settings (API tokens).",
        }),
      },
    ],
  });

  server.registerTool(
    "query",
    {
      title: "Run a SQL query (no databases are in scope for this credential)",
      description:
        "This credential's scope grants no database access on this connection; every call is denied. Adjust the scope to enable queries.",
      inputSchema: QueryInputSchema,
    },
    async () => deniedResult(),
  );
  server.registerTool(
    "list_tables",
    {
      title: "List tables (no databases are in scope for this credential)",
      description:
        "This credential's scope grants no database access on this connection; every call is denied.",
      inputSchema: ListTablesInputSchema,
    },
    async () => deniedResult(),
  );
  server.registerTool(
    "describe_table",
    {
      title: "Describe a table (no databases are in scope for this credential)",
      description:
        "This credential's scope grants no database access on this connection; every call is denied.",
      inputSchema: DescribeTableInputSchema,
    },
    async () => deniedResult(),
  );
  server.registerTool(
    "list_databases",
    {
      title: "List the databases this credential may reach",
      description:
        "Returns the databases in this credential's scope. Empty when the credential's grant authorizes no databases on this connection.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify({ databases: [] }) }],
    }),
  );
}
