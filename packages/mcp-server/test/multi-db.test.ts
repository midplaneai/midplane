// Multi-database integration tests (0.2.0).
//
// Boots a real EngineRegistry from a YAML `databases:` block via
// buildEngine (no MockExecutor injection — tests instead exercise the
// registry shape, the dynamic tool surface, and the hot-reload path).
// Uses a single shared MockExecutor across DBs because all engines route
// to the same mock; per-test inspection of executor.calls confirms
// dispatch correctness when needed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildEngine, type EngineHandle } from "../src/engine-factory.ts";
import { buildServer } from "../src/server.ts";
import { MockExecutor } from "./_helpers.ts";

let dir: string;
let dbPath: string;
let policyPath: string;
let executor: MockExecutor;
let handle: EngineHandle | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "midplane-multi-db-"));
  dbPath = join(dir, "audit.db");
  policyPath = join(dir, "policy.yaml");
  executor = new MockExecutor();
  handle = null;
});

afterEach(async () => {
  if (handle) await handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function bootMultiDb(yaml: string): EngineHandle {
  writeFileSync(policyPath, yaml);
  handle = buildEngine(
    {
      // databaseUrl intentionally omitted — multi-DB shape ignores it.
      port: 0,
      dbPath,
      tenantId: "__self_host__",
      policyFile: policyPath,
      transport: "http",
    },
    {
      executor,
      credentials: { resolve: async () => "postgres://stub" },
    },
  );
  return handle;
}

async function connect(h: EngineHandle) {
  const server = buildServer({ handle: h });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "multi-db-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

const TWO_DB_YAML = `databases:
  - name: prod
    url: postgres://prod
    table_access:
      default: deny
      tables:
        users: read
        feature_flags: read_write
  - name: analytics
    url: postgres://analytics
    table_access:
      default: read_write
`;

describe("multi-DB tool surface", () => {
  test("N>=2 → tools list includes list_databases; query/describe_table require database; list_tables optional", async () => {
    const h = bootMultiDb(TWO_DB_YAML);
    const { client } = await connect(h);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "describe_table",
      "list_databases",
      "list_tables",
      "query",
    ]);

    // The tool definitions advertise `database` as the right shape.
    const queryTool = tools.find((t) => t.name === "query")!;
    const querySchema = queryTool.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(querySchema.properties).toHaveProperty("database");
    expect(querySchema.required).toContain("database");

    const lt = tools.find((t) => t.name === "list_tables")!;
    const ltSchema = lt.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(ltSchema.properties).toHaveProperty("database");
    expect(ltSchema.required ?? []).not.toContain("database");

    const dt = tools.find((t) => t.name === "describe_table")!;
    const dtSchema = dt.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(dtSchema.properties).toHaveProperty("database");
    expect(dtSchema.required).toContain("database");

    await client.close();
  });

  test("query without `database` arg when N>=2 → MCP validation error", async () => {
    const h = bootMultiDb(TWO_DB_YAML);
    const { client } = await connect(h);

    const res = await client.callTool({
      name: "query",
      arguments: { sql: "SELECT 1" },
    });
    // Zod rejection surfaces as a tool error.
    expect(res.isError).toBe(true);

    await client.close();
  });

  test("query with unknown `database` name → schema error from MCP layer", async () => {
    const h = bootMultiDb(TWO_DB_YAML);
    const { client } = await connect(h);

    const res = await client.callTool({
      name: "query",
      arguments: { database: "staging", sql: "SELECT 1" },
    });
    // The zod enum rejects "staging" before the handler runs.
    expect(res.isError).toBe(true);

    await client.close();
  });

  test("query with valid DB routes to right engine + audit row carries `database`", async () => {
    const h = bootMultiDb(TWO_DB_YAML);
    const { client } = await connect(h);
    executor.result = { rows: [{ id: 1 }], rowCount: 1 };

    await client.callTool({
      name: "query",
      arguments: { database: "prod", sql: "SELECT id FROM users" },
    });

    // Audit log carries the right `database` value on every event for that
    // query.
    const rows = h.registry.audit.readSince("0", 100);
    const prodRows = rows.filter((r) => r.database === "prod");
    expect(prodRows.length).toBeGreaterThan(0);
    expect(prodRows.some((r) => r.event_type === "DECIDED")).toBe(true);

    await client.close();
  });

  test("list_databases returns all configured DBs with metadata", async () => {
    const h = bootMultiDb(`databases:
  - name: prod
    url: postgres://prod
    table_access:
      default: deny
      tables: {}
    tenant_scope:
      enabled: true
      mappings:
        users: org_id
  - name: analytics
    url: postgres://analytics
    table_access:
      default: read_write
`);
    const { client } = await connect(h);

    const res = await client.callTool({
      name: "list_databases",
      arguments: {},
    });
    const data = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
    expect(data.databases).toEqual([
      {
        name: "analytics",
        tenant_scope_enabled: false,
        tenant_scope_mappings: {},
        table_access_default: "read_write",
      },
      {
        name: "prod",
        tenant_scope_enabled: true,
        tenant_scope_mappings: { users: "org_id" },
        table_access_default: "deny",
      },
    ]);

    await client.close();
  });

  test("list_tables fan-out groups results by DB name", async () => {
    const h = bootMultiDb(TWO_DB_YAML);
    const { client } = await connect(h);
    executor.result = {
      rows: [{ table_schema: "public", table_name: "users" }],
      rowCount: 1,
    };

    const res = await client.callTool({
      name: "list_tables",
      arguments: {},
    });
    const data = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
    expect(Object.keys(data.databases).sort()).toEqual(["analytics", "prod"]);
    expect(data.databases.prod.tables).toBeDefined();
    expect(data.databases.analytics.tables).toBeDefined();

    await client.close();
  });

  test("list_tables targeted at one DB returns single-DB shape", async () => {
    const h = bootMultiDb(TWO_DB_YAML);
    const { client } = await connect(h);
    executor.result = {
      rows: [{ table_schema: "public", table_name: "users" }],
      rowCount: 1,
    };

    const res = await client.callTool({
      name: "list_tables",
      arguments: { database: "prod" },
    });
    const data = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
    expect(data.tables).toBeDefined();
    expect(data.databases).toBeUndefined();

    await client.close();
  });

  test("legacy single-DB audit rows carry `__default__`", async () => {
    // No `databases:` block: synthetic single-DB. Boots through the same
    // EngineRegistry, so the audit-tag invariant must hold here too.
    handle = buildEngine(
      {
        databaseUrl: "postgres://stub",
        port: 0,
        dbPath,
        tenantId: "__self_host__",
        transport: "http",
      },
      {
        executor,
        credentials: { resolve: async () => "postgres://stub" },
      },
    );
    expect(handle.registry.count()).toBe(1);
    expect(handle.registry.names()).toEqual(["__default__"]);

    const { client } = await connect(handle);

    // Tool surface stays identical to 0.1.x — no `database` arg required.
    executor.result = { rows: [{ id: 1 }], rowCount: 1 };
    const res = await client.callTool({
      name: "query",
      arguments: { sql: "SELECT id FROM users" },
    });
    expect(res.isError).toBeFalsy();

    const rows = handle.registry.audit.readSince("0", 100);
    expect(rows.every((r) => r.database === "__default__")).toBe(true);

    await client.close();
  });
});

describe("multi-DB hot reload", () => {
  test("add a new DB → tool schema reshapes on next session", async () => {
    const h = bootMultiDb(TWO_DB_YAML);

    expect(h.registry.names()).toEqual(["analytics", "prod"]);

    await h.registry.setPolicy(`databases:
  - name: prod
    url: postgres://prod
    table_access:
      default: deny
      tables: {}
  - name: analytics
    url: postgres://analytics
    table_access:
      default: read_write
  - name: staging
    url: postgres://staging
    table_access:
      default: read
      tables: {}
`);
    expect(h.registry.names()).toEqual(["analytics", "prod", "staging"]);

    // New session sees the new tool schema with `staging` in the enum.
    const { client } = await connect(h);
    const { tools } = await client.listTools();
    const queryTool = tools.find((t) => t.name === "query")!;
    const enumValues = (
      queryTool.inputSchema as {
        properties: { database: { enum: string[] } };
      }
    ).properties.database.enum;
    expect(enumValues.sort()).toEqual(["analytics", "prod", "staging"]);
    await client.close();
  });

  test("remove a DB → registry drops it", async () => {
    const h = bootMultiDb(TWO_DB_YAML);
    expect(h.registry.count()).toBe(2);

    await h.registry.setPolicy(`databases:
  - name: prod
    url: postgres://prod
    table_access:
      default: deny
      tables: {}
`);
    expect(h.registry.count()).toBe(1);
    expect(h.registry.has("analytics")).toBe(false);
  });

  test("edit a DB's table_access in place → swap reflected", async () => {
    const h = bootMultiDb(TWO_DB_YAML);

    // prod has default: deny + users:read. SELECT users → ALLOW.
    const { client } = await connect(h);
    executor.result = { rows: [{ id: 1 }], rowCount: 1 };
    const before = await client.callTool({
      name: "query",
      arguments: { database: "prod", sql: "SELECT id FROM users" },
    });
    expect(before.isError).toBeFalsy();
    await client.close();

    // Swap prod to deny everything.
    await h.registry.setPolicy(`databases:
  - name: prod
    url: postgres://prod
    table_access:
      default: deny
      tables: {}
  - name: analytics
    url: postgres://analytics
    table_access:
      default: read_write
`);

    const { client: client2 } = await connect(h);
    const after = await client2.callTool({
      name: "query",
      arguments: { database: "prod", sql: "SELECT id FROM users" },
    });
    expect(after.isError).toBe(true);
    const data = JSON.parse(
      (after.content as Array<{ text: string }>)[0]!.text,
    );
    expect(data.policy_rule).toBe("table_access");
    await client2.close();
  });

  test("edit a DB's url → pool rebuild logged + DB still functional", async () => {
    const h = bootMultiDb(TWO_DB_YAML);

    await h.registry.setPolicy(`databases:
  - name: prod
    url: postgres://prod-replica
    table_access:
      default: deny
      tables:
        users: read
  - name: analytics
    url: postgres://analytics
    table_access:
      default: read_write
`);

    // The DB is still queryable after the pool rebuild.
    const { client } = await connect(h);
    executor.result = { rows: [{ id: 1 }], rowCount: 1 };
    const res = await client.callTool({
      name: "query",
      arguments: { database: "prod", sql: "SELECT id FROM users" },
    });
    expect(res.isError).toBeFalsy();
    await client.close();
  });

  test("adding a DB writes a self-describing POLICY_RELOADED row (not a no-op)", async () => {
    // Reviewer-flagged regression: a successful /admin/policy that adds
    // a DB previously emitted a row with sections_changed: [],
    // databases_changed: [], and null diffs — the add was invisible to
    // the cloud audit dashboard's change feed. New DBs must show up in
    // databases_changed and have non-empty section diffs covering
    // whatever sections the spec carries.
    const h = bootMultiDb(TWO_DB_YAML);

    await h.registry.setPolicy(`databases:
  - name: prod
    url: postgres://prod
    table_access:
      default: deny
      tables:
        users: read
        feature_flags: read_write
  - name: analytics
    url: postgres://analytics
    table_access:
      default: read_write
  - name: staging
    url: postgres://staging
    tenant_scope:
      enabled: true
      mappings:
        users: org_id
    table_access:
      default: deny
      tables:
        users: read
`);

    const reloads = h.registry.audit
      .readSince("0", 1000)
      .filter((r) => r.event_type === "POLICY_RELOADED");
    const stagingRow = reloads.find((r) => r.database === "staging");
    expect(stagingRow).toBeDefined();
    const payload = stagingRow!.payload as {
      sections_changed: string[];
      databases_changed: string[];
      diff: {
        table_access: { default?: { from: string | null; to: string }; tables_added?: Record<string, string> } | null;
        tenant_scope: { mappings_added?: Record<string, string> } | null;
      };
    };
    expect(payload.databases_changed).toContain("staging");
    expect(payload.sections_changed.sort()).toEqual([
      "table_access",
      "tenant_scope",
    ]);
    expect(payload.diff.table_access?.default).toEqual({
      from: null,
      to: "deny",
    });
    expect(payload.diff.table_access?.tables_added).toEqual({ users: "read" });
    expect(payload.diff.tenant_scope?.mappings_added).toEqual({
      users: "org_id",
    });
  });

  test("rebuilding a DB on URL change writes a self-describing POLICY_RELOADED row", async () => {
    // Same reviewer regression: changing a DB's URL rebuilt the pool
    // but emitted a no-op audit row. The diff should now reflect the
    // OLD policy → NEW policy transition for the URL-changed DB.
    const h = bootMultiDb(`databases:
  - name: prod
    url: postgres://prod
    table_access:
      default: deny
      tables:
        users: read
  - name: analytics
    url: postgres://analytics
    table_access:
      default: read_write
`);

    await h.registry.setPolicy(`databases:
  - name: prod
    url: postgres://prod-replica
    table_access:
      default: read
      tables:
        users: read_write
  - name: analytics
    url: postgres://analytics
    table_access:
      default: read_write
`);

    const reloads = h.registry.audit
      .readSince("0", 1000)
      .filter((r) => r.event_type === "POLICY_RELOADED");
    const prodRow = reloads.find((r) => r.database === "prod");
    expect(prodRow).toBeDefined();
    const payload = prodRow!.payload as {
      sections_changed: string[];
      databases_changed: string[];
      diff: {
        table_access: {
          default?: { from: string | null; to: string };
          tables_changed?: Record<string, { from: string; to: string }>;
        } | null;
      };
    };
    expect(payload.databases_changed).toContain("prod");
    expect(payload.sections_changed).toContain("table_access");
    expect(payload.diff.table_access?.default).toEqual({
      from: "deny",
      to: "read",
    });
    expect(payload.diff.table_access?.tables_changed).toEqual({
      users: { from: "read", to: "read_write" },
    });
  });

  test("omitting table_access on an existing DB is rejected (won't silently widen)", async () => {
    // Regression: previously, an entry with no table_access section had
    // spec.tableAccess === null, which the in-place swap converted to
    // holder.tableAccess = undefined — falling back to the no-YAML default
    // (default: read). That silently widened a DB that had been default:
    // deny. Hot-swap of an existing entry must require table_access just
    // like the single-DB path does.
    const h = bootMultiDb(TWO_DB_YAML);

    await expect(
      h.registry.setPolicy(`databases:
  - name: prod
    url: postgres://prod
  - name: analytics
    url: postgres://analytics
    table_access:
      default: read_write
`),
    ).rejects.toThrow(/databases\[name=prod\].*table_access/);

    // Original policy still in force: prod's default: deny + users: read.
    const { client } = await connect(h);
    executor.result = { rows: [{ id: 1 }], rowCount: 1 };
    const stillDenied = await client.callTool({
      name: "query",
      arguments: { database: "prod", sql: "SELECT id FROM other_table" },
    });
    expect(stillDenied.isError).toBe(true);
    expect(
      JSON.parse((stillDenied.content as Array<{ text: string }>)[0]!.text)
        .policy_rule,
    ).toBe("table_access");
    await client.close();
  });

  test("omitting tenant_scope on a DB that has mappings is treated as 'don't touch'", async () => {
    // Regression: the validation pass compared spec.mappings to
    // existing.mappings unconditionally, so a body that only changed
    // table_access (and omitted the unchanged tenant_scope) was rejected
    // with a "restart required" error even though tenant scoping wasn't
    // changing. This mirrors the omit-vs-empty distinction the legacy
    // single-DB reload already supports.
    const h = bootMultiDb(`databases:
  - name: prod
    url: postgres://prod
    tenant_scope:
      enabled: true
      mappings:
        users: org_id
    table_access:
      default: deny
      tables:
        users: read
  - name: analytics
    url: postgres://analytics
    table_access:
      default: read_write
`);

    // Body omits prod's tenant_scope but keeps the table_access. Should
    // succeed; mappings remain in force.
    const result = await h.registry.setPolicy(`databases:
  - name: prod
    url: postgres://prod
    table_access:
      default: deny
      tables:
        users: read_write
  - name: analytics
    url: postgres://analytics
    table_access:
      default: read_write
`);
    expect(result.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Tenant_scope still enforced after the reload — a bare SELECT FROM
    // users on prod still trips tenant_scope_missing.
    const { client } = await connect(h);
    const res = await client.callTool({
      name: "query",
      arguments: { database: "prod", sql: "SELECT id FROM users" },
    });
    expect(res.isError).toBe(true);
    const data = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
    expect(data.policy_rule).toBe("tenant_scope_missing");
    expect(data.reason).toContain("org_id");
    await client.close();
  });

  test("hot-swap of tenant_scope.mappings on existing DB updates the live mapping", async () => {
    // 0.4.0: tenant_scope.mappings hot-swap via the holder, same pattern
    // as table_access. Pre-0.4.0 this rejected with /tenant_scope\.mappings/
    // and forced a restart; the cloud dashboard's per-DB mapping editor
    // pushes through this path.
    const yaml = `databases:
  - name: prod
    url: postgres://prod
    tenant_scope:
      enabled: true
      mappings:
        users: org_id
    table_access:
      default: read
      tables: {}
  - name: analytics
    url: postgres://analytics
    table_access:
      default: read_write
`;
    const h = bootMultiDb(yaml);

    const result = await h.registry.setPolicy(`databases:
  - name: prod
    url: postgres://prod
    tenant_scope:
      enabled: true
      mappings:
        users: customer_id
    table_access:
      default: read
      tables: {}
  - name: analytics
    url: postgres://analytics
    table_access:
      default: read_write
`);
    expect(result.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // describe() reports the live (post-swap) mappings.
    const desc = h.registry.describe();
    const prod = desc.find((d) => d.name === "prod")!;
    expect(prod.tenant_scope_mappings).toEqual({ users: "customer_id" });

    // Next query observes the new mapping: a bare SELECT on prod's
    // `users` now demands `customer_id = <tenant_id>`, not `org_id`.
    const { client } = await connect(h);
    const res = await client.callTool({
      name: "query",
      arguments: { database: "prod", sql: "SELECT id FROM users" },
    });
    expect(res.isError).toBe(true);
    const data = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
    expect(data.policy_rule).toBe("tenant_scope_missing");
    expect(data.reason).toContain("customer_id");
    expect(data.reason).not.toContain("org_id");
    await client.close();
  });
});

describe("per-DB tenant_scope independence", () => {
  test("same table name in two DBs with different mappings → both enforced independently", async () => {
    // Both DBs have a tenant_scope mapping on `users`, but the column
    // names differ. A bare `SELECT FROM users` denies under both, but the
    // denial message must name the right column for each DB — confirming
    // the engines are wired with their own holder.tenantScope.
    const h = bootMultiDb(`databases:
  - name: a
    url: postgres://a
    tenant_scope:
      enabled: true
      mappings:
        users: org_id
    table_access:
      default: read
      tables: {}
  - name: b
    url: postgres://b
    tenant_scope:
      enabled: true
      mappings:
        users: customer_id
    table_access:
      default: read
      tables: {}
`);
    const { client } = await connect(h);

    const aRes = await client.callTool({
      name: "query",
      arguments: { database: "a", sql: "SELECT id FROM users" },
    });
    expect(aRes.isError).toBe(true);
    const aData = JSON.parse((aRes.content as Array<{ text: string }>)[0]!.text);
    expect(aData.policy_rule).toBe("tenant_scope_missing");
    expect(aData.reason).toContain("org_id");
    expect(aData.reason).not.toContain("customer_id");

    const bRes = await client.callTool({
      name: "query",
      arguments: { database: "b", sql: "SELECT id FROM users" },
    });
    expect(bRes.isError).toBe(true);
    const bData = JSON.parse((bRes.content as Array<{ text: string }>)[0]!.text);
    expect(bData.policy_rule).toBe("tenant_scope_missing");
    expect(bData.reason).toContain("customer_id");
    expect(bData.reason).not.toContain("org_id");

    await client.close();
  });
});
