// Verify buildServer wires three tools and they call through engine.handle().
//
// Uses an in-process MCP Client wired via the SDK's InMemoryTransport pair
// to avoid spinning up a real httpServer/stdio process for fast iteration.

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { makeTestEngine, baseCtx } from "./_helpers.ts";

async function connectClient() {
  const { engine, executor, audit } = makeTestEngine();
  const handle = {
    engine,
    ctxBase: baseCtx,
    async close() {},
  };
  const server = buildServer({ handle });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  return { client, server, executor, audit };
}

describe("buildServer — tool surface", () => {
  test("registers query, list_tables, describe_table", async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["describe_table", "list_tables", "query"]);
    await client.close();
  });

  test("query tool: ALLOW path returns rowCount in content", async () => {
    const { client, executor } = await connectClient();
    executor.result = { rows: [{ id: 1 }], rowCount: 1 };

    const res = await client.callTool({
      name: "query",
      arguments: { sql: "SELECT id FROM users" },
    });
    const content = res.content as Array<{ text: string }>;
    const data = JSON.parse(content[0]!.text);
    expect(data.allowed).toBe(true);
    expect(data.rowCount).toBe(1);
    await client.close();
  });

  test("query tool: DENY surfaces isError + policy_rule", async () => {
    const { client } = await connectClient();
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

  test("list_tables tool routes through engine and returns tables", async () => {
    const { client, executor, audit } = await connectClient();
    executor.result = {
      rows: [{ table_schema: "public", table_name: "users" }],
      rowCount: 1,
    };
    const res = await client.callTool({
      name: "list_tables",
      arguments: {},
    });
    const content = res.content as Array<{ text: string }>;
    const data = JSON.parse(content[0]!.text);
    expect(data.tables).toEqual([{ schema: "public", name: "users" }]);
    expect(audit.events.map((e) => e.event_type)).toContain("EXECUTED");
    await client.close();
  });

  test("describe_table tool returns columns", async () => {
    const { client, executor } = await connectClient();
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
    const res = await client.callTool({
      name: "describe_table",
      arguments: { table: "users" },
    });
    const content = res.content as Array<{ text: string }>;
    const data = JSON.parse(content[0]!.text);
    expect(data.columns[0]).toEqual({
      name: "id",
      type: "integer",
      nullable: false,
      default: null,
    });
    await client.close();
  });

  test("describe_table rejects metachar identifier as MCP tool error (zod regex)", async () => {
    const { client } = await connectClient();
    const res = await client.callTool({
      name: "describe_table",
      arguments: { table: "users; DROP TABLE users" },
    });
    // SDK shape: invalid input → tool returns isError=true with validation msg.
    expect(res.isError).toBe(true);
    await client.close();
  });
});
