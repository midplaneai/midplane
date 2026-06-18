// Live end-to-end: spawn OSS container with INDEXER_TOKEN, run a query,
// indexer drains audit_events_index, retention sweep deletes old rows.
//
// Gated on:
//   - E2E_LIVE=1
//   - midplane/midplane image carrying GET /audit/since + DELETE /audit/before
//     (upstream PR landed). When the image is older, the GET returns 404 and
//     this suite fails fast with a clear message rather than hanging on
//     polling that never produces rows.
//   - INDEXER_TOKEN exported (any value; the test sets one if absent).
//
// The /mcp/<token> handshake + audit-write path is already covered by
// mcp-proxy.live.e2e.ts. This suite focuses on the *indexer* — given that
// audit rows exist in container SQLite, do they reach audit_events_index
// and does retention prune them after the grace window?

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import { and, eq, gte } from "drizzle-orm";

import {
  auditEventsIndex,
  connections,
  customers,
  getDb,
  indexerCursors,
} from "@midplane-cloud/db";

import { containerNameFor, seedConnection } from "./_seed-helpers";

test.skip(
  process.env.E2E_LIVE !== "1",
  "set E2E_LIVE=1 to run live indexer E2E (requires Docker + Neon + OSS image with /audit/since)",
);

const PG_NAME = `midplane-e2e-pg-idx-${Date.now()}`;
const PG_PASSWORD = "postgres";
const PG_DB = "midplane_e2e_idx";
const INDEXER_TOKEN = process.env.INDEXER_TOKEN ?? `idx-${randomUUID()}`;

let pgPort = 0;
let mcpToken = "";
let tokenId = "";
let customerId = "";
let connectionId = "";
let containerName = "";

test.beforeAll(async () => {
  // Sidecar Postgres for the customer DB.
  execSync(
    `docker run -d --rm --name ${PG_NAME} -e POSTGRES_PASSWORD=${PG_PASSWORD} -e POSTGRES_DB=${PG_DB} -p 0:5432 postgres:16-alpine`,
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const portOut = execSync(`docker port ${PG_NAME} 5432`).toString();
  const m = /:(\d+)$/m.exec(portOut.split(/\r?\n/)[0] ?? "");
  if (!m?.[1]) throw new Error(`could not parse pg port: ${portOut}`);
  pgPort = Number(m[1]);
  await waitForPgDb();
  execSync(
    `docker exec ${PG_NAME} psql -U postgres -d ${PG_DB} -c "CREATE TABLE t (n int); INSERT INTO t VALUES (1);"`,
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const customerDsn = `postgres://postgres:${PG_PASSWORD}@host.docker.internal:${pgPort}/${PG_DB}`;
  const seeded = await seedConnection({ region: "eu", dsn: customerDsn });
  customerId = seeded.customerId;
  connectionId = seeded.connectionId;
  mcpToken = seeded.tokenPlaintext;
  tokenId = seeded.tokenId;
  containerName = containerNameFor(connectionId);
});

test.afterAll(async () => {
  try {
    execSync(`docker rm -f ${PG_NAME}`, { stdio: "ignore" });
  } catch {}
  if (containerName) {
    try {
      execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
    } catch {}
  }
  const db = getDb("eu");
  if (connectionId) {
    // FK ON DELETE SET NULL flips connection_id to NULL when the
    // connection row is dropped; explicitly delete any cursor row first
    // so the test doesn't leak orphans into the dev DB.
    await db
      .delete(indexerCursors)
      .where(eq(indexerCursors.connectionId, connectionId));
    await db.delete(connections).where(eq(connections.id, connectionId));
  }
  if (customerId) {
    await db.delete(customers).where(eq(customers.id, customerId));
    await db
      .delete(auditEventsIndex)
      .where(eq(auditEventsIndex.customerId, customerId));
  }
});

test("indexer drains container audit rows into audit_events_index within 15s", async ({
  request,
  baseURL,
}) => {
  // Step 1: drive the proxy so a container spawns with INDEXER_TOKEN set.
  // getMcpProxyContext() in the dev server reads INDEXER_TOKEN from env
  // (the playwright config forwards .env.local), passes it through
  // DockerSpawner, and starts the singleton Indexer that drives the
  // 5-second polling cadence. We don't construct a competing Indexer
  // here — we observe the live one.
  await runMcpQuery(request, baseURL!);

  // Sanity-check: the container actually got the token.
  const envOut = execSync(
    `docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' ${containerName}`,
  ).toString();
  expect(envOut).toContain(`INDEXER_TOKEN=${INDEXER_TOKEN}`);

  // Sanity-check: OSS wrote audit rows to its SQLite (proves the engine
  // pipeline ran end-to-end).
  const containerCount = Number(
    execSync(
      `docker exec ${containerName} sqlite3 /data/audit.db 'SELECT COUNT(*) FROM audit_events'`,
    )
      .toString()
      .trim(),
  );
  expect(containerCount).toBeGreaterThanOrEqual(3);

  // Sanity-check: OSS exposes the new endpoint and accepts our bearer.
  const mappedPort = parseDockerPort(
    execSync(`docker port ${containerName} 8080`).toString(),
  );
  const since = await fetch(
    `http://127.0.0.1:${mappedPort}/audit/since/0?limit=500`,
    { headers: { authorization: `Bearer ${INDEXER_TOKEN}` } },
  );
  expect(
    since.status,
    "OSS image must expose /audit/since (upstream PR not yet shipped?)",
  ).toBe(200);

  // Step 2: poll audit_events_index for up to 15s. Default tick cadence
  // is 5s, so 15s is one cold-start tick + buffer.
  const db = getDb("eu");
  const indexed = await waitFor(async () => {
    const rows = await db
      .select()
      .from(auditEventsIndex)
      .where(
        and(
          eq(auditEventsIndex.customerId, customerId),
          gte(auditEventsIndex.ts, new Date(Date.now() - 60_000)),
        ),
      );
    return rows.length >= 3 ? rows : null;
  }, 15_000);
  expect(indexed.length).toBeGreaterThanOrEqual(3);
  const types = new Set(indexed.map((r) => r.eventType));
  expect(types.has("ATTEMPTED")).toBe(true);
  expect(types.has("EXECUTED")).toBe(true);

  // Step 3: cursor row updated (PR2 of mcp_url_auth_security: cursors
  // key on connection_id, not the plaintext token).
  const cursorRows = await db
    .select()
    .from(indexerCursors)
    .where(eq(indexerCursors.connectionId, connectionId));
  expect(cursorRows[0]?.lastId).toBeTruthy();
  // Each indexed row also carries mcp_token_id propagated from the OSS
  // engine (X-Midplane-Token-Id session-freeze). Assert every row in
  // this batch points back at the token we minted in beforeAll.
  for (const r of indexed) {
    expect(r.mcpTokenId).toBe(tokenId);
  }

  // Step 4: prove DELETE /audit/before honors the bearer and prunes rows.
  // We hit the container directly rather than spinning up a second
  // Indexer with retentionGraceMs=0 (which would race the dev server's
  // singleton). The unit suite covers the indexer's grace-window logic;
  // here we just exercise the OSS endpoint contract.
  const lastId = (await fetch(
    `http://127.0.0.1:${mappedPort}/audit/since/0?limit=500`,
    { headers: { authorization: `Bearer ${INDEXER_TOKEN}` } },
  ).then((r) => r.json())) as { rows: Array<{ id: string }> };
  const cutoffId = lastId.rows[lastId.rows.length - 1]!.id;
  const delRes = await fetch(
    `http://127.0.0.1:${mappedPort}/audit/before/${encodeURIComponent(cutoffId)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${INDEXER_TOKEN}` },
    },
  );
  expect(delRes.status).toBe(200);
  const remaining = Number(
    execSync(
      `docker exec ${containerName} sqlite3 /data/audit.db 'SELECT COUNT(*) FROM audit_events'`,
    )
      .toString()
      .trim(),
  );
  expect(remaining).toBe(0);
});

async function waitFor<T>(
  probe: () => Promise<T | null>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastResult: T | null = null;
  while (Date.now() < deadline) {
    lastResult = await probe();
    if (lastResult !== null) return lastResult;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms (last result: ${JSON.stringify(lastResult)})`,
  );
}

async function runMcpQuery(
  request: import("@playwright/test").APIRequestContext,
  baseURL: string,
): Promise<void> {
  const initRes = await request.post(`${baseURL}/mcp/${mcpToken}`, {
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "midplane-e2e-idx", version: "0.0.0" },
      },
    },
  });
  expect(initRes.status(), await initRes.text()).toBe(200);
  const sessionId = initRes.headers()["mcp-session-id"]!;
  await request.post(`${baseURL}/mcp/${mcpToken}`, {
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    data: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  const callRes = await request.post(`${baseURL}/mcp/${mcpToken}`, {
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    data: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "query",
        // `intent` is a required field on the query tool (engine 0.4.0+).
        arguments: { sql: "SELECT n FROM t", intent: "e2e indexer drain" },
      },
    },
  });
  expect(callRes.status(), await callRes.text()).toBe(200);
}

function parseDockerPort(stdout: string): number {
  const lines = stdout.trim().split(/\r?\n/);
  for (const line of lines) {
    const m = /(?:\d+\.\d+\.\d+\.\d+|::):(\d+)$/.exec(line.trim());
    if (m?.[1]) return Number(m[1]);
  }
  throw new Error(`could not parse port: ${stdout}`);
}

async function waitForPgDb(deadlineMs = 30_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      execSync(
        `docker exec ${PG_NAME} psql -U postgres -d ${PG_DB} -c 'SELECT 1' -t`,
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`sidecar Postgres not ready within ${deadlineMs}ms`);
}
