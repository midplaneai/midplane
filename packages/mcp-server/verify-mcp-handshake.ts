// Wire-level Streamable HTTP handshake verifier.
//
// Drives our transport via raw fetch (no MCP SDK), simulating exactly what
// Cursor / Claude Code / Claude Desktop send on the wire. Catches protocol
// drift — wrong status code, missing mcp-session-id header, SSE vs JSON
// negotiation, bad protocol-version handling — without needing a desktop
// agent installed.
//
// Sequence:
//   1. POST initialize         → 200, mcp-session-id header
//   2. POST notifications/initialized  → 202
//   3. POST tools/list w/o session-id  → 400 (negative check)
//   4. POST tools/list with session-id → 200, three tools
//   5. POST tools/call for each demo path (allowed read + 3 denials)
//
// Lives in packages/mcp-server/ (alongside test-image-client.ts) for the
// same reason: bun's isolated install layout resolves @modelcontextprotocol
// only from the workspace where it's declared. We don't import the SDK
// here — but co-locating with the integration battery keeps related
// scripts in one place.
//
// Standalone: SERVER_URL=http://localhost:8080/mcp bun run packages/mcp-server/verify-mcp-handshake.ts
// Test: imported by test/transport/handshake-wire.test.ts; runs as part of `bun test`.
//
// Protocol version: imported from the SDK so this verifier always exercises
// the same version the SDK's clients negotiate. If a future SDK bump moves
// the latest version forward and our server regresses on it, this test fails
// — even if the server still accepts older versions on the side.

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

const MCP_PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PostResult {
  status: number;
  headers: Headers;
  payload: JsonRpcResponse | undefined;
  raw: string;
}

async function postRpc(
  url: string,
  body: unknown,
  sessionId?: string,
): Promise<PostResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";

  let payload: JsonRpcResponse | undefined;
  if (text.length === 0) {
    payload = undefined;
  } else if (ct.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data: ")) continue;
      try {
        const obj = JSON.parse(line.slice(6));
        if (obj && typeof obj === "object" && ("result" in obj || "error" in obj)) {
          payload = obj as JsonRpcResponse;
          break;
        }
      } catch {
        // ignore non-JSON SSE comment / heartbeat lines
      }
    }
  } else if (ct.includes("application/json")) {
    try {
      payload = JSON.parse(text) as JsonRpcResponse;
    } catch {
      payload = undefined;
    }
  }

  return { status: res.status, headers: res.headers, payload, raw: text };
}

export interface HandshakeReport {
  pass: number;
  fail: number;
  log: string[];
}

export async function verifyHandshake(url: string): Promise<HandshakeReport> {
  const log: string[] = [];
  let pass = 0;
  let fail = 0;
  const ok = (msg: string) => {
    pass++;
    log.push(`[pass] ${msg}`);
  };
  const ng = (msg: string) => {
    fail++;
    log.push(`[fail] ${msg}`);
  };

  const init = await postRpc(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "midplane-handshake-verifier", version: "0.0.1" },
    },
  });
  if (init.status === 200) ok("initialize: status 200");
  else ng(`initialize: expected 200, got ${init.status}`);

  const sessionId = init.headers.get("mcp-session-id");
  if (sessionId) ok(`initialize: mcp-session-id present (${sessionId.slice(0, 8)}…)`);
  else ng("initialize: server did not return mcp-session-id header");

  if (init.payload?.result && typeof init.payload.result === "object") {
    ok("initialize: JSON-RPC result body present");
  } else {
    ng(`initialize: missing result body (raw=${init.raw.slice(0, 200)})`);
  }

  if (!sessionId) {
    return { pass, fail, log };
  }

  const initd = await postRpc(
    url,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
  );
  // SDK returns 202 Accepted for notifications; some implementations return 200.
  if (initd.status === 202 || initd.status === 200) {
    ok(`notifications/initialized: status ${initd.status}`);
  } else {
    ng(`notifications/initialized: unexpected status ${initd.status}`);
  }

  const bad = await postRpc(url, {
    jsonrpc: "2.0",
    id: 99,
    method: "tools/list",
  });
  if (bad.status === 400) ok("non-init POST w/o session-id: 400 (rejected)");
  else ng(`non-init POST w/o session-id: expected 400, got ${bad.status}`);

  const list = await postRpc(
    url,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    sessionId,
  );
  if (list.status !== 200) {
    ng(`tools/list: status ${list.status}`);
  } else {
    const tools =
      (list.payload?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? [];
    const names = tools.map((t) => t.name).sort().join(",");
    if (names === "describe_table,list_tables,query") {
      ok("tools/list: query, list_tables, describe_table");
    } else {
      ng(`tools/list: expected three tools, got [${names}]`);
    }
  }

  type Trial =
    | { label: string; sql: string; expect: { allowed: true } }
    | { label: string; sql: string; expect: { allowed: false; rule: string } };

  const trials: Trial[] = [
    { label: "allowed read", sql: "SELECT 1", expect: { allowed: true } },
    {
      label: "table_access",
      sql: "DELETE FROM users",
      expect: { allowed: false, rule: "table_access" },
    },
    {
      label: "multi_statement",
      sql: "SELECT 1; DROP TABLE users;",
      expect: { allowed: false, rule: "multi_statement" },
    },
    {
      label: "parse_error",
      sql: "this is not sql",
      expect: { allowed: false, rule: "parse_error" },
    },
  ];

  let id = 3;
  for (const trial of trials) {
    const res = await postRpc(
      url,
      {
        jsonrpc: "2.0",
        id: id++,
        method: "tools/call",
        params: {
          name: "query",
          arguments: { sql: trial.sql, intent: `handshake check: ${trial.label}` },
        },
      },
      sessionId,
    );
    if (res.status !== 200) {
      ng(`tools/call ${trial.label}: status ${res.status}`);
      continue;
    }
    const result = res.payload?.result as
      | { content?: Array<{ text?: string }>; isError?: boolean }
      | undefined;
    const text = result?.content?.[0]?.text ?? "{}";
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text);
    } catch {
      ng(`tools/call ${trial.label}: tool body not JSON (${text.slice(0, 80)})`);
      continue;
    }
    if (trial.expect.allowed) {
      if (data.allowed === true) ok(`tools/call ${trial.label}: allowed`);
      else ng(`tools/call ${trial.label}: expected allowed, got ${JSON.stringify(data)}`);
    } else {
      if (data.allowed === false && data.policy_rule === trial.expect.rule) {
        ok(`tools/call ${trial.label}: denied (${trial.expect.rule})`);
      } else {
        ng(
          `tools/call ${trial.label}: expected denial rule=${trial.expect.rule}, got ${JSON.stringify(data)}`,
        );
      }
    }
  }

  return { pass, fail, log };
}

if (import.meta.main) {
  const SERVER_URL = process.env.SERVER_URL ?? "http://127.0.0.1:8080/mcp";
  const report = await verifyHandshake(SERVER_URL);
  for (const line of report.log) console.log(line);
  console.log(`\nPASS=${report.pass} FAIL=${report.fail}`);
  process.exit(report.fail > 0 ? 1 : 0);
}
