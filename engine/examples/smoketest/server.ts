// Midplane Day 0 spike server.
// Goal: prove Bun + libpg-query + better-sqlite3 + MCP SDK work together in Docker.
// One MCP tool: query(sql). Pipeline: parse -> audit -> respond.

import { Database } from "bun:sqlite";
import { parseSync, loadModule } from "libpg-query";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";

const DB_PATH = process.env.DB_PATH ?? "/data/audit.db";
const PORT = Number(process.env.PORT ?? 8080);

const db = new Database(DB_PATH, { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run(`
  CREATE TABLE IF NOT EXISTS audit_events (
    id          TEXT PRIMARY KEY,
    query_id    TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    event_type  TEXT NOT NULL,
    payload     TEXT NOT NULL
  )
`);
const insertEvent = db.prepare(
  "INSERT INTO audit_events (id, query_id, ts, event_type, payload) VALUES (?, ?, ?, ?, ?)"
);

await loadModule();
parseSync("SELECT 1");
console.log("[spike] libpg-query warm");

const mcp = new McpServer({ name: "midplane-spike", version: "0.0.1" });

mcp.registerTool(
  "query",
  {
    title: "Run a SQL query (spike)",
    description: "Parses with libpg_query, writes audit event, returns AST stats.",
    inputSchema: { sql: z.string() },
  },
  async ({ sql }) => {
    const queryId = randomUUID();
    const ts = Date.now();
    insertEvent.run(randomUUID(), queryId, ts, "ATTEMPTED", JSON.stringify({ sql }));

    let parsedOk = false;
    let stmtCount = 0;
    let parseError: string | undefined;
    try {
      const ast = parseSync(sql);
      parsedOk = true;
      stmtCount = ast.stmts?.length ?? 0;
    } catch (e) {
      parseError = String(e);
    }

    insertEvent.run(
      randomUUID(),
      queryId,
      Date.now(),
      "DECIDED",
      JSON.stringify({ parsedOk, stmtCount, parseError })
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ queryId, parsedOk, stmtCount, parseError }, null, 2),
        },
      ],
    };
  }
);

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
});
await mcp.connect(transport);

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.url === "/health") {
    res.setHeader("content-type", "application/json");
    const count = db.prepare("SELECT COUNT(*) AS c FROM audit_events").get() as { c: number };
    res.end(JSON.stringify({ ok: true, audit_events: count.c }));
    return;
  }
  if (req.url?.startsWith("/mcp")) {
    await transport.handleRequest(req, res);
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`[spike] listening on :${PORT} — POST /mcp, GET /health`);
});
