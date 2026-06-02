// MySQL dialect — end-to-end mcp-server wiring (0.7.0).
//
// Verifies the server-side seams a `dialect: mysql` DB exercises:
//   1. engine-factory picks MysqlPoolExecutor for a mysql DSN (createExecutor switch).
//   2. The EngineEntry carries the dialect's metadata SQL (information_schema),
//      and the list_tables tool routes through it (the B2 plumbing).
//   3. End-to-end through the MCP client: USE / cross-DB are denied; a properly
//      tenant-scoped query is allowed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildEngine, type EngineHandle } from "../src/engine-factory.ts";
import { buildServer } from "../src/server.ts";
import { MysqlPoolExecutor } from "../src/executor/mysql-pool.ts";
import { MockExecutor } from "./_helpers.ts";

let dir: string;
let handle: EngineHandle | null;

const MYSQL_YAML = `databases:
  - name: warehouse
    url: mysql://app:secret@db:3306/appdb
    dialect: mysql
    table_access:
      default: read
      tables:
        users: read_write
        audit_log: deny
    tenant_scope:
      column: org_id
      exempt:
        - webhooks
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "midplane-mysql-"));
  handle = null;
});
afterEach(async () => {
  if (handle) await handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function boot(opts: { executor?: MockExecutor } = {}): EngineHandle {
  const policyPath = join(dir, "policy.yaml");
  writeFileSync(policyPath, MYSQL_YAML);
  handle = buildEngine(
    { port: 0, dbPath: join(dir, "audit.db"), tenantId: "42", policyFile: policyPath, transport: "http" },
    opts.executor
      ? { executor: opts.executor, credentials: { resolve: async () => "mysql://stub" } }
      : {},
  );
  return handle;
}

describe("mysql factory wiring", () => {
  test("createExecutor builds a MysqlPoolExecutor for a mysql DSN", () => {
    const h = boot(); // no injected executor → real (lazy) pool, never connects in this test
    const entry = h.registry.get("warehouse");
    expect(entry.executor).toBeInstanceOf(MysqlPoolExecutor);
  });

  test("EngineEntry exposes the dialect's information_schema metadata SQL", () => {
    const h = boot();
    const entry = h.registry.get("warehouse");
    expect(entry.listTablesSql("appdb")).toMatch(/information_schema\.tables/i);
    expect(entry.describeTableSql("appdb", "users")).toMatch(/information_schema\.columns/i);
  });
});

describe("mysql end-to-end through the MCP client", () => {
  async function connect(h: EngineHandle) {
    const server = buildServer({ handle: h });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "mysql-test", version: "0.0.0" });
    await client.connect(ct);
    return client;
  }

  function textOf(result: { content?: Array<{ text?: string }> }): Record<string, unknown> {
    return JSON.parse(result.content?.[0]?.text ?? "{}");
  }

  test("list_tables routes the dialect's information_schema SQL to the executor", async () => {
    const executor = new MockExecutor();
    executor.result = { rows: [{ table_schema: "appdb", table_name: "users" }], rowCount: 1 };
    const client = await connect(boot({ executor }));
    await client.callTool({ name: "list_tables", arguments: { schema: "appdb" } });
    expect(executor.calls.at(-1)?.sql).toMatch(/information_schema\.tables/i);
  });

  test("list_tables WITHOUT schema defaults to the connected database (not 'public')", async () => {
    // MySQL's information_schema.table_schema is the database name; the DSN
    // already names it (app_db = "appdb"), so omitting `schema` must query the
    // connected database, not the empty "public" schema.
    const executor = new MockExecutor();
    executor.result = { rows: [], rowCount: 0 };
    const client = await connect(boot({ executor }));
    await client.callTool({ name: "list_tables", arguments: {} });
    expect(executor.calls.at(-1)?.sql).toMatch(/table_schema = 'appdb'/);
    expect(executor.calls.at(-1)?.sql).not.toMatch(/'public'/);
  });

  test("describe_table WITHOUT schema defaults to the connected database", async () => {
    const executor = new MockExecutor();
    executor.result = { rows: [], rowCount: 0 };
    const client = await connect(boot({ executor }));
    await client.callTool({ name: "describe_table", arguments: { table: "users" } });
    expect(executor.calls.at(-1)?.sql).toMatch(/table_schema = 'appdb'/);
  });

  test("USE is denied", async () => {
    const executor = new MockExecutor();
    const client = await connect(boot({ executor }));
    const res = await client.callTool({ name: "query", arguments: { sql: "USE otherdb", intent: "switch db" } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res as never).allowed).toBe(false);
  });

  test("cross-database reference is denied", async () => {
    const executor = new MockExecutor();
    const client = await connect(boot({ executor }));
    const res = await client.callTool({
      name: "query",
      arguments: { sql: "SELECT * FROM otherdb.users WHERE otherdb.users.org_id = 42", intent: "exfiltrate" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });

  test("properly tenant-scoped query is allowed and reaches the executor", async () => {
    const executor = new MockExecutor();
    executor.result = { rows: [{ id: 1 }], rowCount: 1 };
    const client = await connect(boot({ executor }));
    const res = await client.callTool({
      name: "query",
      arguments: { sql: "SELECT id FROM users WHERE org_id = 42", intent: "read own rows" },
    });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(executor.calls.at(-1)?.sql).toBe("SELECT id FROM users WHERE org_id = 42");
  });

  test("missing tenant predicate is denied", async () => {
    const executor = new MockExecutor();
    const client = await connect(boot({ executor }));
    const res = await client.callTool({
      name: "query",
      arguments: { sql: "SELECT id FROM users", intent: "read all" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});
