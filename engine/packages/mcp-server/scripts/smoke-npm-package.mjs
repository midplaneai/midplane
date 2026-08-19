#!/usr/bin/env node
// End-to-end smoke for the built npm package, run under Node.
//
//   SMOKE_DATABASE_URL=postgres://... node scripts/smoke-npm-package.mjs
//
// This is the check that the Bun→Node port actually holds. `bun test` proves
// the source works under Bun; it cannot prove that `npx midplane` works,
// because the three things most likely to break under Node are exactly the
// three the Bun suite never exercises:
//
//   1. the SQLite audit writer, which resolves node:sqlite instead of bun:sqlite
//   2. the SQL parser, whose libpg-query WASM loads from node_modules
//   3. the stdio transport, which is how every MCP client launches this
//
// So: spawn the real bundled bin over stdio the way a client does, drive a
// real MCP session against a real Postgres, and assert both the allow and the
// deny land in the audit log. Deliberately .mjs — it has to run on plain Node
// with no loader, no transpile step, exactly as a user's machine would.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import pg from "pg";

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(PKG_DIR, "dist", "cli.js");
const DSN = process.env.SMOKE_DATABASE_URL;

if (!DSN) {
  console.error("SMOKE_DATABASE_URL is required");
  process.exit(2);
}
if (!existsSync(BIN)) {
  console.error(`missing ${BIN} — run \`bun scripts/build-npm.ts\` first`);
  process.exit(2);
}

const workdir = mkdtempSync(join(tmpdir(), "midplane-node-smoke-"));
const dbPath = join(workdir, "audit.db");
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

// ── fixture ─────────────────────────────────────────────────────────────────
// Set up through a direct connection, not through midplane: DDL is exactly
// what the engine is supposed to refuse.
const admin = new pg.Client({ connectionString: DSN });
await admin.connect();
await admin.query("DROP TABLE IF EXISTS smoke_widgets");
await admin.query("CREATE TABLE smoke_widgets (id int primary key, name text)");
await admin.query("INSERT INTO smoke_widgets VALUES (1, 'alpha'), (2, 'beta')");
await admin.end();

// ── drive the bin over stdio, as an MCP client would ────────────────────────
const client = new Client({ name: "midplane-node-smoke", version: "0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [BIN, "server", "--stdio"],
  env: {
    PATH: process.env.PATH,
    DATABASE_URL: DSN,
    DB_PATH: dbPath,
    // The point is to exercise the shipped default policy: reads allowed,
    // writes and DDL denied, with no policy file at all.
    MIDPLANE_TELEMETRY: "0",
    LOG_LEVEL: "silent",
  },
  stderr: "pipe",
});

let serverStderr = "";
await client.connect(transport);
transport.stderr?.on("data", (d) => {
  serverStderr += String(d);
});

try {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check(
    "tools/list returns the three tools",
    names.join(",") === "describe_table,list_tables,query",
    names.join(","),
  );

  // 1. An allowed read. Proves the parser (libpg-query WASM under Node), the
  //    policy path, and the pg executor all work.
  const read = await client.callTool({
    name: "query",
    arguments: {
      sql: "SELECT id, name FROM smoke_widgets ORDER BY id",
      intent: "node package smoke: allowed read",
    },
  });
  const readText = read.content?.[0]?.text ?? "";
  check("SELECT is allowed and returns rows", readText.includes("alpha"), readText.slice(0, 120));

  // 2. A denied write. The default policy denies writes; a port that broke
  //    policy evaluation would show up here as an ALLOW, which is the
  //    failure that actually matters.
  const write = await client.callTool({
    name: "query",
    arguments: {
      sql: "DELETE FROM smoke_widgets WHERE id = 1",
      intent: "node package smoke: denied write",
    },
  });
  const writeText = write.content?.[0]?.text ?? "";
  check("DELETE is denied", /denied|not allowed/i.test(writeText), writeText.slice(0, 120));

  // 3. Stacked-statement injection, denied at parse time — the AST is doing
  //    real work, not pattern-matching.
  const stacked = await client.callTool({
    name: "query",
    arguments: {
      sql: "SELECT 1; DROP TABLE smoke_widgets",
      intent: "node package smoke: stacked statement",
    },
  });
  const stackedText = stacked.content?.[0]?.text ?? "";
  check(
    "stacked statement is denied",
    /denied|not allowed|multiple statements/i.test(stackedText),
    stackedText.slice(0, 120),
  );

  // 4. The row survived the denied DELETE — the deny is enforced, not just
  //    reported.
  const verify = new pg.Client({ connectionString: DSN });
  await verify.connect();
  const { rows } = await verify.query("SELECT count(*)::int AS n FROM smoke_widgets");
  await verify.end();
  check("denied DELETE did not execute", rows[0].n === 2, `${rows[0].n} rows`);
} finally {
  await client.close().catch(() => {});
}

// ── the audit log, read back through the shipped CLI ────────────────────────
// Uses `midplane audit`, not a direct SQLite open, so the reader half of the
// node:sqlite port is exercised too.
const audit = await run(process.execPath, [BIN, "audit", "since", "1h", "--json"], {
  DB_PATH: dbPath,
});
const events = audit.stdout
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

check("audit log is written and readable under Node", events.length > 0, `${events.length} events`);

// One tool call must produce exactly one query id. Regression guard for a
// bundling trap: index.ts once had an "am I the entry?" auto-run block, which
// is true for BOTH cli.js and the module inlined into it, so `midplane server`
// booted two servers on one stdio pipe and every query ran twice. It looked
// entirely healthy from the client side — only the audit log showed it.
const queryIds = new Set(events.map((e) => e.query_id));
check(
  "each tool call produced exactly one query id",
  queryIds.size === 3,
  `${queryIds.size} distinct query ids across 3 tool calls`,
);
const denials = events.filter(
  (e) => e.event_type === "DECIDED" && e.payload?.decision === "DENY",
);
check(
  "both denials are in the audit log, with their policy rule",
  denials.length === 2 &&
    denials.every((e) => typeof e.payload.policy_rule === "string"),
  denials.map((e) => e.payload.policy_rule).join(","),
);
check(
  "the allowed read is in the audit log",
  events.some((e) => e.event_type === "EXECUTED"),
);

// node:sqlite is still flagged experimental on Node 22 and prints a warning on
// first import. Harmless (stderr is not the MCP channel) but worth surfacing so
// nobody mistakes it for a real problem in CI output.
if (/ExperimentalWarning/.test(serverStderr)) {
  console.log("note  node:sqlite ExperimentalWarning present (expected on Node 22)");
}

rmSync(workdir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\nall checks passed on ${process.version}`);

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}
