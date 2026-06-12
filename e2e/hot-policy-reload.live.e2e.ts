// Live end-to-end: open MCP session → query a `read` table → flip the
// table to `deny` via setTableAccess → re-query in the SAME session →
// expect the deny decision WITHOUT a session reset.
//
// The whole point of /admin/policy: policy edits don't drop the agent's
// MCP session. This test fails if cloud falls back to invalidate (which
// kills + respawns the container, which mints a new mcp-session-id).
//
// Gated on E2E_LIVE=1, like the other live e2es. Requires:
//   - docker on PATH
//   - midplane/midplane:0.9.0 image (or local build via `bun run dev:image`)
//   - .env.local DATABASE_URL pointing at a Neon dev branch
//   - .env.local INDEXER_TOKEN set (the engine 404s without it)
//   - .env.local MIDPLANE_KMS_DEV_KEY_EU set

import { execSync } from "node:child_process";

import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";

import { connections, customers, getDb } from "@midplane-cloud/db";

import { containerNameFor, seedConnection } from "./_seed-helpers";

test.skip(
  process.env.E2E_LIVE !== "1",
  "set E2E_LIVE=1 to run live hot-policy-reload E2E (requires Docker + Neon)",
);

const PG_NAME = `midplane-policy-pg-${Date.now()}`;
const PG_PASSWORD = "postgres";
const PG_DB = "midplane_policy_e2e";

let pgPort = 0;
let mcpToken = "";
let customerId = "";
let connectionId = "";
let proxiedContainerName = "";

test.beforeAll(async () => {
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
    `docker exec ${PG_NAME} psql -U postgres -d ${PG_DB} -c "CREATE TABLE t (n int); INSERT INTO t VALUES (42);"`,
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const customerDsn = `postgres://postgres:${PG_PASSWORD}@host.docker.internal:${pgPort}/${PG_DB}`;
  // Seed permissive (default 'read') so the first query succeeds; the
  // test flips a specific table to 'deny' via setTableAccess.
  const seeded = await seedConnection({ region: "eu", dsn: customerDsn });
  customerId = seeded.customerId;
  connectionId = seeded.connectionId;
  mcpToken = seeded.tokenPlaintext;
  proxiedContainerName = containerNameFor(connectionId);
});

test.afterAll(async () => {
  try {
    execSync(`docker rm -f ${PG_NAME}`, { stdio: "ignore" });
  } catch {}
  if (proxiedContainerName) {
    try {
      execSync(`docker rm -f ${proxiedContainerName}`, { stdio: "ignore" });
    } catch {}
  }
  if (connectionId || customerId) {
    const db = getDb("eu");
    if (connectionId) {
      await db.delete(connections).where(eq(connections.id, connectionId));
    }
    if (customerId) {
      await db.delete(customers).where(eq(customers.id, customerId));
    }
  }
});

test("policy hot-reload preserves the agent's MCP session", async ({
  request,
  baseURL,
}) => {
  // 1. Handshake — spawns the OSS container.
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
        clientInfo: { name: "midplane-policy-e2e", version: "0.0.0" },
      },
    },
  });
  expect(initRes.status(), await initRes.text()).toBe(200);
  const sessionId = initRes.headers()["mcp-session-id"];
  expect(sessionId, "OSS transport must mint mcp-session-id").toBeTruthy();

  await request.post(`${baseURL}/mcp/${mcpToken}`, {
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId!,
    },
    data: { jsonrpc: "2.0", method: "notifications/initialized" },
  });

  // Snapshot container ID — must match after the policy hot-reload.
  const containerIdBefore = execSync(
    `docker inspect -f '{{.Id}}' ${proxiedContainerName}`,
  )
    .toString()
    .trim();
  expect(containerIdBefore.length).toBeGreaterThan(0);

  // 2. SELECT works under the initial `read` policy.
  const allowedRes = await request.post(`${baseURL}/mcp/${mcpToken}`, {
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
  expect(allowedRes.status(), await allowedRes.text()).toBe(200);
  const allowedBody = await readJsonRpc(allowedRes);
  expect(JSON.stringify(allowedBody)).toContain("42");

  // 3. Hot-reload the policy → deny `t`.
  const { setTableAccess } = await import(
    "../apps/web/src/lib/connections.ts"
  );
  const { getMcpProxyContext } = await import(
    "../apps/web/src/lib/mcp-proxy.ts"
  );
  const ctx = getMcpProxyContext();
  const customer = {
    id: customerId,
    clerkOrgId: `org_policy-e2e-${customerId}`,
    email: `policy-e2e-${customerId}@example.test`,
    region: "eu" as const,
    createdAt: new Date(),
  };
  const updated = await setTableAccess(
    customer,
    connectionId,
    { default: "read", tables: { t: "deny" } },
    ctx,
    `user_e2e-policy-${customerId}`,
  );
  expect(updated).not.toBeNull();

  // 4. Container must be the SAME process — no respawn happened.
  const containerIdAfter = execSync(
    `docker inspect -f '{{.Id}}' ${proxiedContainerName}`,
  )
    .toString()
    .trim();
  expect(
    containerIdAfter,
    "container ID changed — hot-reload fell back to respawn (session would drop)",
  ).toBe(containerIdBefore);

  // 5. Same session, same SQL — now denied. Engine still serves under
  //    the original mcp-session-id.
  const deniedRes = await request.post(`${baseURL}/mcp/${mcpToken}`, {
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId!,
    },
    data: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "query", arguments: { sql: "SELECT n FROM t" } },
    },
  });
  expect(deniedRes.status(), await deniedRes.text()).toBe(200);
  const deniedBody = await readJsonRpc(deniedRes);
  expect(
    JSON.stringify(deniedBody).toLowerCase(),
    "engine should report a deny under the new policy",
  ).toMatch(/deny|denied|policy/);
});

async function readJsonRpc(res: import("@playwright/test").APIResponse) {
  const ct = res.headers()["content-type"] ?? "";
  if (ct.includes("text/event-stream")) {
    const text = await res.text();
    const lines = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    const last = lines[lines.length - 1] ?? "";
    return JSON.parse(last.slice(5).trim());
  }
  return res.json();
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
