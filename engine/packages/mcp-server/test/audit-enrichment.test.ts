// End-to-end audit enrichment: every audit row emitted from a session
// carries the MCP `clientInfo.name`/`version` captured at `initialize`,
// and per-call `agent_intent` from the structured `intent` tool arg.
//
// Drives buildServer() through the SDK's InMemoryTransport so the SDK's
// real initialize → tools/call sequence runs end-to-end.

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";
import { makeTestEngine, makeTestHandle } from "./_helpers.ts";

async function connect(opts: {
  clientName?: string;
  clientVersion?: string;
} = {}) {
  const { engine, executor, audit } = makeTestEngine();
  const handle = makeTestHandle({ engine, audit });
  const server = buildServer({ handle });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({
    name: opts.clientName ?? "claude-code",
    version: opts.clientVersion ?? "0.42.1",
  });
  await client.connect(clientTransport);

  return { client, executor, audit };
}

describe("audit enrichment — clientInfo capture", () => {
  test("agent_name + agent_version stamped on every audit row from the session", async () => {
    const { client, executor, audit } = await connect({
      clientName: "claude-code",
      clientVersion: "0.42.1",
    });
    executor.result = { rows: [{ id: 1 }], rowCount: 1 };

    await client.callTool({
      name: "query",
      arguments: { sql: "SELECT id FROM users", intent: "list user IDs" },
    });

    expect(audit.events.length).toBeGreaterThanOrEqual(3); // ATTEMPTED + DECIDED + EXECUTED
    for (const e of audit.events) {
      expect(e.agent_name).toBe("claude-code");
      expect(e.agent_version).toBe("0.42.1");
    }
    await client.close();
  });

  test("DENY path also carries agent identity (ATTEMPTED + DECIDED only)", async () => {
    const { client, audit } = await connect();
    await client.callTool({
      name: "query",
      arguments: { sql: "DELETE FROM users", intent: "remove old users" },
    });
    const types = audit.events.map((e) => e.event_type);
    expect(types).toContain("ATTEMPTED");
    expect(types).toContain("DECIDED");
    expect(types).not.toContain("EXECUTED");
    for (const e of audit.events) {
      expect(e.agent_name).toBe("claude-code");
      expect(e.agent_version).toBe("0.42.1");
    }
    await client.close();
  });
});

describe("audit enrichment — agent_intent (structured tool arg)", () => {
  test("intent on `query` arg stamps every event of the call", async () => {
    const { client, executor, audit } = await connect();
    executor.result = { rows: [], rowCount: 0 };

    await client.callTool({
      name: "query",
      arguments: { sql: "SELECT 1", intent: "warm the connection pool" },
    });

    const types = audit.events.map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(["ATTEMPTED", "DECIDED", "EXECUTED"]));

    // All events for the same query_id share the same intent.
    const queryIds = new Set(audit.events.map((e) => e.query_id));
    expect(queryIds.size).toBe(1);
    for (const e of audit.events) {
      expect(e.agent_intent).toBe("warm the connection pool");
    }
    await client.close();
  });

  test("missing intent → tool call rejected by SDK schema validator before engine sees it", async () => {
    const { client, audit } = await connect();

    // The SDK's tools/call handler validates args against the registered
    // zod inputSchema BEFORE invoking the tool — a missing required
    // `intent` surfaces as an isError result whose content names the
    // failing field, and the engine pipeline never runs (no audit row).
    const res = await client.callTool({
      name: "query",
      arguments: { sql: "SELECT 1" } as unknown as { sql: string; intent: string },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ text: string }>;
    expect(content[0]!.text).toMatch(/intent/i);

    expect(audit.events).toHaveLength(0);
    await client.close();
  });

  test("intent longer than 500 chars → schema rejects, no audit row", async () => {
    const { client, audit } = await connect();
    const longIntent = "a".repeat(501);

    const res = await client.callTool({
      name: "query",
      arguments: { sql: "SELECT 1", intent: longIntent },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ text: string }>;
    expect(content[0]!.text).toMatch(/intent/i);

    expect(audit.events).toHaveLength(0);
    await client.close();
  });

  test("blank-but-nonempty intent (whitespace, control chars) → rejected, no audit row", async () => {
    // Regression: zod's .min(1) fires on raw length, so " " or "\n\t"
    // would otherwise pass and stamp a non-null-but-useless string on the
    // audit row. The transform+refine pair sanitizes first and rejects on
    // empty-after-sanitize.
    for (const blankIntent of ["   ", "\t\n\r", "\x00\x01\x02", "  \n  \t  "]) {
      const { client, audit } = await connect();
      const res = await client.callTool({
        name: "query",
        arguments: { sql: "SELECT 1", intent: blankIntent },
      });
      expect(res.isError).toBe(true);
      const content = res.content as Array<{ text: string }>;
      expect(content[0]!.text).toMatch(/intent/i);
      expect(audit.events).toHaveLength(0);
      await client.close();
    }
  });

  test("intent with surrounding whitespace is trimmed before reaching the audit row", async () => {
    // Tool-boundary sanitization: the audit pipeline never sees the raw
    // string. Leading/trailing spaces and embedded control characters are
    // stripped so `agent_intent` renders cleanly in single-cell UIs.
    const { client, executor, audit } = await connect();
    executor.result = { rows: [], rowCount: 0 };

    await client.callTool({
      name: "query",
      arguments: { sql: "SELECT 1", intent: "  \tinvestigate slow lookup\n  " },
    });

    expect(audit.events.length).toBeGreaterThan(0);
    for (const e of audit.events) {
      expect(e.agent_intent).toBe("investigate slow lookup");
    }
    await client.close();
  });

  test("schema-browsing tools (list_tables, describe_table) write rows with agent_intent=null", async () => {
    const { client, executor, audit } = await connect();
    executor.result = { rows: [], rowCount: 0 };

    await client.callTool({ name: "list_tables", arguments: {} });
    await client.callTool({
      name: "describe_table",
      arguments: { table: "users" },
    });

    expect(audit.events.length).toBeGreaterThan(0);
    for (const e of audit.events) {
      expect(e.agent_intent).toBeNull();
    }
    await client.close();
  });
});
