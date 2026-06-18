// Midplane Day 0 spike — MCP test client.
// Connects to the spike server, runs a battery of queries, asserts behavior.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:8080/mcp";
const ITERATIONS = Number(process.env.ITERATIONS ?? 50);

type Trial = { sql: string; expectParsed: boolean; expectStmts?: number };
const trials: Trial[] = [
  { sql: "SELECT 1", expectParsed: true, expectStmts: 1 },
  { sql: "SELECT id, email FROM users WHERE org_id = 42 LIMIT 50", expectParsed: true, expectStmts: 1 },
  { sql: "DELETE FROM users", expectParsed: true, expectStmts: 1 },
  { sql: "SELECT 1; DROP TABLE users;", expectParsed: true, expectStmts: 2 },
  {
    sql: "WITH x AS (DELETE FROM sessions WHERE user_id != $1 RETURNING *) SELECT * FROM x",
    expectParsed: true,
    expectStmts: 1,
  },
  { sql: "this is not sql", expectParsed: false },
];

const client = new Client({ name: "midplane-spike-client", version: "0.0.1" });
const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL));
await client.connect(transport);

console.log(`[client] connected to ${SERVER_URL}`);
const tools = await client.listTools();
console.log(`[client] tools:`, tools.tools.map((t) => t.name).join(", "));

const t0 = Date.now();
let pass = 0;
let fail = 0;
for (let i = 0; i < ITERATIONS; i++) {
  const trial = trials[i % trials.length];
  const res = await client.callTool({ name: "query", arguments: { sql: trial.sql } });
  const text = (res.content?.[0] as { text?: string })?.text ?? "{}";
  const data = JSON.parse(text);

  const okParsed = data.parsedOk === trial.expectParsed;
  const okStmts = trial.expectStmts === undefined || data.stmtCount === trial.expectStmts;

  if (okParsed && okStmts) {
    pass++;
  } else {
    fail++;
    console.error(`[fail] iter=${i} sql="${trial.sql}" got=`, data, "expected=", trial);
  }
}
const elapsed = Date.now() - t0;

console.log(`\n[client] ${ITERATIONS} calls in ${elapsed}ms (${(elapsed / ITERATIONS).toFixed(1)}ms/call)`);
console.log(`[client] PASS=${pass} FAIL=${fail}`);

const health = await fetch(SERVER_URL.replace("/mcp", "/health")).then((r) => r.json());
console.log(`[client] health:`, health);

await client.close();
process.exit(fail > 0 ? 1 : 0);
