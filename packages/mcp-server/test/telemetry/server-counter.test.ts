// Verifies tools.{name}.calls/allow/deny stays consistent with the audit
// pipeline on every tool exit path — including the case where the engine
// rethrows a Postgres execution error after auditing FAILED.
//
// This was a real bug: prior to the try/finally in server.ts, an engine
// throw bypassed recordToolCall(), so heartbeats could report
// exec_failures.count > 0 with tools.query.calls = 0 in the same window.

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/server.ts";
import type { TelemetryHandle } from "../../src/telemetry/index.ts";
import type { ToolName } from "../../src/telemetry/schema.ts";
import { makeTestEngine, baseCtx } from "../_helpers.ts";

interface Recorded {
  name: ToolName;
  allowed: boolean;
}

function recordingTelemetry(): { handle: TelemetryHandle; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const handle: TelemetryHandle = {
    wrap: (w) => w,
    recordToolCall: (name, allowed) => calls.push({ name, allowed }),
    markReady: () => {},
    async shutdown() {},
  };
  return { handle, calls };
}

async function connect(opts: {
  shouldThrow?: { sqlstate: string; message: string };
} = {}) {
  const { engine, executor, audit } = makeTestEngine();
  if (opts.shouldThrow) executor.shouldThrow = opts.shouldThrow;

  const { handle: telemetry, calls } = recordingTelemetry();
  const server = buildServer({
    handle: { engine, ctxBase: baseCtx, async close() {} },
    telemetry,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  return { client, executor, audit, calls };
}

describe("tool counter — consistency across exit paths", () => {
  test("ALLOW + exec success → calls=1, allow=1", async () => {
    const { client, executor, calls } = await connect();
    executor.result = { rows: [{ id: 1 }], rowCount: 1 };

    await client.callTool({ name: "query", arguments: { sql: "SELECT 1" } });

    expect(calls).toEqual([{ name: "query", allowed: true }]);
    await client.close();
  });

  test("DENY (policy) → calls=1, allow=0 (deny)", async () => {
    const { client, calls } = await connect();
    await client.callTool({ name: "query", arguments: { sql: "DELETE FROM users" } });

    expect(calls).toEqual([{ name: "query", allowed: false }]);
    await client.close();
  });

  test("ALLOW + exec throws (Postgres rejects) → calls=1, allow=0", async () => {
    // Regression for review finding #2. The engine rethrows the executor
    // error after writing a FAILED audit event. The tool handler MUST
    // still record the call as a deny so heartbeat aggregates stay
    // consistent with exec_failures.count.
    const { client, audit, calls } = await connect({
      shouldThrow: { sqlstate: "42P01", message: 'relation "x" does not exist' },
    });

    let threw = false;
    try {
      await client.callTool({ name: "query", arguments: { sql: "SELECT 1" } });
    } catch {
      threw = true;
    }
    // The MCP SDK surfaces the engine's rethrow as a tool error response.
    // Either path counts as a deny for telemetry purposes — what matters
    // is that the counter fired.
    expect(calls).toEqual([{ name: "query", allowed: false }]);

    // Audit should reflect the same: ATTEMPTED + DECIDED(ALLOW) + FAILED.
    const types = audit.events.map((e) => e.event_type);
    expect(types).toContain("FAILED");
    void threw;
    await client.close();
  });

  test("list_tables — same try/finally semantics", async () => {
    const { client, calls } = await connect({
      shouldThrow: { sqlstate: "08000", message: "connection broken" },
    });
    try {
      await client.callTool({ name: "list_tables", arguments: {} });
    } catch {
      // ignore
    }
    expect(calls).toEqual([{ name: "list_tables", allowed: false }]);
    await client.close();
  });

  test("describe_table — same try/finally semantics", async () => {
    const { client, calls } = await connect({
      shouldThrow: { sqlstate: "08000", message: "connection broken" },
    });
    try {
      await client.callTool({ name: "describe_table", arguments: { table: "users" } });
    } catch {
      // ignore
    }
    expect(calls).toEqual([{ name: "describe_table", allowed: false }]);
    await client.close();
  });
});
