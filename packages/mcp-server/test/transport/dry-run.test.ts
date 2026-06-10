// POST /admin/dry-run — "would this SQL be allowed or denied?" for the cloud
// dashboard's policy test surface.
//
// Boots the REAL production buildEngine (with a MockExecutor injected) so the
// dry-run runs through the same registry → engine the `query` tool drives. The
// whole point of the endpoint is that its verdicts come from the SAME decision
// brain (`engine.decide()` = the first half of `engine.handle()`), so the
// "drift guard" describe below asserts handle() and decide() agree statement
// for statement, and the "never opens a socket" describe proves the dry-run
// path never reaches the executor.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineContext } from "@midplane/engine";
import { buildEngine, type EngineHandle } from "../../src/engine-factory.ts";
import { startHttp, type HttpHandle } from "../../src/transport/http.ts";
import { buildServer } from "../../src/server.ts";
import { DEFAULT_DB_NAME } from "../../src/config.ts";
import { MockExecutor } from "../_helpers.ts";

const TOKEN = "test-dry-run-token-xyz";

interface Setup {
  dir: string;
  handle: EngineHandle;
  server: HttpHandle;
  executor: MockExecutor;
}

// Boot a production EngineHandle (MockExecutor injected) loaded from the given
// policy YAML, fronted by the real HTTP transport with the dry-run + policy
// admin routes wired exactly as index.ts wires them.
async function setup(policyYaml: string): Promise<Setup> {
  const dir = mkdtempSync(join(tmpdir(), "midplane-dry-run-"));
  const dbPath = join(dir, "audit.db");
  const policyFile = join(dir, "policy.yaml");
  writeFileSync(policyFile, policyYaml);
  const executor = new MockExecutor();
  const handle = buildEngine(
    {
      databaseUrl: "postgres://stub",
      port: 0,
      dbPath,
      tenantId: "__self_host__",
      policyFile,
      transport: "http",
    },
    { executor, credentials: { resolve: async () => "postgres://stub" } },
  );
  const server = await startHttp(() => buildServer({ handle }), {
    port: 0,
    host: "127.0.0.1",
    indexer: { audit: handle.registry.audit, token: TOKEN },
    admin: {
      setPolicy: handle.registry.setPolicy,
      dryRun: handle.registry.dryRun,
    },
  });
  return { dir, handle, server, executor };
}

async function teardown(s: Setup): Promise<void> {
  await s.server.close();
  await s.handle.close();
  rmSync(s.dir, { recursive: true, force: true });
}

interface DryRunResult {
  status: number;
  body: any;
}

// POST a dry-run request with the valid bearer (unless `auth` overrides it).
async function post(
  s: Setup,
  body: unknown,
  auth: string | null = `Bearer ${TOKEN}`,
): Promise<DryRunResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== null) headers.authorization = auth;
  const res = await fetch(`http://127.0.0.1:${s.server.port}/admin/dry-run`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

// One probe in, one verdict out — the common case in these tests.
async function probe(
  s: Setup,
  p: { table: string; action: string; cross_tenant?: boolean },
  extra: Record<string, unknown> = {},
): Promise<any> {
  const res = await post(s, {
    database: DEFAULT_DB_NAME,
    probes: [p],
    ...extra,
  });
  expect(res.status).toBe(200);
  expect(res.body.verdicts).toHaveLength(1);
  return res.body.verdicts[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 + 5 + auth: table_access probe verdicts, batching/caps, error cases, auth.
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /admin/dry-run — table_access probes", () => {
  let s: Setup;

  beforeAll(async () => {
    s = await setup(
      "table_access:\n" +
        "  default: read\n" +
        "  tables:\n" +
        "    users: read\n" +
        "    secrets: deny\n" +
        "    posts: read_write\n",
    );
  });
  afterAll(() => teardown(s));

  test("select on a read table → allow (table rule)", async () => {
    const v = await probe(s, { table: "users", action: "select" });
    expect(v.decision).toBe("allow");
    expect(v.matched_rule).toBe("table:users→read");
    expect(v.action).toBe("SELECT");
    expect(v.tables).toEqual(["users"]);
    expect(v.probe).toEqual({ table: "users", action: "select" });
    expect(v.sql).toBeUndefined();
  });

  test("insert on a read table → deny (write blocked)", async () => {
    const v = await probe(s, { table: "users", action: "insert" });
    expect(v.decision).toBe("deny");
    expect(v.matched_rule).toBe("table:users→read");
    expect(v.action).toBe("INSERT");
    expect(v.reason).toContain("not permitted");
  });

  test("select on a deny table → deny (read blocked)", async () => {
    const v = await probe(s, { table: "secrets", action: "select" });
    expect(v.decision).toBe("deny");
    expect(v.matched_rule).toBe("table:secrets→deny");
  });

  test("insert/update/delete on a read_write table → allow", async () => {
    for (const action of ["insert", "update", "delete"]) {
      const v = await probe(s, { table: "posts", action });
      expect(v.decision).toBe("allow");
      expect(v.matched_rule).toBe("table:posts→read_write");
      expect(v.action).toBe(action.toUpperCase());
    }
  });

  test("unlisted table falls back to default:read", async () => {
    const allow = await probe(s, { table: "unlisted", action: "select" });
    expect(allow.decision).toBe("allow");
    expect(allow.matched_rule).toBe("default:read");

    const deny = await probe(s, { table: "unlisted", action: "insert" });
    expect(deny.decision).toBe("deny");
    expect(deny.matched_rule).toBe("default:read");
  });

  test("every response carries a 16-hex-char policy_hash", async () => {
    const res = await post(s, {
      database: DEFAULT_DB_NAME,
      probes: [{ table: "users", action: "select" }],
    });
    expect(res.body.policy_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("batching: N probes → N verdicts in input order, truncated:false", async () => {
    const probes = [
      { table: "users", action: "select" },
      { table: "secrets", action: "select" },
      { table: "posts", action: "insert" },
    ];
    const res = await post(s, { database: DEFAULT_DB_NAME, probes });
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);
    expect(res.body.total_tables).toBeUndefined();
    expect(res.body.verdicts.map((v: any) => v.probe.table)).toEqual([
      "users",
      "secrets",
      "posts",
    ]);
    expect(res.body.verdicts.map((v: any) => v.decision)).toEqual([
      "allow",
      "deny",
      "allow",
    ]);
  });

  test("50-table cap → truncated:true + total_tables, first 50 evaluated", async () => {
    const probes = Array.from({ length: 51 }, (_, i) => ({
      table: `t${i}`,
      action: "select",
    }));
    const res = await post(s, { database: DEFAULT_DB_NAME, probes });
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.total_tables).toBe(51);
    expect(res.body.verdicts).toHaveLength(50);
    expect(res.body.verdicts[0].probe.table).toBe("t0");
    expect(res.body.verdicts[49].probe.table).toBe("t49");
  });

  test("both probes and sql → 400", async () => {
    const res = await post(s, {
      database: DEFAULT_DB_NAME,
      probes: [{ table: "users", action: "select" }],
      sql: "SELECT 1",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("exactly one");
  });

  test("neither probes nor sql → 400", async () => {
    const res = await post(s, { database: DEFAULT_DB_NAME });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("exactly one");
  });

  test("unknown database alias → 400", async () => {
    const res = await post(s, {
      database: "nope",
      probes: [{ table: "users", action: "select" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unknown database "nope"');
  });

  test("malformed custom SQL → 400 with parseable JSON error body", async () => {
    const res = await post(s, {
      database: DEFAULT_DB_NAME,
      sql: "this is definitely not valid sql",
    });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/parse/i);
  });

  test("non-JSON body → 400", async () => {
    const res = await post(s, "}{ not json");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("valid JSON");
  });

  test("invalid table identifier → 400", async () => {
    const res = await post(s, {
      database: DEFAULT_DB_NAME,
      probes: [{ table: "users; DROP TABLE x", action: "select" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("identifier");
  });

  test("missing bearer → 401", async () => {
    const res = await post(
      s,
      { database: DEFAULT_DB_NAME, probes: [{ table: "users", action: "select" }] },
      null,
    );
    expect(res.status).toBe(401);
  });

  test("wrong bearer (same length) → 401", async () => {
    const res = await post(
      s,
      { database: DEFAULT_DB_NAME, probes: [{ table: "users", action: "select" }] },
      `Bearer ${"x".repeat(TOKEN.length)}`,
    );
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1 (default fallback variants): default-access read / deny / read_write.
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /admin/dry-run — default-access fallback (read/deny/read_write)", () => {
  let s: Setup;

  beforeAll(async () => {
    s = await setup("table_access:\n  default: read\n  tables: {}\n");
  });
  afterAll(() => teardown(s));

  async function swapDefault(level: string): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${s.server.port}/admin/policy`, {
      method: "POST",
      headers: {
        "content-type": "application/yaml",
        authorization: `Bearer ${TOKEN}`,
      },
      body: `table_access:\n  default: ${level}\n  tables: {}\n`,
    });
    expect(res.status).toBe(200);
  }

  test("default:read → unlisted select allow, insert deny", async () => {
    await swapDefault("read");
    expect((await probe(s, { table: "anything", action: "select" })).decision).toBe(
      "allow",
    );
    expect((await probe(s, { table: "anything", action: "insert" })).decision).toBe(
      "deny",
    );
  });

  test("default:deny → unlisted select deny (matched_rule default:deny)", async () => {
    await swapDefault("deny");
    const v = await probe(s, { table: "anything", action: "select" });
    expect(v.decision).toBe("deny");
    expect(v.matched_rule).toBe("default:deny");
  });

  test("default:read_write → unlisted insert allow (matched_rule default:read_write)", async () => {
    await swapDefault("read_write");
    const v = await probe(s, { table: "anything", action: "insert" });
    expect(v.decision).toBe("allow");
    expect(v.matched_rule).toBe("default:read_write");
  });

  test("policy_hash changes when the policy changes", async () => {
    await swapDefault("read");
    const a = (await post(s, { database: DEFAULT_DB_NAME, probes: [{ table: "x", action: "select" }] }))
      .body.policy_hash;
    await swapDefault("deny");
    const b = (await post(s, { database: DEFAULT_DB_NAME, probes: [{ table: "x", action: "select" }] }))
      .body.policy_hash;
    expect(a).not.toBe(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 + 3: cross_tenant semantics + custom SQL under tenant scoping.
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /admin/dry-run — tenant_scope", () => {
  let s: Setup;
  const TENANT = "__midplane_probe__";

  beforeAll(async () => {
    s = await setup(
      "tenant_scope:\n" +
        "  enabled: true\n" +
        "  column: account_id\n" +
        "  exempt:\n" +
        "    - regions\n" +
        "table_access:\n" +
        "  default: read\n" +
        "  tables:\n" +
        "    orders: read_write\n",
    );
  });
  afterAll(() => teardown(s));

  test("normal select on a scoped table → allow (synthetic tenant bound)", async () => {
    const v = await probe(s, { table: "orders", action: "select" });
    expect(v.decision).toBe("allow");
    expect(v.tables).toEqual(["orders"]);
  });

  test("cross_tenant select on a scoped table → deny (tenant_scope)", async () => {
    const v = await probe(s, {
      table: "orders",
      action: "select",
      cross_tenant: true,
    });
    expect(v.decision).toBe("deny");
    expect(v.matched_rule).toBe("tenant_scope:orders.account_id");
    expect(v.reason.toLowerCase()).toContain("cross-tenant");
  });

  test("cross_tenant on an UNSCOPED (exempt) table → normal decision (allow)", async () => {
    // regions is exempt → no scope → cross_tenant is a no-op; the normal
    // table_access decision stands. An allow here is exactly the
    // missing-scope the cloud UI exists to surface — not special-cased away.
    const v = await probe(s, {
      table: "regions",
      action: "select",
      cross_tenant: true,
    });
    expect(v.decision).toBe("allow");
    expect(v.matched_rule).toBe("default:read");
  });

  test("custom SQL with the scoping predicate bound → allow, scoped table reported", async () => {
    const res = await post(s, {
      database: DEFAULT_DB_NAME,
      tenant_context: { value: TENANT },
      sql: `SELECT * FROM orders WHERE account_id = '${TENANT}'`,
    });
    expect(res.status).toBe(200);
    const v = res.body.verdicts[0];
    expect(v.decision).toBe("allow");
    expect(v.sql).toContain("orders");
    expect(v.tables).toEqual(["orders"]);
    expect(v.probe).toBeUndefined();
  });

  test("custom SQL missing the predicate → deny (tenant_scope), table still reported", async () => {
    const res = await post(s, {
      database: DEFAULT_DB_NAME,
      tenant_context: { value: TENANT },
      sql: "SELECT * FROM orders",
    });
    expect(res.status).toBe(200);
    const v = res.body.verdicts[0];
    expect(v.decision).toBe("deny");
    expect(v.matched_rule).toBe("tenant_scope_missing");
    expect(v.tables).toEqual(["orders"]);
  });

  test("a different tenant_context value flips the cross-tenant binding", async () => {
    // With tenant_context bound to 'acme', a normal probe binds account_id =
    // 'acme' and passes; cross_tenant binds a different value and is denied.
    const ok = await probe(
      s,
      { table: "orders", action: "select" },
      { tenant_context: { value: "acme" } },
    );
    expect(ok.decision).toBe("allow");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6: drift guard — the live enforcement path (handle) and decide() must agree.
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /admin/dry-run — drift guard (handle vs decide)", () => {
  let s: Setup;
  const ctx: EngineContext = {
    tenant_id: "__self_host__",
    agent_name: null,
    agent_version: null,
    mcp_token_id: null,
    role: "agent_readonly",
  };
  // A spread across allow + every deny rule.
  const samples = [
    "SELECT * FROM users",
    "INSERT INTO users (id) VALUES (1)",
    "SELECT * FROM secrets",
    "DELETE FROM posts",
    "UPDATE posts SET name = 'x'",
    "SELECT 1; SELECT 2",
    "SELECT FROM WHERE",
    "SELECT * FROM unlisted_table",
  ];

  beforeAll(async () => {
    s = await setup(
      "table_access:\n" +
        "  default: read\n" +
        "  tables:\n" +
        "    users: read\n" +
        "    secrets: deny\n" +
        "    posts: read_write\n",
    );
  });
  afterAll(() => teardown(s));

  test("handle() and decide() return identical decisions + rule for every sample", async () => {
    const engine = s.handle.registry.get(DEFAULT_DB_NAME).engine;
    for (const sql of samples) {
      s.executor.result = { rows: [], rowCount: 0 };
      const live = await engine.handle({ sql, ctx, intent: "drift guard" });
      const preview = await engine.decide({ sql, ctx });
      const liveDecision = live.allowed ? "ALLOW" : "DENY";
      expect(preview.decision).toBe(liveDecision);
      if (!live.allowed) {
        expect(preview.reason).toBe(live.reason);
        expect(preview.message).toBe(live.message);
      }
    }
  });

  test("dry-run endpoint agrees with handle() over the same custom SQL", async () => {
    const engine = s.handle.registry.get(DEFAULT_DB_NAME).engine;
    for (const sql of samples.filter((q) => q !== "SELECT FROM WHERE")) {
      s.executor.result = { rows: [], rowCount: 0 };
      const live = await engine.handle({ sql, ctx, intent: "drift guard" });
      const res = await post(s, { database: DEFAULT_DB_NAME, sql });
      expect(res.status).toBe(200);
      const v = res.body.verdicts[0];
      expect(v.decision).toBe(live.allowed ? "allow" : "deny");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VERIFY: the dry-run path never opens a socket to the customer DB.
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /admin/dry-run — never opens a socket", () => {
  let s: Setup;

  beforeAll(async () => {
    s = await setup(
      "table_access:\n  default: read\n  tables:\n    posts: read_write\n",
    );
    // Poison the executor: any call to execute() throws, the way a connection
    // to a dead/poisoned DSN would. If the dry-run path touched the executor,
    // these requests would 500 or throw — they don't.
    s.executor.shouldThrow = { sqlstate: "08006", message: "poisoned DSN: connection refused" };
  });
  afterAll(() => teardown(s));

  test("probes (incl. allowed writes) never call the executor", async () => {
    const res = await post(s, {
      database: DEFAULT_DB_NAME,
      probes: [
        { table: "posts", action: "select" }, // allow
        { table: "posts", action: "insert" }, // allow — would execute on the live path
        { table: "other", action: "insert" }, // deny (default:read blocks the write)
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.verdicts.map((v: any) => v.decision)).toEqual([
      "allow",
      "allow",
      "deny",
    ]);
    // The smoking gun: the executor was never invoked.
    expect(s.executor.calls).toHaveLength(0);
  });

  test("custom SQL (allowed) never calls the executor", async () => {
    const res = await post(s, {
      database: DEFAULT_DB_NAME,
      sql: "INSERT INTO posts (id) VALUES (1)",
    });
    expect(res.status).toBe(200);
    expect(res.body.verdicts[0].decision).toBe("allow");
    expect(s.executor.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Posture: INDEXER_TOKEN unset → route reveals nothing (404).
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /admin/dry-run — INDEXER_TOKEN unset", () => {
  let dir: string;
  let handle: EngineHandle;
  let server: HttpHandle;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "midplane-dry-run-noauth-"));
    const dbPath = join(dir, "audit.db");
    handle = buildEngine(
      {
        databaseUrl: "postgres://stub",
        port: 0,
        dbPath,
        tenantId: "__self_host__",
        transport: "http",
      },
      { executor: new MockExecutor(), credentials: { resolve: async () => "postgres://stub" } },
    );
    // No `indexer` token → bearer check returns "missing" → 404.
    server = await startHttp(() => buildServer({ handle }), {
      port: 0,
      host: "127.0.0.1",
      admin: { setPolicy: handle.registry.setPolicy, dryRun: handle.registry.dryRun },
    });
  });

  afterAll(async () => {
    await server.close();
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("no token configured → 404 (route reveals nothing)", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/admin/dry-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ database: DEFAULT_DB_NAME, probes: [] }),
    });
    expect(res.status).toBe(404);
  });
});
