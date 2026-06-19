// Live end-to-end: project rotation actually swaps the DSN the OSS
// container is using. CRITICAL test from the eng-review plan — failing it
// means a customer rotates a leaked DSN but the in-memory cache + running
// container keep serving the OLD credentials for up to 30 minutes.
//
// Why this isn't a Playwright UI test: rotateProject invalidates two
// process-local singletons (DecryptCache, ContainerRegistry). The dev
// server's singletons live in its process; we can't reach them from a test
// process. The /api/projects/[id] PATCH route is a thin HTTP shell over
// rotateProject; this test exercises rotateProject directly against
// real DecryptCache, ContainerRegistry, and Docker-spawned OSS containers,
// proving the cache-coherence invariant the route relies on.
//
// PR2 of mcp_url_auth_security: rotation is no longer associated with the
// agent-facing token. ContainerRegistry keys on project_id; the
// token URL is unaffected by DSN rotation (this is the design — agents
// don't re-paste a URL because the DB password changed).
//
// Gate: E2E_LIVE=1. Requires:
//   - docker on PATH
//   - midplane/midplane image present (`bun run dev:image`)
//   - .env.local DATABASE_URL pointing at a Neon dev branch
//   - .env.local MIDPLANE_KMS_DEV_KEY_EU set
//   - .env.local MIDPLANE_TOKEN_PEPPER_EU_V1 set
//
// Test plan:
//   1. Spin up TWO sidecar Postgres instances (A, B) with distinguishable data
//   2. Seed customer + project + project_databases pointing at sidecar A
//      plus a real mcp_tokens row (via seedProject helper)
//   3. Resolve + spawn → query SELECT site FROM marker; assert "alpha"
//   4. Rotate to sidecar B's DSN via rotateProject
//   5. Resolve + spawn again → query; assert "bravo" (proves both layers
//      were invalidated — cache returned NEW plaintext, registry spawned a
//      NEW container with the NEW DSN env)

import { execSync } from "node:child_process";

import { expect, test } from "@playwright/test";
import { and, eq } from "drizzle-orm";

import {
  projectDatabases,
  projects,
  customers,
  getDb,
  indexerCursors,
  mcpTokens,
} from "@midplane-cloud/db";
import {
  makeKmsContext,
  type KmsContext,
} from "@midplane-cloud/kms";
import {
  ContainerRegistry,
  DecryptCache,
  DockerSpawner,
  DsnResolver,
} from "@midplane-cloud/router";

import { rotateProject } from "../apps/web/src/lib/projects";

import { containerNameFor, seedProject } from "./_seed-helpers";

test.skip(
  process.env.E2E_LIVE !== "1",
  "set E2E_LIVE=1 to run live rotation E2E (requires Docker + Neon)",
);

const PG_A = `midplane-rot-a-${Date.now()}`;
const PG_B = `midplane-rot-b-${Date.now()}`;
const PG_PASSWORD = "postgres";
const PG_DB = "midplane_e2e";

let pgPortA = 0;
let pgPortB = 0;
let dsnA = "";
let dsnB = "";
let customerId = "";
let projectId = "";
let projectDatabaseId = "";
let proxiedContainerName = "";

let kms: KmsContext;
let cache: DecryptCache;
let registry: ContainerRegistry;
let resolver: DsnResolver;

test.beforeAll(async () => {
  pgPortA = await startSidecar(PG_A, "alpha");
  pgPortB = await startSidecar(PG_B, "bravo");

  // OSS container reaches the host via host.docker.internal on macOS.
  dsnA = `postgres://postgres:${PG_PASSWORD}@host.docker.internal:${pgPortA}/${PG_DB}`;
  dsnB = `postgres://postgres:${PG_PASSWORD}@host.docker.internal:${pgPortB}/${PG_DB}`;

  // Seed customer + project + project_databases (DSN ciphertext on
  // child row, per migration 0008) + mcp_tokens (PR2 of
  // mcp_url_auth_security: token surface lives here, hashed at rest).
  const seeded = await seedProject({ region: "eu", dsn: dsnA });
  customerId = seeded.customerId;
  projectId = seeded.projectId;
  projectDatabaseId = seeded.projectDatabaseId;
  proxiedContainerName = containerNameFor(projectId);

  // Build the same router primitives the dev server uses. These are the
  // singletons rotateProject must invalidate.
  kms = makeKmsContext(process.env);
  const db = getDb("eu");
  cache = new DecryptCache();
  registry = new ContainerRegistry(new DockerSpawner());
  resolver = new DsnResolver({ db, cache, kms });
});

test.afterAll(async () => {
  // Container teardown — best-effort.
  try {
    await registry?.shutdown();
  } catch {}
  for (const name of [PG_A, PG_B, proxiedContainerName]) {
    if (!name) continue;
    try {
      execSync(`docker rm -f ${name}`, { stdio: "ignore" });
    } catch {}
  }
  if (projectId || customerId) {
    const db = getDb("eu");
    if (projectId) {
      // Cursor + token rows cascade via FK on the projects delete,
      // but explicitly delete the cursor first (FK ON DELETE SET NULL
      // would leave an orphan otherwise). mcp_tokens cascades.
      await db
        .delete(indexerCursors)
        .where(eq(indexerCursors.projectId, projectId));
      await db.delete(projects).where(eq(projects.id, projectId));
    }
    if (customerId) {
      await db.delete(customers).where(eq(customers.id, customerId));
    }
  }
});

test("rotation: cache + registry invalidated, next query hits the new sidecar", async () => {
  const db = getDb("eu");
  // Phase 1 — current DSN (sidecar A). Resolve + spawn + query.
  const cdb1 = await fetchProjectDatabase(projectDatabaseId);
  const decrypted1 = await resolver.resolve({
    projectDatabase: cdb1,
    region: "eu",
    customerId,
  });
  expect(decrypted1.ok).toBe(true);
  if (!decrypted1.ok) return;
  const c1 = await registry.acquire({
    projectId,
    region: "eu",
    databases: [
      {
        name: "main",
        projectDatabaseId,
        dsn: decrypted1.plaintext,
        tableAccess: { default: "read", tables: {} },
        tenantScope: { column: null, overrides: {}, exempt: [] },
      },
    ],
  });
  const site1 = await runSelectMarker(c1.host, c1.port);
  expect(site1, "first query must hit sidecar A").toBe("alpha");

  // Phase 2 — rotate to sidecar B. This invalidates BOTH caches in this
  // process; without that, the next acquire returns the same container
  // (still wired to dsnA) and the next decrypt returns the cached dsnA
  // plaintext, even though the row was updated.
  const customer = {
    id: customerId,
    orgId: `org_e2e-${customerId}`,
    email: `e2e-${customerId}@example.test`,
    region: "eu" as const,
    createdAt: new Date(),
  };
  const rotated = await rotateProject(customer, projectId, dsnB, {
    cache,
    registry,
  });
  expect(rotated, "rotation must succeed for owned row").not.toBeNull();
  // PR2 of mcp_url_auth_security: rotation no longer returns mcpToken.
  // The agent-facing token surface is independent of DSN rotation — the
  // assertion below confirms the contract.
  expect(rotated?.id).toBe(projectId);
  // Tokens are unaffected by rotation: the same plaintext continues to
  // resolve. Query mcp_tokens to confirm the row's hash hasn't been
  // rewritten by the rotation path.
  const tokenRows = await db
    .select()
    .from(mcpTokens)
    .where(
      and(eq(mcpTokens.projectId, projectId), eq(mcpTokens.name, "default")),
    );
  expect(tokenRows.length).toBe(1);
  expect(tokenRows[0]!.status).toBe("active");

  // Phase 3 — same project id, fresh resolve + acquire. Cache miss
  // forces KMS to decrypt the NEW ciphertext; registry miss forces a NEW
  // container spawn with dsnB in env.
  const cdb2 = await fetchProjectDatabase(projectDatabaseId);
  const decrypted2 = await resolver.resolve({
    projectDatabase: cdb2,
    region: "eu",
    customerId,
  });
  expect(decrypted2.ok).toBe(true);
  if (!decrypted2.ok) return;
  expect(decrypted2.source, "post-rotation must hit KMS, not cache").toBe(
    "miss",
  );
  expect(decrypted2.plaintext).toBe(dsnB);

  const c2 = await registry.acquire({
    projectId,
    region: "eu",
    databases: [
      {
        name: "main",
        projectDatabaseId,
        dsn: decrypted2.plaintext,
        tableAccess: { default: "read", tables: {} },
        tenantScope: { column: null, overrides: {}, exempt: [] },
      },
    ],
  });
  // The new container may bind a different host port — proves it's a fresh
  // spawn rather than the stale entry. (host:port can match by coincidence
  // on a busy host, so we verify by query result, not address.)
  const site2 = await runSelectMarker(c2.host, c2.port);
  expect(site2, "post-rotation query must hit sidecar B").toBe("bravo");
});

async function startSidecar(name: string, marker: string): Promise<number> {
  execSync(
    `docker run -d --rm --name ${name} -e POSTGRES_PASSWORD=${PG_PASSWORD} -e POSTGRES_DB=${PG_DB} -p 0:5432 postgres:16-alpine`,
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const portOut = execSync(`docker port ${name} 5432`).toString();
  const m = /:(\d+)$/m.exec(portOut.split(/\r?\n/)[0] ?? "");
  if (!m?.[1]) throw new Error(`could not parse pg port for ${name}: ${portOut}`);
  const port = Number(m[1]);
  await waitForPgDb(name);
  // marker table is the same on both sidecars but the row value differs —
  // the test asserts on the literal value, which uniquely identifies which
  // sidecar served the query.
  execSync(
    `docker exec ${name} psql -U postgres -d ${PG_DB} -c "CREATE TABLE marker (site text); INSERT INTO marker VALUES ('${marker}');"`,
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return port;
}

async function waitForPgDb(name: string, deadlineMs = 30_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      execSync(
        `docker exec ${name} psql -U postgres -d ${PG_DB} -c 'SELECT 1' -t`,
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`sidecar ${name} not ready within ${deadlineMs}ms`);
}

async function fetchProjectDatabase(id: string) {
  const db = getDb("eu");
  const rows = await db
    .select()
    .from(projectDatabases)
    .where(eq(projectDatabases.id, id));
  const row = rows[0];
  if (!row) throw new Error(`project_databases ${id} vanished`);
  return row;
}

// Drives the OSS engine's MCP query tool against the spawned container,
// returning the single string column from `SELECT site FROM marker`. Uses
// the Streamable HTTP handshake the agents use, so this exercises the
// same code path a Cursor session would.
async function runSelectMarker(host: string, port: number): Promise<string> {
  const url = `http://${host}:${port}/mcp`;
  const initRes = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "midplane-rot-e2e", version: "0.0.0" },
      },
    }),
  });
  if (!initRes.ok) throw new Error(`mcp initialize failed: ${initRes.status}`);
  const sessionId = initRes.headers.get("mcp-session-id") ?? "";
  await initRes.text();
  if (!sessionId) throw new Error("OSS transport must mint mcp-session-id");

  const ackRes = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });
  await ackRes.text();

  const callRes = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "query",
        // `intent` is a required field on the query tool (engine 0.4.0+).
        arguments: {
          sql: "SELECT site FROM marker",
          intent: "e2e rotate-project",
        },
      },
    }),
  });
  if (!callRes.ok) throw new Error(`mcp tools/call failed: ${callRes.status}`);
  const body = await readJsonRpc(callRes);
  // Look for a literal "alpha" or "bravo" anywhere in the response payload —
  // the OSS engine returns rows nested under content/result; our marker
  // values are unique strings so this scan is unambiguous.
  const text = JSON.stringify(body);
  if (text.includes("alpha")) return "alpha";
  if (text.includes("bravo")) return "bravo";
  throw new Error(`marker not found in response: ${text}`);
}

async function readJsonRpc(res: Response) {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    const text = await res.text();
    const lines = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    const last = lines[lines.length - 1] ?? "";
    return JSON.parse(last.slice(5).trim());
  }
  return res.json();
}
