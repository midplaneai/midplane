// Live end-to-end for the self-host process-spawn backend (P7 Stage 2).
//
// What this proves — the two NEW risks Stage 2 introduces:
//   1. ProcessSpawner spawns the REAL compiled engine binary (`bun build
//      --compile`) as a subprocess on a loopback port, binds the per-connection
//      DSN, and the MCP query path runs against it (audit rows land in the
//      engine's SQLite).
//   2. rls-self-host-bind: the indexer drains those rows into
//      audit_events_index bound to the implicit-org customer id, so an
//      RLS-scoped read (SET LOCAL app.customer_id) returns REAL rows. If the
//      implicit-org UUID weren't bound per transaction, the read would silently
//      return ZERO — the failure mode this test guards.
//
// Gated on:
//   - E2E_LIVE=1
//   - Docker (a throwaway Postgres for the customer target DB)
//   - DATABASE_URL_EU (the control-plane index DB, same as the other live
//     suites — the RLS bind logic is identical regardless of which physical DB
//     backs it; we just key on the well-known self-host customer id).
//
// The binary is compiled fresh in beforeAll (so this never silently tests a
// stale artifact). The /mcp proxy HTTP layer is already covered by
// mcp-proxy.live.e2e.ts; here we drive the engine directly and focus on the
// spawn mechanism + the implicit-org RLS bind.

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import { and, eq, sql } from "drizzle-orm";
import { ulid } from "ulid";

import {
  auditEventsIndex,
  connections,
  customers,
  getDb,
  indexerCursors,
} from "@midplane-cloud/db";
import {
  ContainerRegistry,
  Indexer,
  ProcessSpawner,
} from "@midplane-cloud/router";

// Mirror apps/web/src/lib/self-host.ts. Inlined because Playwright's TS loader
// resolves a relative apps/web import as CJS and breaks named ESM imports (see
// audit-isolation.e2e.ts for the same workaround). These ARE the implicit-org
// identity the self-host control plane binds on every audit transaction.
const SELF_HOST_CUSTOMER_ID = "00000000000000000000000000";
const SELF_HOST_ORG_ID = "self-host-org";
const REGION = "eu" as const;

test.skip(
  process.env.E2E_LIVE !== "1",
  "set E2E_LIVE=1 to run the self-host process-spawn E2E (requires Docker + a control-plane Postgres)",
);

const PG_NAME = `midplane-e2e-selfhost-pg-${Date.now()}`;
const PG_PASSWORD = "postgres";
const PG_DB = "midplane_e2e_selfhost";
const INDEXER_TOKEN = `selfhost-idx-${randomUUID()}`;

let pgPort = 0;
let binaryPath = "";
let connectionId = "";
let connectionDatabaseId = "";
let registry: ContainerRegistry | null = null;

test.beforeAll(async () => {
  // 1. Compile the engine binary the self-host backend exec's — fresh, so we
  //    never test a stale artifact. On this host the libpg-query WASM resolves
  //    from the repo's node_modules at the baked __dirname (see
  //    scripts/build-engine-binary.sh).
  const outDir = mkdtempSync(join(tmpdir(), "midplane-e2e-bin-"));
  binaryPath = join(outDir, "midplane");
  execSync(
    `bun build --compile ./engine/packages/mcp-server/src/cli.ts --outfile ${binaryPath}`,
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  // 2. Throwaway Postgres = the customer's target DB the engine queries.
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
    `docker exec ${PG_NAME} psql -U postgres -d ${PG_DB} -c "CREATE TABLE t (n int); INSERT INTO t VALUES (7);"`,
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  // 3. Seed the implicit customer + a connection owned by it — exactly the
  //    shape the self-host control plane has (connections.customer_id ==
  //    SELF_HOST_CUSTOMER_ID). The indexer resolves customer_id off this row
  //    and binds it; the FKs (connections→customers, audit→connections) need
  //    both rows present.
  connectionId = ulid();
  connectionDatabaseId = ulid();
  const db = getDb(REGION);
  await db
    .insert(customers)
    .values({
      id: SELF_HOST_CUSTOMER_ID,
      orgId: SELF_HOST_ORG_ID,
      email: "self-host@local.test",
      region: REGION,
    })
    .onConflictDoNothing({ target: customers.id });
  await db.insert(connections).values({
    id: connectionId,
    customerId: SELF_HOST_CUSTOMER_ID,
    region: REGION,
  });
});

test.afterAll(async () => {
  if (registry) await registry.shutdown().catch(() => undefined);
  try {
    execSync(`docker rm -f ${PG_NAME}`, { stdio: "ignore" });
  } catch {}
  const db = getDb(REGION);
  if (connectionId) {
    // Scope cleanup to THIS connection's rows so we never touch other
    // self-host data sharing the implicit customer id. Leave the implicit
    // customer row in place (it's the well-known shared id; harmless).
    await db
      .delete(auditEventsIndex)
      .where(eq(auditEventsIndex.connectionId, connectionId));
    await db
      .delete(indexerCursors)
      .where(eq(indexerCursors.connectionId, connectionId));
    await db.delete(connections).where(eq(connections.id, connectionId));
  }
});

test("self-host process-spawn → indexer drains audit bound to the implicit org (real rows, not zero)", async () => {
  // Spawn the real binary via the real ProcessSpawner (real spawn, fetch,
  // port allocation) — the self-host backend, end to end.
  const spawner = new ProcessSpawner({ binaryPath, indexerToken: INDEXER_TOKEN });
  registry = new ContainerRegistry(spawner);

  const customerDsn = `postgres://postgres:${PG_PASSWORD}@127.0.0.1:${pgPort}/${PG_DB}?sslmode=disable`;
  const container = await registry.acquire({
    connectionId,
    region: REGION,
    databases: [
      {
        name: "main",
        connectionDatabaseId,
        dsn: customerDsn,
        tableAccess: { default: "read", tables: {} },
        tenantScope: { column: null, overrides: {}, exempt: [] },
        guardrails: { block_unqualified_dml: true, block_ddl: true },
      },
    ],
  });

  // Loopback only — the self-host engine is never reachable off-box.
  expect(container.host).toBe("127.0.0.1");
  const engineBase = `http://${container.host}:${container.port}`;

  // The engine became healthy (acquire gates on /health). Confirm its audit
  // endpoint honors the auto-provisioned-style indexer bearer.
  const since = await fetch(`${engineBase}/audit/since/0?limit=500`, {
    headers: { authorization: `Bearer ${INDEXER_TOKEN}` },
  });
  expect(since.status, "engine must expose /audit/since to the indexer").toBe(
    200,
  );

  // Drive a real query through the engine's MCP endpoint → writes audit rows.
  await runEngineQuery(engineBase);

  // Now the indexer: it resolves customer_id from the connections row
  // (== SELF_HOST_CUSTOMER_ID) and writes audit_events_index inside a txn that
  // SET LOCAL app.customer_id = that id. Run ticks until rows land.
  const db = getDb(REGION);
  const indexer = new Indexer({ db, registry, indexerToken: INDEXER_TOKEN });

  const rows = await waitFor(async () => {
    await indexer.tick();
    // Read with the SAME two-layer pattern audit.ts uses: SET LOCAL engages
    // RLS; the WHERE filter is the always-on app defense. If the indexer had
    // NOT bound the implicit org, these rows would carry a different
    // customer_id and this returns [] — the silent zero-rows failure.
    const found = await db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(`SET LOCAL app.customer_id = '${SELF_HOST_CUSTOMER_ID}'`),
      );
      return tx
        .select()
        .from(auditEventsIndex)
        .where(
          and(
            eq(auditEventsIndex.customerId, SELF_HOST_CUSTOMER_ID),
            eq(auditEventsIndex.connectionId, connectionId),
          ),
        );
    });
    return found.length >= 1 ? found : null;
  }, 20_000);

  // Real rows came back through the implicit-org-bound read.
  expect(rows.length).toBeGreaterThanOrEqual(1);
  // Every row is stamped with the implicit-org id (proves the indexer bound
  // SELF_HOST_CUSTOMER_ID, not some other / empty value).
  for (const r of rows) expect(r.customerId).toBe(SELF_HOST_CUSTOMER_ID);
  // The query actually executed against the customer DB.
  expect(rows.some((r) => r.eventType === "EXECUTED")).toBe(true);
});

// Minimal MCP Streamable-HTTP handshake against the engine directly (no proxy,
// no token — the engine trusts its caller; the proxy is the auth boundary).
async function runEngineQuery(base: string): Promise<void> {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const initRes = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "midplane-e2e-selfhost", version: "0.0.0" },
      },
    }),
  });
  expect(initRes.status, await initRes.text()).toBe(200);
  const sessionId = initRes.headers.get("mcp-session-id")!;
  expect(sessionId, "engine must return an mcp-session-id").toBeTruthy();

  await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": sessionId },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });

  const callRes = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": sessionId },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "query",
        // `intent` is a required field on the query tool (engine 0.4.0+).
        arguments: { sql: "SELECT n FROM t", intent: "e2e self-host spawn" },
      },
    }),
  });
  expect(callRes.status, await callRes.text()).toBe(200);
}

async function waitFor<T>(
  probe: () => Promise<T | null>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last !== null) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
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
