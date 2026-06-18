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
      const res = await client.callTool({
        name: "query",
        arguments: { sql, intent: "admin-policy test query" },
      });
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

  test("audit log contains POLICY_RELOADED event with self-describing payload", async () => {
    // Read the audit DB directly — POLICY_RELOADED is the new event_type
    // we expect to find for every successful swap above. The payload
    // shape is the contract the cloud audit dashboard indexes against
    // (sections_changed / databases_changed / diff). This test pins
    // every required key so an accidental rename breaks here.
    const rows = handle.registry.audit.readSince("0", 1000);
    const reloads = rows.filter((r) => r.event_type === "POLICY_RELOADED");
    expect(reloads.length).toBeGreaterThanOrEqual(1);
    const last = reloads[reloads.length - 1]!;
    const payload = last.payload as {
      source: string;
      sections_changed: string[];
      databases_changed: string[];
      table_access: { default: string; tables: Record<string, string> };
      tenant_scope: {
        column: string | null;
        overrides: Record<string, string>;
        exempt: string[];
      } | null;
      diff: {
        table_access: {
          default?: { from: string | null; to: string };
          tables_added?: Record<string, string>;
          tables_removed?: Record<string, string>;
          tables_changed?: Record<string, { from: string; to: string }>;
        } | null;
        tenant_scope: {
          column?: { from: string | null; to: string | null };
          overrides_added?: Record<string, string>;
          overrides_removed?: Record<string, string>;
          overrides_changed?: Record<string, { from: string; to: string }>;
          exempt_added?: string[];
          exempt_removed?: string[];
        } | null;
      };
    };
    expect(payload.source).toBe("admin_endpoint");
    expect(payload.table_access.default).toBe("deny");
    // The most-recent successful swap in this describe block changed
    // table_access (default: maybe → deny path was via the "valid bearer
    // + valid YAML" test that flipped users to deny + posts to read_write).
    expect(payload.sections_changed).toContain("table_access");
    expect(payload.databases_changed).toContain("__default__");
    expect(payload.diff.table_access).not.toBeNull();
  });

  test("POLICY_RELOADED diff names which tables flipped", async () => {
    // Run two swaps and inspect the second swap's diff. The first
    // installs a baseline; the second adds a table, removes one, and
    // flips one — the diff payload's three buckets should each name
    // exactly the affected key.
    const baseline =
      "table_access:\n" +
      "  default: deny\n" +
      "  tables:\n" +
      "    users: read\n" +
      "    posts: read\n" +
      "    archive: read_write\n";
    const r1 = await fetch(url("/admin/policy"), {
      method: "POST",
      headers: {
        "content-type": "application/yaml",
        authorization: `Bearer ${TOKEN}`,
      },
      body: baseline,
    });
    expect(r1.status).toBe(200);

    const next =
      "table_access:\n" +
      "  default: deny\n" +
      "  tables:\n" +
      "    users: read_write\n" + // changed: read → read_write
      "    archive: read_write\n" + // unchanged
      "    new_table: read\n"; // added; `posts` removed
    const r2 = await fetch(url("/admin/policy"), {
      method: "POST",
      headers: {
        "content-type": "application/yaml",
        authorization: `Bearer ${TOKEN}`,
      },
      body: next,
    });
    expect(r2.status).toBe(200);

    // ULIDs generated in the same millisecond sort non-deterministically
    // (the engine's `ulid()` calls are not monotonic). Two POSTs back-to-
    // back in CI's fast runner can land in the same ms, so reading the
    // "last" reload by id position is racy. Instead, locate the row by
    // content — the only POLICY_RELOADED row in this entire test file
    // whose diff carries `new_table` is the one we're asserting against.
    const reloads = handle.registry.audit
      .readSince("0", 1000)
      .filter((r) => r.event_type === "POLICY_RELOADED");
    const target = reloads.find((r) => {
      const ta = (r.payload as { diff?: { table_access?: { tables_added?: Record<string, string> } } })
        .diff?.table_access?.tables_added;
      return ta !== undefined && Object.prototype.hasOwnProperty.call(ta, "new_table");
    });
    expect(target).toBeDefined();
    const diff = (target!.payload as { diff: { table_access: any } }).diff
      .table_access as {
      tables_added?: Record<string, string>;
      tables_removed?: Record<string, string>;
      tables_changed?: Record<string, { from: string; to: string }>;
    };
    expect(diff.tables_added).toEqual({ new_table: "read" });
    expect(diff.tables_removed).toEqual({ posts: "read" });
    expect(diff.tables_changed).toEqual({
      users: { from: "read", to: "read_write" },
    });
  });

  test("guardrails: default-ON enforces through the query tool; hot-reload off + don't-touch", async () => {
    const postPolicy = (body: string) =>
      fetch(url("/admin/policy"), {
        method: "POST",
        headers: { "content-type": "application/yaml", authorization: `Bearer ${TOKEN}` },
        body,
      });

    // `posts` writable; NO guardrails block ⇒ default ON. (This block never
    // activates tenant_scope, so the guardrail is what governs DDL/no-WHERE DML.)
    const onYaml = "table_access:\n  default: deny\n  tables:\n    posts: read_write\n";
    expect((await postPolicy(onYaml)).status).toBe(200);

    // End-to-end through the real `query` tool: the guardrail denies DDL and
    // no-WHERE DML on a read_write table, proving the engine-factory wires it
    // default-ON without any guardrails YAML.
    const drop = await runQuery("DROP TABLE posts");
    expect(drop.isError).toBe(true);
    expect(drop.data.policy_rule).toBe("dangerous_statement");

    const wipe = await runQuery("DELETE FROM posts");
    expect(wipe.isError).toBe(true);
    expect(wipe.data.policy_rule).toBe("dangerous_statement");

    // A WHERE-qualified DELETE still flows through to execution.
    expect((await runQuery("DELETE FROM posts WHERE id = 1")).isError).toBe(false);

    expect(handle.registry.describe()[0]!.guardrails_block_ddl).toBe(true);

    // Hot-reload guardrails OFF (re-send the required table_access).
    const offYaml =
      "table_access:\n  default: deny\n  tables:\n    posts: read_write\n" +
      "guardrails:\n  block_ddl: false\n  block_unqualified_dml: false\n";
    expect((await postPolicy(offYaml)).status).toBe(200);

    expect((await runQuery("DROP TABLE posts")).isError).toBe(false);
    expect(handle.registry.describe()[0]!.guardrails_block_ddl).toBe(false);

    // The POLICY_RELOADED row names guardrails as a changed section.
    const reloads = handle.registry.audit
      .readSince("0", 1000)
      .filter((r) => r.event_type === "POLICY_RELOADED");
    const target = reloads.find((r) => {
      const g = (r.payload as { diff?: { guardrails?: { block_ddl?: { from: boolean; to: boolean } } } })
        .diff?.guardrails?.block_ddl;
      return g?.from === true && g?.to === false;
    });
    expect(target).toBeDefined();
    expect((target!.payload as { sections_changed: string[] }).sections_changed).toContain(
      "guardrails",
    );

    // Don't-touch: a table_access-only swap must NOT silently re-enable the
    // guardrails the operator turned off (mirrors tenant_scope's omit rule).
    expect((await postPolicy(onYaml)).status).toBe(200);
    expect((await runQuery("DROP TABLE posts")).isError).toBe(false);
    expect(handle.registry.describe()[0]!.guardrails_block_ddl).toBe(false);
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

describe("POST /admin/policy — tenant_scope.mappings hot-swap", () => {
  // 0.4.0: tenant_scope.mappings now hot-swaps via the holder, same
  // pattern as table_access. The cloud dashboard's per-DB mapping editor
  // pushes through this endpoint, so the swap is required to round-trip
  // (200 → describe() reports new mappings → next query observes them).
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

  test("payload that adds a mapping → 200, describe() reports the new mapping", async () => {
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
    expect(res.status).toBe(200);

    const desc = handle.registry.describe();
    expect(desc[0]!.tenant_scope_overrides).toEqual({
      users: "org_id",
      posts: "tenant_id",
    });

    // POLICY_RELOADED row was written and names tenant_scope as a changed
    // section.
    const reloads = handle.registry.audit
      .readSince("0", 1000)
      .filter((r) => r.event_type === "POLICY_RELOADED");
    expect(reloads.length).toBeGreaterThanOrEqual(1);
    const last = reloads[reloads.length - 1]!;
    const payload = last.payload as {
      sections_changed: string[];
      diff: { tenant_scope: { overrides_added?: Record<string, string> } | null };
    };
    expect(payload.sections_changed).toContain("tenant_scope");
    expect(payload.diff.tenant_scope?.overrides_added).toEqual({
      posts: "tenant_id",
    });
  });

  test("payload that omits tenant_scope is a no-op for overrides — current state preserved", async () => {
    const yaml =
      "table_access:\n" +
      "  default: deny\n" +
      "  tables:\n" +
      "    users: read\n";
    // Omitted section means "don't touch" — the prior swap left
    // mappings = { users, posts }; this body changes only table_access
    // and must leave the mappings alone.
    const res = await fetch(url("/admin/policy"), {
      method: "POST",
      headers: {
        "content-type": "application/yaml",
        authorization: `Bearer ${TOKEN}`,
      },
      body: yaml,
    });
    expect(res.status).toBe(200);
    const desc = handle.registry.describe();
    expect(desc[0]!.tenant_scope_overrides).toEqual({
      users: "org_id",
      posts: "tenant_id",
    });
  });

  test("payload that re-sends matching mappings → 200, no change recorded in diff", async () => {
    const yaml =
      "tenant_scope:\n" +
      "  enabled: true\n" +
      "  mappings:\n" +
      "    users: org_id\n" +
      "    posts: tenant_id\n" + // identical to current state
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
    // The diff for tenant_scope should be empty (no added/removed/changed).
    const reloads = handle.registry.audit
      .readSince("0", 1000)
      .filter((r) => r.event_type === "POLICY_RELOADED");
    const last = reloads[reloads.length - 1]!;
    const payload = last.payload as {
      sections_changed: string[];
      diff: { tenant_scope: object | null };
    };
    expect(payload.sections_changed).not.toContain("tenant_scope");
  });

  test("payload that clears mappings (mappings: {}) → 200, future queries allow", async () => {
    const yaml =
      "tenant_scope:\n" +
      "  enabled: true\n" +
      "  mappings: {}\n" + // explicit clear
      "table_access:\n" +
      "  default: deny\n" +
      "  tables:\n" +
      "    users: read\n";
    const res = await fetch(url("/admin/policy"), {
      method: "POST",
      headers: {
        "content-type": "application/yaml",
        authorization: `Bearer ${TOKEN}`,
      },
      body: yaml,
    });
    expect(res.status).toBe(200);
    const desc = handle.registry.describe();
    expect(desc[0]!.tenant_scope_overrides).toEqual({});
    expect(desc[0]!.tenant_scope_column).toBeNull();
    expect(desc[0]!.tenant_scope_enabled).toBe(false);
  });

  test("payload that adds column + exempt → 200, describe() + diff reflect them", async () => {
    // 0.5.0 strict-mode hot-swap: upgrade from `mappings`-only to a
    // universal `column` plus an `exempt` list. The diff payload must
    // call out the new column and exempt entries so a self-host operator
    // can read the audit row alone and verify what they pushed.
    const yaml =
      "tenant_scope:\n" +
      "  enabled: true\n" +
      "  column: tenant_id\n" +
      "  overrides:\n" +
      "    orders: org_id\n" +
      "  exempt:\n" +
      "    - audit_log\n" +
      "    - regions\n" +
      "table_access:\n" +
      "  default: deny\n" +
      "  tables:\n" +
      "    users: read\n";
    const res = await fetch(url("/admin/policy"), {
      method: "POST",
      headers: {
        "content-type": "application/yaml",
        authorization: `Bearer ${TOKEN}`,
      },
      body: yaml,
    });
    expect(res.status).toBe(200);

    const desc = handle.registry.describe();
    expect(desc[0]!.tenant_scope_column).toBe("tenant_id");
    expect(desc[0]!.tenant_scope_overrides).toEqual({ orders: "org_id" });
    expect(desc[0]!.tenant_scope_exempt.sort()).toEqual(["audit_log", "regions"]);
    expect(desc[0]!.tenant_scope_enabled).toBe(true);

    // Same race the "POLICY_RELOADED diff names which tables flipped"
    // test guards against: ULIDs minted in the same millisecond sort
    // non-deterministically, so reading "the last reload" is racy in
    // full-suite runs. Locate by content — the only reload row that
    // promotes column from null → "tenant_id" is this one.
    const reloads = handle.registry.audit
      .readSince("0", 1000)
      .filter((r) => r.event_type === "POLICY_RELOADED");
    const target = reloads.find((r) => {
      const diff = (r.payload as { diff?: { tenant_scope?: { column?: { from: string | null; to: string | null } } } })
        .diff?.tenant_scope?.column;
      return diff?.from === null && diff?.to === "tenant_id";
    });
    expect(target).toBeDefined();
    const payload = target!.payload as {
      sections_changed: string[];
      tenant_scope: { column: string | null; overrides: Record<string, string>; exempt: string[] } | null;
      diff: {
        tenant_scope: {
          column?: { from: string | null; to: string | null };
          overrides_added?: Record<string, string>;
          exempt_added?: string[];
        } | null;
      };
    };
    expect(payload.sections_changed).toContain("tenant_scope");
    expect(payload.tenant_scope).not.toBeNull();
    expect(payload.tenant_scope!.column).toBe("tenant_id");
    expect(payload.diff.tenant_scope?.column).toEqual({
      from: null,
      to: "tenant_id",
    });
    expect(payload.diff.tenant_scope?.exempt_added?.sort()).toEqual([
      "audit_log",
      "regions",
    ]);
  });
});

describe("POST /admin/policy — tenant_scope strict-mode round-trip", () => {
  // The strict-mode flow end-to-end: start with `mappings` (legacy),
  // hot-swap to strict (`column: tenant_id`), confirm a query on an
  // un-listed table now denies through the live MCP transport.
  const TOKEN = "test-admin-token-strict";
  let dir: string;
  let dbPath: string;
  let executor: MockExecutor;
  let handle: EngineHandle;
  let server: HttpHandle;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "midplane-admin-policy-strict-"));
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
        "    users: tenant_id\n" + // legacy mode: only `users` checked
        "table_access:\n" +
        "  default: read\n" +
        "  tables: {}\n",
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

  function urlFor(path: string): string {
    return `http://127.0.0.1:${server.port}${path}`;
  }

  async function runQuery(sql: string): Promise<{ isError: boolean; data: any }> {
    const transport = new StreamableHTTPClientTransport(new URL(urlFor("/mcp")));
    const client = new Client({ name: "admin-policy-strict-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      executor.result = { rows: [{ id: 1 }], rowCount: 1 };
      const res = await client.callTool({
        name: "query",
        arguments: { sql, intent: "strict-mode round-trip" },
      });
      const content = res.content as Array<{ text: string }>;
      return { isError: !!res.isError, data: JSON.parse(content[0]!.text) };
    } finally {
      await client.close();
    }
  }

  test("legacy mode: un-listed table allows (the silent-leak footgun)", async () => {
    const r = await runQuery("SELECT * FROM invoices");
    expect(r.isError).toBe(false);
  });

  test("hot-swap to strict (column: tenant_id) → un-listed table now denies", async () => {
    const yaml =
      "tenant_scope:\n" +
      "  enabled: true\n" +
      "  column: tenant_id\n" + // strict: every queried table requires the column
      "table_access:\n" +
      "  default: read\n" +
      "  tables: {}\n";
    const res = await fetch(urlFor("/admin/policy"), {
      method: "POST",
      headers: {
        "content-type": "application/yaml",
        authorization: `Bearer ${TOKEN}`,
      },
      body: yaml,
    });
    expect(res.status).toBe(200);

    const r = await runQuery("SELECT * FROM invoices");
    expect(r.isError).toBe(true);
    expect(r.data.policy_rule).toBe("tenant_scope_missing");

    // Scoped query allows. The literal must be the engine's tenant_id
    // context (set to `__self_host__` by buildTestHandle); use a string
    // literal so the AST emits an `A_Const.sval` the rule recognizes.
    const ok = await runQuery("SELECT * FROM invoices WHERE tenant_id = '__self_host__'");
    expect(ok.isError).toBe(false);
  });

  test("exempt entry added → that table allows without predicate", async () => {
    const yaml =
      "tenant_scope:\n" +
      "  enabled: true\n" +
      "  column: tenant_id\n" +
      "  exempt:\n" +
      "    - regions\n" +
      "table_access:\n" +
      "  default: read\n" +
      "  tables: {}\n";
    const res = await fetch(urlFor("/admin/policy"), {
      method: "POST",
      headers: {
        "content-type": "application/yaml",
        authorization: `Bearer ${TOKEN}`,
      },
      body: yaml,
    });
    expect(res.status).toBe(200);

    const r = await runQuery("SELECT * FROM regions");
    expect(r.isError).toBe(false);

    // But other tables still need the predicate.
    const r2 = await runQuery("SELECT * FROM invoices");
    expect(r2.isError).toBe(true);
  });

  test("strict mode + table_access:read_write: UPDATE WHERE tenant_id allows", async () => {
    // Reviewer-named regression (pre-fix): strict mode + `read_write`
    // tables — every UPDATE/DELETE denied as `tenant_scope_missing`
    // regardless of predicate, because the rule blanket-denied any DML
    // on a scoped table. The fix runs the same WHERE-predicate check
    // SELECT uses; a correctly-scoped UPDATE now allows.
    const yaml =
      "tenant_scope:\n" +
      "  enabled: true\n" +
      "  column: tenant_id\n" +
      "table_access:\n" +
      "  default: read\n" +
      "  tables:\n" +
      "    feature_flags: read_write\n";
    const res = await fetch(urlFor("/admin/policy"), {
      method: "POST",
      headers: {
        "content-type": "application/yaml",
        authorization: `Bearer ${TOKEN}`,
      },
      body: yaml,
    });
    expect(res.status).toBe(200);

    // Bare UPDATE still denies — no tenant predicate.
    const bare = await runQuery("UPDATE feature_flags SET name = 'beta'");
    expect(bare.isError).toBe(true);
    expect(bare.data.policy_rule).toBe("tenant_scope_missing");

    // UPDATE with the scoping predicate allows.
    const scoped = await runQuery(
      "UPDATE feature_flags SET name = 'beta' WHERE tenant_id = '__self_host__'",
    );
    expect(scoped.isError).toBe(false);

    // DELETE follows the same pattern.
    const del = await runQuery(
      "DELETE FROM feature_flags WHERE tenant_id = '__self_host__'",
    );
    expect(del.isError).toBe(false);
  });

  test("strict mode: list_tables works (information_schema is carved out)", async () => {
    // Reviewer-named regression (pre-fix): the canned list_tables /
    // describe_table queries against information_schema failed with
    // `tenant_scope_missing` under strict mode because the rule didn't
    // distinguish system schemas. Matches table_access's existing
    // carve-out at table-access.ts:447.
    const yaml =
      "tenant_scope:\n" +
      "  enabled: true\n" +
      "  column: tenant_id\n" +
      "table_access:\n" +
      "  default: read\n" +
      "  tables: {}\n";
    const res = await fetch(urlFor("/admin/policy"), {
      method: "POST",
      headers: {
        "content-type": "application/yaml",
        authorization: `Bearer ${TOKEN}`,
      },
      body: yaml,
    });
    expect(res.status).toBe(200);

    // Drive the actual tool through MCP so we exercise the full
    // canned-SQL path.
    const transport = new StreamableHTTPClientTransport(new URL(urlFor("/mcp")));
    const client = new Client({ name: "admin-policy-strict-list-tables", version: "0.0.0" });
    await client.connect(transport);
    try {
      executor.result = {
        rows: [{ table_schema: "public", table_name: "users" }],
        rowCount: 1,
      };
      const out = await client.callTool({
        name: "list_tables",
        arguments: {},
      });
      expect(out.isError).toBeFalsy();
      const data = JSON.parse((out.content as Array<{ text: string }>)[0]!.text);
      expect(data.allowed).toBe(true);
      expect(data.tables).toEqual([{ schema: "public", name: "users" }]);
    } finally {
      await client.close();
    }
  });

  test("YAML with both `mappings` and `overrides` set → 400, holder intact", async () => {
    const bad =
      "tenant_scope:\n" +
      "  enabled: true\n" +
      "  mappings:\n" +
      "    users: org_id\n" +
      "  overrides:\n" +
      "    posts: org_id\n" +
      "table_access:\n" +
      "  default: read\n" +
      "  tables: {}\n";
    const res = await fetch(urlFor("/admin/policy"), {
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
    expect(body.error).toMatch(/both `mappings` and `overrides`/);
  });
});
