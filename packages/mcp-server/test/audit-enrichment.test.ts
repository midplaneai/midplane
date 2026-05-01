// End-to-end audit enrichment: every audit row emitted from a session
// carries the MCP `clientInfo.name`/`version` captured at `initialize`,
// and per-call agent_intent/intent_source from the resolver.
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
      arguments: { sql: "SELECT id FROM users" },
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
      arguments: { sql: "DELETE FROM users" },
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

describe("audit enrichment — agent_intent (per-call)", () => {
  test("MCP _meta.intent stamps every event of the call, intent_source=mcp_meta", async () => {
    const { client, executor, audit } = await connect();
    executor.result = { rows: [], rowCount: 0 };

    await client.callTool({
      name: "query",
      arguments: { sql: "SELECT 1" },
      _meta: { intent: "warm the connection pool" },
    });

    const types = audit.events.map((e) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(["ATTEMPTED", "DECIDED", "EXECUTED"]));

    // All events for the same query_id share the same intent.
    const queryIds = new Set(audit.events.map((e) => e.query_id));
    expect(queryIds.size).toBe(1);
    for (const e of audit.events) {
      expect(e.agent_intent).toBe("warm the connection pool");
      expect(e.intent_source).toBe("mcp_meta");
    }
    await client.close();
  });

  test("SQL comment hint is captured AND stripped from forwarded SQL", async () => {
    const { client, executor, audit } = await connect();
    executor.result = { rows: [], rowCount: 0 };

    await client.callTool({
      name: "query",
      arguments: {
        sql: "/* midplane:intent=\"row-count audit\" */ SELECT count(*) FROM users",
      },
    });

    // Executor saw the cleaned SQL — the hint never reaches the database.
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]!.sql).toBe("SELECT count(*) FROM users");

    for (const e of audit.events) {
      expect(e.agent_intent).toBe("row-count audit");
      expect(e.intent_source).toBe("sql_comment");
    }
    // ATTEMPTED's sql_raw should also reflect the stripped SQL — the
    // engine sees what the executor sees.
    const attempted = audit.events.find((e) => e.event_type === "ATTEMPTED");
    expect(attempted).toBeDefined();
    if (attempted && attempted.event_type === "ATTEMPTED") {
      expect(attempted.payload.sql_raw).toBe("SELECT count(*) FROM users");
    }
    await client.close();
  });

  test("no channel populated → agent_intent and intent_source are null", async () => {
    const { client, executor, audit } = await connect();
    executor.result = { rows: [], rowCount: 0 };

    await client.callTool({
      name: "query",
      arguments: { sql: "SELECT 1" },
    });

    for (const e of audit.events) {
      expect(e.agent_intent).toBeNull();
      expect(e.intent_source).toBeNull();
    }
    await client.close();
  });

  test("_meta wins over SQL comment when both populated", async () => {
    const { client, executor, audit } = await connect();
    executor.result = { rows: [], rowCount: 0 };

    await client.callTool({
      name: "query",
      arguments: {
        sql: "/* midplane:intent=\"comment loses\" */ SELECT 1",
      },
      _meta: { intent: "meta wins" },
    });

    for (const e of audit.events) {
      expect(e.agent_intent).toBe("meta wins");
      expect(e.intent_source).toBe("mcp_meta");
    }
    await client.close();
  });
});

describe("audit enrichment — intent length cap", () => {
  test("intent longer than 500 chars is truncated, query still runs", async () => {
    const { client, executor, audit } = await connect();
    executor.result = { rows: [], rowCount: 0 };

    const longIntent = "a".repeat(800);
    const r = await client.callTool({
      name: "query",
      arguments: { sql: "SELECT 1" },
      _meta: { intent: longIntent },
    });

    // Tool call did not error out (truncate, not reject).
    expect(r.isError).toBeFalsy();
    for (const e of audit.events) {
      expect(e.agent_intent).not.toBeNull();
      expect(e.agent_intent!.length).toBe(500);
    }
    await client.close();
  });
});
