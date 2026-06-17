// Critical-path live E2E #1: brand-new sign-up → paste DSN → MCP endpoint →
// first MCP query → audit row visible to the customer within 15s.
//
// This is the only suite that exercises the signup → first MCP request
// boundary end to end. mcp-proxy.live.e2e.ts proves the proxy + container
// pipeline composes; this proves the conversion path the dashboard
// actually presents. If this is green, a real user pasting a DSN gets a
// working, audited MCP endpoint.
//
// Gated on:
//   - E2E_LIVE=1
//   - Docker (sidecar Postgres + OSS container spawn)
//   - midplane/midplane image present (`bun run dev:image`)
//   - .env.local DATABASE_URL pointing at a Neon dev branch
//   - .env.local BETTER_AUTH_SECRET + MIDPLANE_REGION_COOKIE_SECRET
//
// Cleanup: afterAll deletes the test user + org + customer rows; the sidecar
// pg + spawned container are torn down too.

import { execSync } from "node:child_process";

import { expect, test } from "@playwright/test";
import { and, eq, gte } from "drizzle-orm";

import {
  auditEventsIndex,
  connections,
  customers,
  getDb,
  indexerCursors,
} from "@midplane-cloud/db";

import { activeOrgId, cleanup, freshTestEmail, signUp } from "./_auth-helpers";

test.skip(
  process.env.E2E_LIVE !== "1",
  "set E2E_LIVE=1 to run live signup E2E (requires Docker + Neon + Clerk dev keys)",
);

const PG_NAME = `midplane-e2e-pg-signup-${Date.now()}`;
const PG_PASSWORD = "postgres";
const PG_DB = "midplane_e2e_signup";

let pgPort = 0;
let testEmail = "";
let userId = "";
let orgId = "";
let mcpToken = "";
let connectionId = "";
let proxiedContainerName = "";

test.beforeAll(async () => {
  // Sidecar Postgres reachable from the spawned OSS container via
  // host.docker.internal. Mirrors mcp-proxy.live.e2e.ts setup.
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
});

test.afterAll(async () => {
  // Kill containers first; DB cleanup happens regardless of whether the
  // Clerk user existed yet (test could fail before signUp).
  try {
    execSync(`docker rm -f ${PG_NAME}`, { stdio: "ignore" });
  } catch {}
  if (proxiedContainerName) {
    try {
      execSync(`docker rm -f ${proxiedContainerName}`, { stdio: "ignore" });
    } catch {}
  }

  // Customer was created by the Server Action, addressable by the org id.
  // Delete dependent rows first to satisfy FKs.
  if (orgId) {
    const db = getDb("eu");
    const customerRows = await db
      .select()
      .from(customers)
      .where(eq(customers.orgId, orgId));
    const customerId = customerRows[0]?.id;
    if (customerId) {
      const conns = await db
        .select()
        .from(connections)
        .where(eq(connections.customerId, customerId));
      for (const c of conns) {
        await db
          .delete(indexerCursors)
          .where(eq(indexerCursors.connectionId, c.id));
      }
      await db
        .delete(connections)
        .where(eq(connections.customerId, customerId));
      await db
        .delete(auditEventsIndex)
        .where(eq(auditEventsIndex.customerId, customerId));
      await db.delete(customers).where(eq(customers.id, customerId));
    }
  }
  await cleanup({ userId, orgId });
});

test("signup → paste DSN → MCP query → audit row visible within 15s", async ({
  page,
  request,
  baseURL,
}) => {
  // 1. Real user + browser session via the Better Auth sign-up API. The
  // onUserCreated callback records the id the instant it's known, so
  // afterAll() can still delete the user if any later step (the region form,
  // the connection form, the MCP request) throws.
  testEmail = freshTestEmail();
  const result = await signUp(page, testEmail, (id) => {
    userId = id;
  });
  expect(result.userId).toBe(userId);

  // 2. Onboard — the region picker Server Action creates the org + customer
  // (Better Auth doesn't auto-create one). The workspace name is prefilled.
  await page.goto("/signup/region");
  await expect(
    page.getByRole("heading", { name: /set up your workspace/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: /continue/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 15_000 });
  orgId = await activeOrgId(page);

  // 3. Connect Postgres — real Server Action runs encryptDsn + inserts
  // connection row. host.docker.internal lets the spawned OSS container
  // reach the sidecar Postgres bound to a random host port.
  await page.goto("/connections/new");
  await expect(
    page.getByRole("heading", { name: /connect postgres/i }),
  ).toBeVisible();
  const customerDsn = `postgres://postgres:${PG_PASSWORD}@host.docker.internal:${pgPort}/${PG_DB}`;
  await page.getByLabel(/database_url/i).fill(customerDsn);
  await page.getByRole("button", { name: /create connection/i }).click();
  // PR2 of mcp_url_auth_security: the create flow redirects to a
  // per-connection success page at /connections/<id>/created where the
  // plaintext URL is shown exactly once.
  await page.waitForURL(/\/connections\/[A-Z0-9]+\/created/i, {
    timeout: 15_000,
  });
  const urlPath = new URL(page.url()).pathname;
  const connIdMatch = /\/connections\/([0-9A-HJKMNP-TV-Z]{26})\/created/i.exec(
    urlPath,
  );
  if (!connIdMatch?.[1]) {
    throw new Error(`could not parse connection id from ${urlPath}`);
  }
  connectionId = connIdMatch[1];

  // 4. MCP URL is rendered on the success page; reading it from the DOM
  // proves the dashboard surfaces what an actual user would copy into
  // Cursor. PR2 of mcp_url_auth_security: the token format is now
  // `mp_(live|test)_<32 hex>_<6 base32>` (47 chars) — the regex below
  // matches both env families.
  const mcpUrl = await page.locator("input[readonly]").first().inputValue();
  expect(mcpUrl).toMatch(
    /^https?:\/\/.+\/mcp\/mp_(live|test)_[0-9a-f]{32}_[0-9A-HJKMNP-Z]{6}$/,
  );
  const tokenMatch = /\/mcp\/(mp_(?:live|test)_[0-9a-f]{32}_[0-9A-HJKMNP-Z]{6})$/.exec(
    mcpUrl,
  );
  if (!tokenMatch?.[1]) throw new Error(`could not parse mcp token from ${mcpUrl}`);
  mcpToken = tokenMatch[1];
  // Container naming switched to connection-id keying (PR2). The slice
  // matches the spawner's `midplane-${connectionId.slice(0, 16).toLowerCase()}`.
  proxiedContainerName = `midplane-${connectionId.slice(0, 16).toLowerCase()}`;

  // 5. Hit the MCP URL exactly the way Cursor would: initialize, ack,
  // tools/call. baseURL is rewritten in case the rendered MIDPLANE_PUBLIC_HOST
  // differs from the dev server. We hit the local /mcp route directly.
  await runMcpQuery(request, baseURL!, mcpToken);

  // 6. Server Action created the cloud customer row, addressable by the org
  // id. Snapshot it for afterAll cleanup + indexer assertion.
  const db = getDb("eu");
  const customerRows = await db
    .select()
    .from(customers)
    .where(eq(customers.orgId, orgId));
  const customerId = customerRows[0]?.id;
  expect(customerId, "Server Action should have created customer row").toBeTruthy();

  // 7. Audit row reaches the customer's storage within 15s. Two paths:
  //   a) container SQLite — proves the OSS engine pipeline ran (always
  //      true on a successful tools/call; no indexer dep).
  //   b) audit_events_index — proves the indexer drained it to the cloud
  //      DB, which is what the dashboard would actually query. Only run
  //      when INDEXER_TOKEN is set (the dev-server indexer is gated on
  //      it; see apps/web/src/lib/mcp-proxy.ts).
  // Critical-path #1 cares about (a) — the user gets an audited query.
  // (b) is the dashboard hook and gets its full coverage in
  // indexer.live.e2e.ts.
  const auditCount = execSync(
    `docker exec ${proxiedContainerName} sqlite3 /data/audit.db 'SELECT COUNT(*) FROM audit_events'`,
  )
    .toString()
    .trim();
  expect(Number(auditCount)).toBeGreaterThanOrEqual(3);

  if (process.env.INDEXER_TOKEN) {
    const indexed = await waitFor(async () => {
      const rows = await db
        .select()
        .from(auditEventsIndex)
        .where(
          and(
            eq(auditEventsIndex.customerId, customerId!),
            gte(auditEventsIndex.ts, new Date(Date.now() - 60_000)),
          ),
        );
      return rows.length >= 1 ? rows : null;
    }, 15_000);
    expect(indexed.length).toBeGreaterThanOrEqual(1);
    for (const r of indexed) {
      expect(r.customerId).toBe(customerId);
    }
  }
});

async function runMcpQuery(
  request: import("@playwright/test").APIRequestContext,
  baseURL: string,
  token: string,
): Promise<void> {
  const initRes = await request.post(`${baseURL}/mcp/${token}`, {
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
        clientInfo: { name: "midplane-e2e-signup", version: "0.0.0" },
      },
    },
  });
  expect(initRes.status(), await initRes.text()).toBe(200);
  const sessionId = initRes.headers()["mcp-session-id"];
  expect(sessionId, "OSS transport must mint mcp-session-id").toBeTruthy();

  const ackRes = await request.post(`${baseURL}/mcp/${token}`, {
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId!,
    },
    data: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  expect(ackRes.status()).toBeLessThan(300);

  const callRes = await request.post(`${baseURL}/mcp/${token}`, {
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId!,
    },
    data: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "query", arguments: { sql: "SELECT n FROM t" } },
    },
  });
  expect(callRes.status(), await callRes.text()).toBe(200);

  // JSON-RPC errors travel as HTTP 200 with an `error` field, so a status
  // check alone can't distinguish a real query result from a parser /
  // policy / exec failure that still produced an audit row. Parse the
  // body and assert (a) no top-level `error`, (b) the SELECT actually
  // returned the row we inserted in beforeAll. If this ever flakes,
  // critical-path #1 is silently broken.
  const body = await readJsonRpc(callRes);
  expect(
    body.error,
    `tools/call returned JSON-RPC error: ${JSON.stringify(body.error)}`,
  ).toBeUndefined();
  expect(JSON.stringify(body.result)).toContain("1");
}

async function readJsonRpc(
  res: import("@playwright/test").APIResponse,
): Promise<{ result?: unknown; error?: unknown }> {
  const ct = res.headers()["content-type"] ?? "";
  if (ct.includes("text/event-stream")) {
    const text = await res.text();
    const lines = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    const last = lines[lines.length - 1] ?? "";
    return JSON.parse(last.slice(5).trim());
  }
  return res.json();
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
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms (last result: ${JSON.stringify(last)})`,
  );
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
  throw new Error(`sidecar Postgres database not ready within ${deadlineMs}ms`);
}

// testEmail is captured at top level so failures inside the test still leave
// it visible to debug logs; afterAll doesn't need the value (cleanup keys off
// userId / orgId). Acknowledge the read so strict TS configs don't flag it.
void testEmail;
