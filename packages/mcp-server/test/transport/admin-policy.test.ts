// POST /admin/policy — hot-swap the in-memory policy without engine restart.
//
// Boots the REAL production buildEngine (with a mock executor injected via
// BuildEngineOptions) so we exercise the full path: bearer check → readText
// → parsePolicyYaml → strict validation → swap holder → audit
// POLICY_RELOADED → 200. Bad inputs roll back: holder is mutated only after
// validation succeeds, so the engine stays on the previous policy in every
// failure mode below. Earlier versions duplicated setPolicy in this file,
// which let a real production-vs-test divergence slip past review — keep
// this on the production code path.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAuditWriter } from "@midplane/engine";
import { buildEngine, type EngineHandle } from "../../src/engine-factory.ts";
import { startHttp, type HttpHandle } from "../../src/transport/http.ts";
import { buildServer } from "../../src/server.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MockExecutor } from "../_helpers.ts";

// Build a production EngineHandle with a MockExecutor injected. The handle's
// setPolicy is the real production one (validation + audit included). When
// `initialPolicyYaml` is provided, it's written to a temp file and loaded
// the same way the engine loads MIDPLANE_POLICY_FILE at boot.
function buildTestHandle(opts: {
  dbPath: string;
  tmpDir: string;
  executor: MockExecutor;
  initialPolicyYaml?: string;
}): EngineHandle {
  let policyFile: string | undefined;
  if (opts.initialPolicyYaml) {
    policyFile = join(opts.tmpDir, "policy.yaml");
    writeFileSync(policyFile, opts.initialPolicyYaml);
  }
  return buildEngine(
    {
      databaseUrl: "postgres://stub",
      port: 0,
      dbPath: opts.dbPath,
      tenantId: "__self_host__",
      policyFile,
      transport: "http",
    },
    {
      executor: opts.executor,
      credentials: { resolve: async () => "postgres://stub" },
    },
  );
}

describe("POST /admin/policy", () => {
  const TOKEN = "test-admin-token-abc";
  let dir: string;
  let dbPath: string;
  let executor: MockExecutor;
  let handle: EngineHandle;
  let server: HttpHandle;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "midplane-admin-policy-"));
    dbPath = join(dir, "audit.db");
    executor = new MockExecutor();
    handle = buildTestHandle({
      dbPath,
      tmpDir: dir,
      executor,
      initialPolicyYaml:
        "table_access:\n" +
        "  default: deny\n" +
        "  tables:\n" +
        "    users: read\n",
    });
    server = await startHttp(() => buildServer({ handle }), {
      port: 0,
      host: "127.0.0.1",
      indexer: { audit: handle.registry.audit, token: TOKEN },
      admin: { setPolicy: handle.registry.setPolicy },
    });
  });

  afterAll(async () => {
    await server.close();
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function url(path: string): string {
    return `http://127.0.0.1:${server.port}${path}`;
  }

  // Run a query through the MCP transport so we exercise the SAME engine
  // the swap mutated. Returns { isError, data } parsed from the tool result.
  async function runQuery(sql: string): Promise<{ isError: boolean; data: any }> {
    const transport = new StreamableHTTPClientTransport(new URL(url("/mcp")));
    const client = new Client({ name: "admin-policy-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      executor.result = { rows: [{ id: 1 }], rowCount: 1 };
      const res = await client.callTool({ name: "query", arguments: { sql } });
      const content = res.content as Array<{ text: string }>;
      return { isError: !!res.isError, data: JSON.parse(content[0]!.text) };
    } finally {
      await client.close();
    }
  }

  test("missing bearer → 401", async () => {
    const res = await fetch(url("/admin/policy"), {
      method: "POST",
      headers: { "content-type": "application/yaml" },
      body: "table_access:\n  default: deny\n  tables: {}\n",
    });
    expect(res.status).toBe(401);
  });

  test("wrong bearer (same length) → 401", async () => {
    const wrong = "x".repeat(TOKEN.length);
    const res = await fetch(url("/admin/policy"), {
      method: "POST",
      headers: {
        "content-type": "application/yaml",
        authorization: `Bearer ${wrong}`,
      },
      body: "table_access:\n  default: deny\n  tables: {}\n",
    });
    expect(res.status).toBe(401);
  });

  test("valid bearer + valid YAML → 200, subsequent query reflects new policy", async () => {
    // Initial policy allows reads on `users`. Confirm.
    const before = await runQuery("SELECT id FROM users");
    expect(before.isError).toBe(false);

    // Swap to a policy that denies reads on users.
    const yaml =
      "table_access:\n" +
      "  default: deny\n" +
      "  tables:\n" +
      "    users: deny\n" +
      "    posts: read_write\n";

    const res = await fetch(url("/admin/policy"), {
      method: "POST",
      headers: {
        "content-type": "application/yaml",
        authorization: `Bearer ${TOKEN}`,
      },
      body: yaml,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; applied_at: string };
    expect(body.ok).toBe(true);
    expect(body.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // iso8601

    // Same query through the same engine: now denies.
    const after = await runQuery("SELECT id FROM users");
    expect(after.isError).toBe(true);
    expect(after.data.policy_rule).toBe("table_access");
  });

  test("malformed YAML → 400, original policy intact", async () => {
    // Establish a known baseline: users readable.
    const baselineYaml =
      "table_access:\n" +
      "  default: deny\n" +
      "  tables:\n" +
      "    users: read\n";
    const baseline = await fetch(url("/admin/policy"), {
      method: "POST",
      headers: {
        "content-type": "application/yaml",
        authorization: `Bearer ${TOKEN}`,
      },
      body: baselineYaml,
    });
    expect(baseline.status).toBe(200);

    const allowedBefore = await runQuery("SELECT id FROM users");
    expect(allowedBefore.isError).toBe(false);

    // Submit garbage YAML — unbalanced brackets js-yaml chokes on.
    const bad = "table_access:\n  default: deny\n  tables: { users: read";
    const res = await fetch(url("/admin/policy"), {
      method: "POST",
      headers: {
        "content-type": "application/yaml",
        authorization: `Bearer ${TOKEN}`,
      },
      body: bad,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("YAML parse error");

    // Original policy intact: SELECT users still allowed.
    const stillAllowed = await runQuery("SELECT id FROM users");
    expect(stillAllowed.isError).toBe(false);
  });

  test("schema-invalid YAML (default: maybe) → 400, original policy intact", async () => {
    const bad =
      "table_access:\n" +
      "  default: maybe\n" + // not a TableAccessLevel
      "  tables: {}\n";
    const res = await fetch(url("/admin/policy"), {
      method: "POST",
      headers: {
        "content-type": "application/yaml",
        authorization: `Bearer ${TOKEN}`,
      },
      body: bad,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("schema error");

    // Holder unchanged from the previous test's baseline (users: read).
    const stillAllowed = await runQuery("SELECT id FROM users");
    expect(stillAllowed.isError).toBe(false);
  });

  test("body missing table_access section → 400, original policy intact", async () => {
    // Empty body or tenant_scope-only body would silently clear the current
    // table_access policy in the v1 implementation. Strict validation
    // rejects both with 400.
    const res = await fetch(url("/admin/policy"), {
      method: "POST",
      headers: {
        "content-type": "application/yaml",
        authorization: `Bearer ${TOKEN}`,
      },
      body: "tenant_scope:\n  enabled: true\n  mappings: {}\n",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("missing the required `table_access`");

    // Holder unchanged: SELECT users still allowed (per the baseline above).
    const stillAllowed = await runQuery("SELECT id FROM users");
    expect(stillAllowed.isError).toBe(false);
  });

  test("audit log contains POLICY_RELOADED event with payload", async () => {
    // Read the audit DB directly — POLICY_RELOADED is the new event_type
    // we expect to find for every successful swap above.
    const rows = handle.registry.audit.readSince("0", 1000);
    const reloads = rows.filter((r) => r.event_type === "POLICY_RELOADED");
    expect(reloads.length).toBeGreaterThanOrEqual(1);
    const last = reloads[reloads.length - 1]!;
    const payload = last.payload as {
      source: string;
      table_access: { default: string; tables: Record<string, string> };
    };
    expect(payload.source).toBe("admin_endpoint");
    expect(payload.table_access.default).toBe("deny");
  });
});

describe("POST /admin/policy — INDEXER_TOKEN unset", () => {
  let dir: string;
  let dbPath: string;
  let handle: EngineHandle;
  let server: HttpHandle;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "midplane-admin-policy-noauth-"));
    dbPath = join(dir, "audit.db");
    handle = buildTestHandle({
      dbPath,
      tmpDir: dir,
      executor: new MockExecutor(),
    });
    // No `indexer` opt → token is undefined → bearer check returns "missing"
    // → 404.
    server = await startHttp(() => buildServer({ handle }), {
      port: 0,
      host: "127.0.0.1",
      admin: { setPolicy: handle.registry.setPolicy },
    });
  });

  afterAll(async () => {
    await server.close();
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("no token → 404 (route reveals nothing)", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/admin/policy`, {
      method: "POST",
      headers: { "content-type": "application/yaml" },
      body: "table_access: { default: read, tables: {} }",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/policy — tenant_scope.mappings hot-swap rejected", () => {
  // Engine booted with non-empty mappings. Any payload that changes them
  // (or omits them when they're set, which would normalize to empty) must
  // 400 — silently accepting would 200 a request the engine never applied.
  let dir: string;
  let dbPath: string;
  let executor: MockExecutor;
  let handle: EngineHandle;
  let server: HttpHandle;
  const TOKEN = "test-admin-token-mappings";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "midplane-admin-policy-mappings-"));
    dbPath = join(dir, "audit.db");
    executor = new MockExecutor();
    handle = buildTestHandle({
      dbPath,
      tmpDir: dir,
      executor,
      initialPolicyYaml:
        "tenant_scope:\n" +
        "  enabled: true\n" +
        "  mappings:\n" +
        "    users: org_id\n" +
        "table_access:\n" +
        "  default: deny\n" +
        "  tables:\n" +
        "    users: read\n",
    });
    server = await startHttp(() => buildServer({ handle }), {
      port: 0,
      host: "127.0.0.1",
      indexer: { audit: handle.registry.audit, token: TOKEN },
      admin: { setPolicy: handle.registry.setPolicy },
    });
  });

  afterAll(async () => {
    await server.close();
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function url(path: string): string {
    return `http://127.0.0.1:${server.port}${path}`;
  }

  test("payload that adds a mapping → 400, holder unchanged", async () => {
    const yaml =
      "tenant_scope:\n" +
      "  enabled: true\n" +
      "  mappings:\n" +
      "    users: org_id\n" +
      "    posts: tenant_id\n" + // new mapping
      "table_access:\n" +
      "  default: deny\n" +
      "  tables: {}\n";
    const res = await fetch(url("/admin/policy"), {
      method: "POST",
      headers: {
        "content-type": "application/yaml",
        authorization: `Bearer ${TOKEN}`,
      },
      body: yaml,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toContain("tenant_scope.mappings");

    // No POLICY_RELOADED event was written for this attempt.
    const reloads = handle.registry.audit
      .readSince("0", 1000)
      .filter((r) => r.event_type === "POLICY_RELOADED");
    expect(reloads.length).toBe(0);
  });

  test("payload that omits tenant_scope (would clear mappings) → 400", async () => {
    const yaml =
      "table_access:\n" +
      "  default: deny\n" +
      "  tables:\n" +
      "    users: read\n";
    // Note: no tenant_scope section. Without strict validation this would
    // 200 and leave mappings in force — but a future restart would drop
    // them, so the cloud's view of the engine state would be wrong.
    // Strict validation accepts this case (omitted section means "don't
    // touch"), so this should be 200, not 400. Confirms the hasTenantScope
    // distinction.
    const res = await fetch(url("/admin/policy"), {
      method: "POST",
      headers: {
        "content-type": "application/yaml",
        authorization: `Bearer ${TOKEN}`,
      },
      body: yaml,
    });
    expect(res.status).toBe(200);
  });

  test("payload that re-sends matching mappings → 200", async () => {
    const yaml =
      "tenant_scope:\n" +
      "  enabled: true\n" +
      "  mappings:\n" +
      "    users: org_id\n" + // identical to boot
      "table_access:\n" +
      "  default: deny\n" +
      "  tables:\n" +
      "    users: read_write\n";
    const res = await fetch(url("/admin/policy"), {
      method: "POST",
      headers: {
        "content-type": "application/yaml",
        authorization: `Bearer ${TOKEN}`,
      },
      body: yaml,
    });
    expect(res.status).toBe(200);
  });
});
