// Wire-level handshake test: boots an in-process Streamable HTTP transport
// and runs verify-mcp-handshake.ts against it. The verifier doesn't use the
// MCP SDK — it speaks raw HTTP. So this test fails when our wire contract
// drifts (header casing, status codes, SSE/JSON content negotiation, session
// rejection rules), independent of any SDK behavior.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startHttp, type HttpHandle } from "../../src/transport/http.ts";
import { buildServer } from "../../src/server.ts";
import { makeTestEngine, makeTestHandle, type MockExecutor } from "../_helpers.ts";
import { verifyHandshake } from "../../verify-mcp-handshake.ts";

let httpHandle: HttpHandle;

beforeAll(async () => {
  const harness = makeTestEngine();
  const executor: MockExecutor = harness.executor;
  // The verifier expects allowed=true for SELECT 1; the mock returns
  // whatever we set here. Denials don't reach the executor at all.
  executor.result = { rows: [{ "?column?": 1 }], rowCount: 1 };

  const handle = makeTestHandle({ engine: harness.engine, audit: harness.audit });
  httpHandle = await startHttp(() => buildServer({ handle }), {
    port: 0,
    host: "127.0.0.1",
  });
});

afterAll(async () => {
  await httpHandle.close();
});

describe("Streamable HTTP wire handshake", () => {
  test("verifyHandshake passes against in-process transport", async () => {
    const url = `http://127.0.0.1:${httpHandle.port}/mcp`;
    const report = await verifyHandshake(url);
    if (report.fail > 0) {
      console.log(report.log.join("\n"));
    }
    expect(report.fail).toBe(0);
    expect(report.pass).toBeGreaterThan(8);
  });
});
