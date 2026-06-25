// Live end-to-end: the FULL interactive OAuth agent flow through a spawned
// engine. discovery → Dynamic Client Registration → authorize → branded consent
// DB picker → token → an MCP query → assert the audit row carries the per-agent
// `mcp_token_id` (the OAuth attribution row). This is the only suite that proves
// the P6 OAuth handshake + the P6.1 consent scope picker compose into a working,
// audited, scoped endpoint — the pre-launch gap mcp-proxy.live.e2e.ts (HMAC
// path) and the unit suites don't cover.
//
// Gated on E2E_LIVE=1. Requires (same as mcp-proxy.live.e2e.ts):
//   - docker on PATH (sidecar Postgres + engine image spawn)
//   - the pinned engine image present locally (`bun run dev:image`) — must be
//     >= 0.11.0 so the engine honors X-Midplane-Scope (older images ignore it,
//     so the scope assertions would not hold).
//   - .env.local DATABASE_URL_EU → a Neon dev branch, MIDPLANE_REGION=eu,
//     BETTER_AUTH_SECRET, MIDPLANE_REGION_COOKIE_SECRET, the KMS/pepper dev keys
//   - the dev server's BETTER_AUTH_URL == the test baseURL (so issued tokens
//     validate against the same origin the MCP call hits).
//
// NOTE (validate at release): this drives real Better Auth OAuth endpoints
// (resolved from discovery, not hard-coded) + the actual consent picker UI. It
// can only run with the 0.11.0 engine image built; like every *.live.e2e.ts it
// does NOT run in the CI smoke suite. The spots most likely to need a tweak
// against a live stack are annotated (DCR field shape, token-endpoint content
// type, consent selectors).

import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";
import { and, eq } from "drizzle-orm";

import {
  projects,
  customers,
  getDb,
  indexerCursors,
  mcpTokens,
} from "@midplane-cloud/db";

import { cleanup, freshTestEmail, onboard, signUp } from "./_auth-helpers";

test.skip(
  process.env.E2E_LIVE !== "1",
  "set E2E_LIVE=1 to run live OAuth E2E (requires Docker + Neon + the 0.11.0 engine image)",
);

const PG_NAME = `midplane-e2e-pg-oauth-${Date.now()}`;
const PG_PASSWORD = "postgres";
const PG_DB = "midplane_e2e_oauth";
const REDIRECT_URI = "http://localhost:7777/callback"; // captured, never served

let pgPort = 0;
let userId = "";
let orgId = "";
let projectId = "";
let clientId = "";
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
        .from(projects)
        .where(eq(projects.customerId, customerId));
      for (const c of conns) {
        await db
          .delete(indexerCursors)
          .where(eq(indexerCursors.projectId, c.id));
      }
      // mcp_scope_grants + mcp_tokens cascade off projects / user; deleting
      // the project drops both. The customer row goes last.
      await db.delete(projects).where(eq(projects.customerId, customerId));
      await db.delete(customers).where(eq(customers.id, customerId));
    }
  }
  await cleanup({ userId, orgId });
});

test("OAuth: discovery → DCR → consent picker → token → query → audit has mcp_token_id", async ({
  page,
  request,
  baseURL,
}) => {
  // 1. Real signed-in user + org + customer.
  const email = freshTestEmail();
  await signUp(page, email, (id) => {
    userId = id;
  });
  orgId = (await onboard(page)).orgId;

  // 2. A project over the sidecar Postgres (the agent's target).
  await page.goto("/projects/new");
  const dsn = `postgres://postgres:${PG_PASSWORD}@host.docker.internal:${pgPort}/${PG_DB}`;
  await page.getByLabel(/database_url/i).fill(dsn);
  await page.getByRole("button", { name: /^connect$/i }).click();
  // OAuth-first: the create flow lands on the project's Connect tab.
  await page.waitForURL(/\/projects\/[0-9A-HJKMNP-TV-Z]{26}(\?|$)/i, {
    timeout: 15_000,
  });
  projectId = /\/projects\/([0-9A-HJKMNP-TV-Z]{26})/i.exec(
    new URL(page.url()).pathname,
  )![1]!;
  proxiedContainerName = `midplane-${projectId.slice(0, 16).toLowerCase()}`;

  // 3. OAuth discovery — resolve endpoints from metadata, never hard-code them.
  const disco = await (
    await request.get(`${baseURL}/.well-known/oauth-authorization-server`)
  ).json();
  const authorizationEndpoint = disco.authorization_endpoint as string;
  const tokenEndpoint = disco.token_endpoint as string;
  const registrationEndpoint = disco.registration_endpoint as string;
  expect(authorizationEndpoint, "discovery: authorization_endpoint").toBeTruthy();
  expect(tokenEndpoint, "discovery: token_endpoint").toBeTruthy();
  expect(registrationEndpoint, "discovery: registration_endpoint").toBeTruthy();

  // 4. Dynamic Client Registration — a public PKCE client.
  const dcr = await request.post(registrationEndpoint, {
    headers: { "content-type": "application/json" },
    data: {
      client_name: "midplane-oauth-e2e",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  });
  expect(dcr.status(), await dcr.text()).toBeLessThan(300);
  clientId = (await dcr.json()).client_id as string;
  expect(clientId, "DCR client_id").toBeTruthy();

  // 5. Authorize in the browser (the session cookie from signUp makes the user
  // authed; the auth before-hook forces prompt=consent + scope⊇mcp). PKCE S256.
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const authorizeUrl =
    `${authorizationEndpoint}?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent("mcp")}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&state=e2e-state`;
  await page.goto(authorizeUrl);

  // 6. The branded consent DB picker renders. Grant the (single) database Read,
  // then Allow — the form writes the grant rows, then posts the consent.
  await expect(
    page.getByRole("heading", { name: /connect midplane-oauth-e2e/i }),
  ).toBeVisible({ timeout: 15_000 });
  // First DB row's access control → Read. (Selectors track consent-form.tsx /
  // db-access-control.tsx; update here if those change.)
  await page.getByRole("radio", { name: "Read" }).first().click();
  // The redirect lands on the (unserved) client callback; capture the code.
  await Promise.all([
    page.waitForURL(`${REDIRECT_URI}**`, { timeout: 15_000 }),
    page.getByRole("button", { name: /allow access/i }).click(),
  ]);
  const code = new URL(page.url()).searchParams.get("code");
  expect(code, "authorization code on the callback").toBeTruthy();

  // 7. Exchange the code for an access token (public client + PKCE verifier).
  const tokenRes = await request.post(tokenEndpoint, {
    // Better Auth's token endpoint takes form-encoded params.
    form: {
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    },
  });
  expect(tokenRes.status(), await tokenRes.text()).toBe(200);
  const accessToken = (await tokenRes.json()).access_token as string;
  expect(accessToken, "access_token").toBeTruthy();

  // 8. Drive the MCP endpoint as the agent would — bearer at /mcp/<connId>.
  await runMcpQuery(request, baseURL!, projectId, accessToken);

  // 9. The engine stamped the per-agent mcp_token_id on the audit rows. That id
  // is the OAuth attribution row the proxy minted per (project, client).
  const sqliteIds = execSync(
    `docker exec ${proxiedContainerName} sqlite3 /data/audit.db "SELECT DISTINCT mcp_token_id FROM audit_events WHERE mcp_token_id IS NOT NULL"`,
  )
    .toString()
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  expect(sqliteIds.length, "audit rows carry a non-null mcp_token_id").toBeGreaterThanOrEqual(1);

  const db = getDb("eu");
  const attribution = await db
    .select({ id: mcpTokens.id })
    .from(mcpTokens)
    .where(
      and(
        eq(mcpTokens.projectId, projectId),
        eq(mcpTokens.clientId, clientId),
        eq(mcpTokens.kind, "oauth"),
      ),
    )
    .limit(1);
  expect(attribution[0]?.id, "an OAuth attribution mcp_tokens row exists").toBeTruthy();
  // The id the engine stamped == the cloud attribution row id (audit ties back
  // to the specific agent that ran the query).
  expect(sqliteIds).toContain(attribution[0]!.id);
});

async function runMcpQuery(
  request: APIRequestContext,
  baseURL: string,
  connId: string,
  bearer: string,
): Promise<void> {
  const url = `${baseURL}/mcp/${connId}`;
  const headers = (sessionId?: string) => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${bearer}`,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  });

  const initRes = await request.post(url, {
    headers: headers(),
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "midplane-oauth-e2e", version: "0.0.0" },
      },
    },
  });
  expect(initRes.status(), await initRes.text()).toBe(200);
  const sessionId = initRes.headers()["mcp-session-id"];
  expect(sessionId, "OSS transport must mint mcp-session-id").toBeTruthy();

  const ackRes = await request.post(url, {
    headers: headers(sessionId!),
    data: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  expect(ackRes.status()).toBeLessThan(300);

  // Read query — allowed by the Read grant chosen at consent.
  const callRes = await request.post(url, {
    headers: headers(sessionId!),
    data: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "query",
        arguments: { sql: "SELECT n FROM t", intent: "e2e oauth read smoke" },
      },
    },
  });
  expect(callRes.status(), await callRes.text()).toBe(200);
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

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
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
