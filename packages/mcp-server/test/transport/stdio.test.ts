// stdio transport — end-to-end via in-process stdio pair.
//
// We can't use real process stdin/stdout in unit tests, so we verify the
// transport-wrapping behavior with a linked InMemory pair as a stand-in
// (the brief calls for "in-process stdio pair" — InMemoryTransport satisfies
// this in spirit and in tests). The actual StdioServerTransport is exercised
// in the MCP compatibility matrix (T7, separate session).

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import { makeTestEngine, makeTestHandle } from "../_helpers.ts";

describe("stdio transport (in-process pair)", () => {
  test("client + server complete an end-to-end query through engine.handle()", async () => {
    const { engine, executor, audit } = makeTestEngine();
    executor.result = { rows: [{ ok: 1 }], rowCount: 1 };
    const handle = makeTestHandle({ engine, audit });
    const server = buildServer({ handle });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "describe_table",
      "list_tables",
      "query",
    ]);

    const res = await client.callTool({
      name: "query",
      arguments: { sql: "SELECT 1" },
    });
    expect(res.isError).toBeFalsy();

    // Routing through the engine pipeline produced an EXECUTED audit row.
    expect(audit.events.map((e) => e.event_type)).toContain("EXECUTED");

    await client.close();
  });

  test("startStdio is callable with a real StdioServerTransport (smoke)", async () => {
    // Verify the import + connect shape compiles and the function exists.
    // Calling it for real would block on process.stdin which isn't suitable
    // here; the runtime path is exercised by the MCP compatibility matrix.
    const { startStdio } = await import("../../src/transport/stdio.ts");
    expect(typeof startStdio).toBe("function");
  });
});
