// HTTP transport — boots a real httpServer + StreamableHTTP transport, drives
// it from an MCP Client. Same shape as examples/smoketest/client.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAuditWriter, type AuditEvent } from "@midplane/engine";
import { startHttp, type HttpHandle } from "../../src/transport/http.ts";
import { buildServer } from "../../src/server.ts";
import { makeTestEngine, baseCtx, type MockExecutor } from "../_helpers.ts";

let httpHandle: HttpHandle;
let executor: MockExecutor;

beforeAll(async () => {
  const harness = makeTestEngine();
  executor = harness.executor;
  const handle = {
    engine: harness.engine,
    ctxBase: baseCtx,
    async close() {},
  };
  // Port 0 = OS picks free port.
  httpHandle = await startHttp(() => buildServer({ handle }), {
    port: 0,
    host: "127.0.0.1",
  });
});

afterAll(async () => {
  await httpHandle.close();
});

describe("http transport", () => {
  test("GET /health returns ok", async () => {
    const res = await fetch(`http://127.0.0.1:${httpHandle.port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  test("MCP client lists three tools and calls each", async () => {
    const url = new URL(`http://127.0.0.1:${httpHandle.port}/mcp`);
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client({ name: "http-test-client", version: "0.0.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["describe_table", "list_tables", "query"]);

    // query
    executor.result = { rows: [{ ok: 1 }], rowCount: 1 };
    const q = await client.callTool({ name: "query", arguments: { sql: "SELECT 1" } });
    expect(q.isError).toBeFalsy();

    // list_tables
    executor.result = {
      rows: [{ table_schema: "public", table_name: "users" }],
      rowCount: 1,
    };
    const lt = await client.callTool({ name: "list_tables", arguments: {} });
    const ltContent = lt.content as Array<{ text: string }>;
    const ltData = JSON.parse(ltContent[0]!.text);
    expect(ltData.tables[0]?.name).toBe("users");

    // describe_table
    executor.result = {
      rows: [
        {
          column_name: "id",
          data_type: "integer",
          is_nullable: "NO",
          column_default: null,
        },
      ],
      rowCount: 1,
    };
    const dt = await client.callTool({
      name: "describe_table",
      arguments: { table: "users" },
    });
    const dtContent = dt.content as Array<{ text: string }>;
    const dtData = JSON.parse(dtContent[0]!.text);
    expect(dtData.columns[0]?.name).toBe("id");

    await client.close();
  });

  test("startHttp rejects when the requested port is already in use", async () => {
    // Hold a port so the bind below collides.
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.once("listening", () => resolve());
      blocker.listen(0, "127.0.0.1");
    });
    const addr = blocker.address();
    const blockedPort = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const harness = makeTestEngine();
      const handle = {
        engine: harness.engine,
        ctxBase: baseCtx,
        async close() {},
      };
      await expect(
        startHttp(() => buildServer({ handle }), {
          port: blockedPort,
          host: "127.0.0.1",
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  test("audit pull routes 404 when INDEXER_TOKEN is unset", async () => {
    // The default httpHandle in this describe block was started without
    // `indexer`, simulating a self-host with no token configured.
    const r1 = await fetch(`http://127.0.0.1:${httpHandle.port}/audit/since/0`);
    expect(r1.status).toBe(404);
    const r2 = await fetch(`http://127.0.0.1:${httpHandle.port}/audit/before/01X`, {
      method: "DELETE",
    });
    expect(r2.status).toBe(404);
  });

  test("DENY (DELETE) routes to isError tool result, not transport error", async () => {
    const url = new URL(`http://127.0.0.1:${httpHandle.port}/mcp`);
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client({ name: "http-test-client-2", version: "0.0.0" });
    await client.connect(transport);

    const res = await client.callTool({
      name: "query",
      arguments: { sql: "DELETE FROM users" },
    });
    expect(res.isError).toBe(true);
    const content = res.content as Array<{ text: string }>;
    const data = JSON.parse(content[0]!.text);
    expect(data.policy_rule).toBe("table_access");

    await client.close();
  });
});

describe("http transport — audit indexer pull endpoints", () => {
  const TOKEN = "test-indexer-token-xyz";
  let dir: string;
  let dbPath: string;
  let audit: SqliteAuditWriter;
  let server: HttpHandle;

  // Build a unique 26-char id from a 4-digit counter so we can address rows
  // deterministically. Lex order of these strings matches insertion order.
  function idAt(n: number): string {
    return `01TESTID00000000000000${String(n).padStart(4, "0")}`;
  }

  function attemptedEvent(n: number): AuditEvent {
    return {
      id: idAt(n),
      query_id: `Q${n}`,
      tenant_id: "__self_host__",
      agent_identity: null,
      ts: 1_700_000_000_000 + n,
      schema_version: 1,
      event_type: "ATTEMPTED",
      payload: {
        sql_raw: "SELECT 1",
        sql_fingerprint: "0123456789abcdef",
      },
    };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "midplane-http-audit-"));
    dbPath = join(dir, "audit.db");
    audit = new SqliteAuditWriter(dbPath);

    const harness = makeTestEngine();
    const handle = {
      engine: harness.engine,
      ctxBase: baseCtx,
      audit,
      async close() {},
    };

    server = await startHttp(() => buildServer({ handle }), {
      port: 0,
      host: "127.0.0.1",
      indexer: { audit, token: TOKEN },
    });
  });

  afterAll(async () => {
    await server.close();
    await audit.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function url(path: string): string {
    return `http://127.0.0.1:${server.port}${path}`;
  }

  test("missing bearer → 401", async () => {
    const res = await fetch(url("/audit/since/0"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
  });

  test("wrong bearer (different length) → 401", async () => {
    const res = await fetch(url("/audit/since/0"), {
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(res.status).toBe(401);
  });

  test("wrong bearer (same length, different bytes) → 401", async () => {
    // Same length as TOKEN forces the timingSafeEqual branch (which throws on
    // mismatched lengths). If the implementation skipped the length check
    // before timingSafeEqual, this case still returns 401 cleanly.
    const wrong = "x".repeat(TOKEN.length);
    expect(wrong.length).toBe(TOKEN.length);
    const res = await fetch(url("/audit/since/0"), {
      headers: { authorization: `Bearer ${wrong}` },
    });
    expect(res.status).toBe(401);
  });

  test("right bearer + empty DB → rows: [], next_cursor: null", async () => {
    const res = await fetch(url("/audit/since/0"), {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ rows: [], next_cursor: null });
  });

  test("paginates 750 rows in two batches; payload round-trips parsed", async () => {
    for (let i = 0; i < 750; i++) {
      await audit.write(attemptedEvent(i));
    }

    const r1 = await fetch(url("/audit/since/0?limit=500"), {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as {
      rows: Array<{ id: string; payload: unknown }>;
      next_cursor: string | null;
    };
    expect(b1.rows.length).toBe(500);
    expect(b1.next_cursor).toBe(b1.rows[499]!.id);
    // Payload is a parsed object, not a JSON string.
    expect(b1.rows[0]!.payload).toEqual({
      sql_raw: "SELECT 1",
      sql_fingerprint: "0123456789abcdef",
    });

    const r2 = await fetch(url(`/audit/since/${b1.next_cursor}?limit=500`), {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as {
      rows: Array<{ id: string }>;
      next_cursor: string | null;
    };
    expect(b2.rows.length).toBe(250);
    expect(b2.next_cursor).toBeNull();
    // Together the two batches cover the full set without overlap.
    expect(b2.rows[0]!.id).toBe(idAt(500));
    expect(b2.rows[249]!.id).toBe(idAt(749));
  });

  test("DELETE /audit/before/:id is inclusive and idempotent", async () => {
    // 750 rows are still in the DB from the previous test. Delete the first
    // 100 (ids 0..99) and confirm the next read starts at id 100.
    const midId = idAt(99);
    const d1 = await fetch(url(`/audit/before/${midId}`), {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(d1.status).toBe(200);
    expect(await d1.json()).toEqual({ deleted: 100 });

    // Idempotent: same id deleted again returns 0.
    const d2 = await fetch(url(`/audit/before/${midId}`), {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(d2.status).toBe(200);
    expect(await d2.json()).toEqual({ deleted: 0 });

    // Read after delete: only post-mid rows remain.
    const r = await fetch(url("/audit/since/0?limit=1"), {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = (await r.json()) as { rows: Array<{ id: string }> };
    expect(body.rows[0]!.id).toBe(idAt(100));
  });

  test("limit clamps to max of 1000", async () => {
    const r = await fetch(url("/audit/since/0?limit=99999"), {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { rows: unknown[] };
    // Only 650 rows remain (750 seeded - 100 deleted), still under 1000.
    expect(body.rows.length).toBe(650);
  });
});
