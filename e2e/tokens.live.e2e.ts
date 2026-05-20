// Live end-to-end: token lifecycle gates on /mcp/<plaintext>.
//
// PR2 of mcp_url_auth_security (Codex review #7 + D9 hybrid model).
// This suite proves the runtime enforces the contract:
//   - Active token → /mcp/<plain> resolves (proxy spawns + forwards).
//   - Revoked token → /mcp/<plain> returns 404 immediately (status
//     filter in resolveByToken).
//   - Expired token after sweeper tick → status flips, /mcp/<plain>
//     returns 404 on the next request.
//
// Gated on E2E_LIVE=1, just like the other live e2es. Requires Docker
// (sidecar Postgres + OSS image spawn), Neon (cloud DB), and the
// MIDPLANE_TOKEN_PEPPER_<REGION>_V1 env var (the pepper used to hash
// token rows at rest).

import { execSync } from "node:child_process";

import { expect, test } from "@playwright/test";
import { and, eq, sql } from "drizzle-orm";

import {
  connections,
  customers,
  getDb,
  indexerCursors,
  mcpTokens,
} from "@midplane-cloud/db";
import { ExpirySweeper } from "@midplane-cloud/router";

import { containerNameFor, seedConnection } from "./_seed-helpers";

test.skip(
  process.env.E2E_LIVE !== "1",
  "set E2E_LIVE=1 to run live tokens E2E (requires Docker + Neon + pepper)",
);

const PG_NAME = `midplane-tokens-pg-${Date.now()}`;
const PG_PASSWORD = "postgres";
const PG_DB = "midplane_tokens_e2e";

let pgPort = 0;
let customerId = "";
let connectionId = "";
let mcpToken = "";
let tokenId = "";
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
    `docker exec ${PG_NAME} psql -U postgres -d ${PG_DB} -c "CREATE TABLE t (n int); INSERT INTO t VALUES (1);"`,
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const dsn = `postgres://postgres:${PG_PASSWORD}@host.docker.internal:${pgPort}/${PG_DB}`;
  const seeded = await seedConnection({ region: "eu", dsn });
  customerId = seeded.customerId;
  connectionId = seeded.connectionId;
  mcpToken = seeded.tokenPlaintext;
  tokenId = seeded.tokenId;
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
  const db = getDb("eu");
  if (connectionId) {
    await db
      .delete(indexerCursors)
      .where(eq(indexerCursors.connectionId, connectionId));
    await db.delete(connections).where(eq(connections.id, connectionId));
  }
  if (customerId) {
    await db.delete(customers).where(eq(customers.id, customerId));
  }
});

test("active token resolves; revoked token → 404", async ({ request, baseURL }) => {
  // First request — active token, should reach upstream (200 or any non-404).
  const ok = await request.post(`${baseURL}/mcp/${mcpToken}`, {
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
        clientInfo: { name: "midplane-tokens-e2e", version: "0.0.0" },
      },
    },
  });
  expect(ok.status(), await ok.text()).toBe(200);

  // Revoke the token directly (PR3 owns the API surface; here we exercise
  // the runtime gate, not the route).
  const db = getDb("eu");
  await db
    .update(mcpTokens)
    .set({
      status: "revoked",
      revokedAt: new Date(),
      revokedReason: "user_action",
    })
    .where(eq(mcpTokens.id, tokenId));

  // Next /mcp/<plain> request must 404 — resolveByToken filters status='active'.
  const denied = await request.post(`${baseURL}/mcp/${mcpToken}`, {
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    data: {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "midplane-tokens-e2e", version: "0.0.0" },
      },
    },
  });
  expect(denied.status()).toBe(404);
});

test("expiry sweeper flips past-due tokens to expired", async ({
  request,
  baseURL,
}) => {
  // Mint a fresh active token on the same connection with an expiry
  // already in the past. The runtime lookup's WHERE filter rejects this
  // immediately (NOW() vs expires_at), but status stays 'active' until
  // the sweeper runs — that's exactly what we exercise here.
  const db = getDb("eu");
  const { ulid } = await import("ulid");
  const { generateToken } = await import("@midplane-cloud/db/token-format");
  const { hashToken, loadPepperFromKms } = await import(
    "@midplane-cloud/kms/pepper"
  );

  const peppers = await loadPepperFromKms("eu", process.env);
  const kid = peppers.keys().next().value as string;
  const generated = generateToken("test");
  const expiredTokenId = ulid();
  await db.insert(mcpTokens).values({
    id: expiredTokenId,
    connectionId,
    name: "already-expired",
    prefix: generated.prefix,
    last4: generated.last4,
    tokenHash: hashToken(peppers.get(kid)!, generated.plaintext),
    pepperKid: kid,
    createdByUserId: "user_e2e_seed",
    expiresAt: new Date(Date.now() - 1_000),
  });

  // Runtime lookup gates expiry, so the request is rejected even before
  // the sweeper flips the row.
  const beforeSweep = await request.post(
    `${baseURL}/mcp/${generated.plaintext}`,
    {
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
          clientInfo: { name: "midplane-tokens-e2e", version: "0.0.0" },
        },
      },
    },
  );
  expect(beforeSweep.status()).toBe(404);

  // Now run the sweeper once. The row should flip to status='expired'.
  const sweeper = new ExpirySweeper({ db });
  const result = await sweeper.tick();
  expect(result.affected).toBeGreaterThanOrEqual(1);

  const rows = await db
    .select({ status: mcpTokens.status, revokedReason: mcpTokens.revokedReason })
    .from(mcpTokens)
    .where(eq(mcpTokens.id, expiredTokenId));
  expect(rows[0]?.status).toBe("expired");
  expect(rows[0]?.revokedReason).toBe("expired");

  // Sweeper is idempotent — second tick affects 0 rows since the
  // predicate filters status='active' AND past-due.
  const second = await sweeper.tick();
  expect(second.affected).toBe(0);

  // Belt-and-suspenders: also explicitly verify the WHERE predicate
  // matched no eligible rows by counting how many active+past-due
  // tokens exist right now.
  const remaining = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mcpTokens)
    .where(
      and(
        eq(mcpTokens.status, "active"),
        sql`${mcpTokens.expiresAt} IS NOT NULL AND ${mcpTokens.expiresAt} < NOW()`,
      ),
    );
  expect(Number(remaining[0]?.n ?? 0)).toBe(0);
});

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
