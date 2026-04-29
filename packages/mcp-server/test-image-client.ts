// MCP trial battery for the production Docker image.
// Mirrors examples/smoketest/client.ts in spirit but speaks to the V1
// `query` tool, whose response shape is {allowed, ...} not {parsedOk, ...}.
//
// Asserts each of the V1 demo decision paths:
//   - allowed read: SELECT 1 executes against the sidecar Postgres
//   - writes_require_approval: DELETE FROM users denied
//   - multi_statement: SELECT 1; DROP TABLE users denied
//   - parse_error: garbage input denied

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:8080/mcp";

type Trial =
  | { sql: string; expect: { allowed: true; rowCount?: number } }
  | { sql: string; expect: { allowed: false; policy_rule: string } };

const trials: Trial[] = [
  { sql: "SELECT 1", expect: { allowed: true, rowCount: 1 } },
  { sql: "DELETE FROM users", expect: { allowed: false, policy_rule: "writes_require_approval" } },
  { sql: "SELECT 1; DROP TABLE users;", expect: { allowed: false, policy_rule: "multi_statement" } },
  { sql: "this is not sql", expect: { allowed: false, policy_rule: "parse_error" } },
];

const client = new Client({ name: "midplane-test-image-client", version: "0.0.1" });
const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL));
await client.connect(transport);

console.log(`[client] connected to ${SERVER_URL}`);
const tools = await client.listTools();
console.log(`[client] tools: ${tools.tools.map((t) => t.name).join(", ")}`);

let pass = 0;
let fail = 0;
for (const trial of trials) {
  const res = await client.callTool({ name: "query", arguments: { sql: trial.sql } });
  const text = (res.content?.[0] as { text?: string })?.text ?? "{}";
  const data = JSON.parse(text) as Record<string, unknown>;

  let ok = false;
  if (trial.expect.allowed) {
    ok =
      data.allowed === true &&
      (trial.expect.rowCount === undefined || data.rowCount === trial.expect.rowCount);
  } else {
    ok = data.allowed === false && data.policy_rule === trial.expect.policy_rule;
  }

  if (ok) {
    pass++;
    console.log(`[pass] ${JSON.stringify(trial.sql)} → ${JSON.stringify(data)}`);
  } else {
    fail++;
    console.error(`[fail] ${JSON.stringify(trial.sql)} expected=${JSON.stringify(trial.expect)} got=${JSON.stringify(data)}`);
  }
}

console.log(`\n[client] PASS=${pass} FAIL=${fail}`);

const health = await fetch(SERVER_URL.replace("/mcp", "/health")).then((r) => r.json());
console.log(`[client] /health: ${JSON.stringify(health)}`);

await client.close();
process.exit(fail > 0 ? 1 : 0);
