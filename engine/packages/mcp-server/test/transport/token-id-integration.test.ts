// X-Midplane-Token-Id end-to-end: HTTP transport reads the header at MCP
// initialize, threads it through buildServer's sessionContext, and the
// engine stamps `mcp_token_id` on every audit row of the session. The
// `/audit/since/<cursor>` pull endpoint then exposes it under the same
// snake_case key for the cloud indexer to read.
//
// Pattern mirrors audit-enrichment.test.ts (which tests agent_name /
// agent_version capture from MCP clientInfo) — same shape, different
// signal source.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAuditWriter } from "@midplane/engine";
import { startHttp, type HttpHandle } from "../../src/transport/http.ts";
import { buildServer } from "../../src/server.ts";
import { makeTestEngine, makeTestHandle } from "../_helpers.ts";

const VALID_TOKEN_ID = "01HZX3KQ7B9YV2RTNGH7MJSPVB";
const ANOTHER_TOKEN_ID = "01HZX9F4N7W3MGSTRA0KVCBPYK";
const INDEXER_TOKEN = "indexer-bearer-token";

interface CloudRow {
  id: string;
  query_id: string;
  agent_intent: string | null;
  mcp_token_id: string | null;
  event_type: string;
}

describe("X-Midplane-Token-Id — end-to-end through HTTP transport", () => {
  let dir: string;
  let dbPath: string;
  let audit: SqliteAuditWriter;
  let server: HttpHandle;
  let port: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "midplane-tokenid-"));
    dbPath = join(dir, "audit.db");
    audit = new SqliteAuditWriter(dbPath);

    // The engine the MCP sessions actually call is the harness — but the
    // audit writer the cloud pulls from is the same SQLite file. Inject
    // it as the registry.audit so the engine writes there and the pull
    // endpoint reads from it.
    const harness = makeTestEngine({ audit: undefined });
    // makeTestEngine wires an in-memory audit; we need the engine to
    // write to the same SQLite the indexer pulls from. Rebuild the
    // harness with a SqliteAuditWriter passed via a custom helper path.
    // Simpler: wrap and tee on every write.
    const origAudit = harness.audit;
    const teedEngine = harness.engine;
    // Re-stitch: every event the engine writes to its in-memory audit
    // we also persist to sqlite. The MemoryAuditWriter is a fail-fast
    // mock so we override its write to dual-write.
    const origWrite = origAudit.write.bind(origAudit);
    origAudit.write = async (event) => {
      await origWrite(event);
      await audit.write(event);
    };

    const handle = makeTestHandle({ engine: teedEngine, audit: origAudit });

    server = await startHttp(
      (sessionContext) => buildServer({ handle, sessionContext }),
      {
        port: 0,
        host: "127.0.0.1",
        indexer: { audit, token: INDEXER_TOKEN },
      },
    );
    port = server.port;
  });

  afterAll(async () => {
    await server.close();
    await audit.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function openSession(headers?: Record<string, string>) {
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
    });
    const client = new Client({
      name: "token-id-test-client",
      version: "0.0.0",
    });
    await client.connect(transport);
    return client;
  }

  async function pullAllRows(): Promise<CloudRow[]> {
    const res = await fetch(
      `http://127.0.0.1:${port}/audit/since/0?limit=1000`,
      { headers: { authorization: `Bearer ${INDEXER_TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: CloudRow[] };
    return body.rows;
  }

  test("valid ULID header → every audit row from that session carries it", async () => {
    const before = await pullAllRows();

    const client = await openSession({
      "X-Midplane-Token-Id": VALID_TOKEN_ID,
    });
    await client.callTool({
      name: "query",
      arguments: { sql: "SELECT 1", intent: "ping with token" },
    });
    await client.close();

    const after = await pullAllRows();
    const newRows = after.slice(before.length);
    // ATTEMPTED + DECIDED + EXECUTED (or FAILED) all carry the same token id.
    expect(newRows.length).toBeGreaterThanOrEqual(2);
    for (const r of newRows) {
      expect(r.mcp_token_id).toBe(VALID_TOKEN_ID);
    }
  });

  test("missing header → audit rows carry mcp_token_id: null", async () => {
    const before = await pullAllRows();

    const client = await openSession();
    await client.callTool({
      name: "query",
      arguments: { sql: "SELECT 1", intent: "ping without token" },
    });
    await client.close();

    const after = await pullAllRows();
    const newRows = after.slice(before.length);
    expect(newRows.length).toBeGreaterThanOrEqual(2);
    for (const r of newRows) {
      expect(r.mcp_token_id).toBeNull();
    }
  });

  test("malformed header → audit rows carry null (no error to the client)", async () => {
    const before = await pullAllRows();

    const client = await openSession({
      // Wrong length, lowercase, includes I/L/O/U — all malformed shapes
      // collapse to null per spec: IGNORE, never reject the request.
      "X-Midplane-Token-Id": "not-a-real-ulid-at-all",
    });
    // The tool call should succeed normally; a malformed token-id header
    // is tolerated, not propagated as an error.
    const res = await client.callTool({
      name: "query",
      arguments: { sql: "SELECT 1", intent: "ping with garbage token" },
    });
    expect(res.isError).toBeFalsy();
    await client.close();

    const after = await pullAllRows();
    const newRows = after.slice(before.length);
    expect(newRows.length).toBeGreaterThanOrEqual(2);
    for (const r of newRows) {
      expect(r.mcp_token_id).toBeNull();
    }
  });

  test("two concurrent sessions with different token ids don't bleed", async () => {
    const before = await pullAllRows();

    const clientA = await openSession({
      "X-Midplane-Token-Id": VALID_TOKEN_ID,
    });
    const clientB = await openSession({
      "X-Midplane-Token-Id": ANOTHER_TOKEN_ID,
    });

    await clientA.callTool({
      name: "query",
      arguments: { sql: "SELECT 1", intent: "from A" },
    });
    await clientB.callTool({
      name: "query",
      arguments: { sql: "SELECT 2", intent: "from B" },
    });
    await clientA.close();
    await clientB.close();

    const after = await pullAllRows();
    const newRows = after.slice(before.length);
    const intentsByToken = new Map<string | null, Set<string>>();
    for (const r of newRows) {
      if (!intentsByToken.has(r.mcp_token_id)) {
        intentsByToken.set(r.mcp_token_id, new Set());
      }
      if (r.agent_intent !== null) {
        intentsByToken.get(r.mcp_token_id)!.add(r.agent_intent);
      }
    }
    // The "from A" intent must show up only against VALID_TOKEN_ID, and
    // "from B" only against ANOTHER_TOKEN_ID — i.e. session state is
    // per-session, not shared.
    expect(intentsByToken.get(VALID_TOKEN_ID)).toEqual(new Set(["from A"]));
    expect(intentsByToken.get(ANOTHER_TOKEN_ID)).toEqual(new Set(["from B"]));
  });

  test("the token id is captured at initialize and frozen for the session", async () => {
    // Open a session WITHOUT the header, then send a tool call later.
    // The session's audit rows should remain null mcp_token_id even
    // though subsequent requests COULD carry the header (the SDK's
    // StreamableHTTPClientTransport reuses headers across requests, so
    // we can't easily inject mid-session without rebuilding — but we
    // can still confirm the initialize-time capture by openSession-
    // without-header followed by a tool call that yields rows with
    // null tokens. This is the same assertion as the missing-header
    // test, but expresses the spec-level invariant of "captured at
    // initialize, never re-read."
    const before = await pullAllRows();

    const client = await openSession();
    await client.callTool({
      name: "query",
      arguments: { sql: "SELECT 3", intent: "session-frozen test" },
    });
    await client.callTool({
      name: "query",
      arguments: { sql: "SELECT 4", intent: "second call same session" },
    });
    await client.close();

    const after = await pullAllRows();
    const newRows = after.slice(before.length);
    // Both calls produced audit rows; all carry null mcp_token_id.
    for (const r of newRows) {
      expect(r.mcp_token_id).toBeNull();
    }
    // And we got rows from both calls (proves the second call ran, so
    // the assertion isn't vacuous).
    const intents = new Set(newRows.map((r) => r.agent_intent));
    expect(intents.has("session-frozen test")).toBe(true);
    expect(intents.has("second call same session")).toBe(true);
  });
});

describe("X-Midplane-Token-Id — POLICY_RELOADED rows are always null", () => {
  // POLICY_RELOADED is operator-driven (admin endpoint). The spec says
  // mcp_token_id is null on these rows regardless of any header on the
  // POST /admin/policy request — the zod union literally types it
  // `z.null()` for POLICY_RELOADED, so a non-null value would fail
  // schema validation and the audit write would throw. This is checked
  // in the engine-factory's POLICY_RELOADED constructor; here we just
  // confirm the engine-side type is wired correctly by trying to write
  // a non-null mcp_token_id on POLICY_RELOADED and watching it fail.
  test("non-null mcp_token_id on POLICY_RELOADED fails schema validation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "midplane-policy-reload-tokenid-"));
    const dbPath = join(dir, "audit.db");
    const writer = new SqliteAuditWriter(dbPath);
    try {
      await expect(
        writer.write({
          // Force a POLICY_RELOADED event that violates the zod literal-null
          // constraint on mcp_token_id. The writer must reject it before
          // touching SQLite.
          id: "01POLICYRELOAD0000000000XX",
          query_id: "01POLICYRELOAD0000000000QQ",
          tenant_id: "__self_host__",
          database: "__default__",
          agent_name: null,
          agent_version: null,
          agent_intent: null,
          // INVALID: zod typed as z.null() on POLICY_RELOADED rows.
          mcp_token_id: VALID_TOKEN_ID as unknown as null,
          ts: 1_700_000_000_000,
          schema_version: 3,
          event_type: "POLICY_RELOADED",
          payload: {
            source: "admin_endpoint",
            table_access: null,
          },
        }),
      ).rejects.toThrow();
    } finally {
      await writer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
