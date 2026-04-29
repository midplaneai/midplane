// HTTP transport — boots a real httpServer + StreamableHTTP transport, drives
// it from an MCP Client. Same shape as examples/smoketest/client.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "node:http";
import { startHttp, type HttpHandle } from "../../src/transport/http.ts";
import { buildServer } from "../../src/server.ts";
import { makeTestEngine, baseCtx, type MockExecutor } from "../_helpers.ts";

let httpHandle: HttpHandle;
let executor: MockExecutor;

beforeAll(async () => {
  const harness = makeTestEngine();
  executor = harness.executor;
  const handle = {
    engine: harness.engine,
    ctxBase: baseCtx,
    async close() {},
  };
  // Port 0 = OS picks free port.
  httpHandle = await startHttp(() => buildServer({ handle }), {
    port: 0,
    host: "127.0.0.1",
  });
});

afterAll(async () => {
  await httpHandle.close();
});

describe("http transport", () => {
  test("GET /health returns ok", async () => {
    const res = await fetch(`http://127.0.0.1:${httpHandle.port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  test("MCP client lists three tools and calls each", async () => {
    const url = new URL(`http://127.0.0.1:${httpHandle.port}/mcp`);
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client({ name: "http-test-client", version: "0.0.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["describe_table", "list_tables", "query"]);

    // query
    executor.result = { rows: [{ ok: 1 }], rowCount: 1 };
    const q = await client.callTool({ name: "query", arguments: { sql: "SELECT 1" } });
    expect(q.isError).toBeFalsy();

    // list_tables
    executor.result = {
      rows: [{ table_schema: "public", table_name: "users" }],
      rowCount: 1,
    };
    const lt = await client.callTool({ name: "list_tables", arguments: {} });
    const ltContent = lt.content as Array<{ text: string }>;
    const ltData = JSON.parse(ltContent[0]!.text);
    expect(ltData.tables[0]?.name).toBe("users");

    // describe_table
    executor.result = {
      rows: [
        {
          column_name: "id",
          data_type: "integer",
          is_nullable: "NO",
          column_default: null,
        },
      ],
      rowCount: 1,
    };
    const dt = await client.callTool({
      name: "describe_table",
      arguments: { table: "users" },
    });
    const dtContent = dt.content as Array<{ text: string }>;
    const dtData = JSON.parse(dtContent[0]!.text);
    expect(dtData.columns[0]?.name).toBe("id");

    await client.close();
  });

  test("startHttp rejects when the requested port is already in use", async () => {
    // Hold a port so the bind below collides.
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.once("listening", () => resolve());
      blocker.listen(0, "127.0.0.1");
    });
    const addr = blocker.address();
    const blockedPort = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const harness = makeTestEngine();
      const handle = {
        engine: harness.engine,
        ctxBase: baseCtx,
        async close() {},
      };
      await expect(
        startHttp(() => buildServer({ handle }), {
          port: blockedPort,
          host: "127.0.0.1",
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  test("DENY (DELETE) routes to isError tool result, not transport error", async () => {
    const url = new URL(`http://127.0.0.1:${httpHandle.port}/mcp`);
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client({ name: "http-test-client-2", version: "0.0.0" });
    await client.connect(transport);

    const res = await client.callTool({
      name: "query",
      arguments: { sql: "DELETE FROM users" },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ text: string }>;
    const data = JSON.parse(content[0]!.text);
    expect(data.policy_rule).toBe("writes_require_approval");

    await client.close();
  });
});
