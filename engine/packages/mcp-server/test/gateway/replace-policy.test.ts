// Full-replacement apply (gateway mode) through the REAL buildEngine.
//
// The failure this exists to prevent: today's hot reload patches, so a section
// the control plane omits (because it was switched OFF) never reaches a warm
// engine — approvals keep holding, tenant scope keeps denying. In gateway mode
// a bundle is the whole policy: omitted means off. Assertions are end-of-chain
// (the gate is or isn't consulted, the query is or isn't denied) and run
// through the tool handler of an MCP server built BEFORE the swap, i.e. the
// same agent session, no restart.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApprovalGate, ApprovalOutcome, ApprovalRequest } from "@midplane/engine";
import { buildEngine, type BuiltEngineHandle, type ReplaceDatabase } from "../../src/engine-factory.ts";
import type { Config } from "../../src/config.ts";
import { checkBundlePolicy } from "../../src/gateway/policy-check.ts";
import { buildServer } from "../../src/server.ts";
import { MockExecutor } from "../_helpers.ts";

const MAIN_ENV = "MIDPLANE_DSN_01MAINAAAAAAAAAAAAAAAAAAAA";
const ANALYTICS_ENV = "MIDPLANE_DSN_01ANALYTICSAAAAAAAAAAAAAAA";
// Carries the tenant predicate, so tenant scope allows it and the approval
// stage (which runs only on ALLOW) is what decides.
const WRITE = "UPDATE orders SET status = 'x' WHERE id = 1 AND tenant_id = '__self_host__'";
const UNSCOPED_READ = "SELECT id FROM orders";

class CountingGate implements ApprovalGate {
  readonly seen: ApprovalRequest[] = [];
  async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    this.seen.push(req);
    return { status: "approved", by: "ada@example.com", note: null };
  }
}

interface DbOpts {
  name?: string;
  env?: string;
  tenantScope?: boolean;
  approvals?: boolean;
  masks?: boolean;
  tableDefault?: "deny" | "read" | "read_write";
}

function dbYaml(o: DbOpts): string[] {
  const lines = [
    `  - name: ${o.name ?? "main"}`,
    `    url: \${${o.env ?? MAIN_ENV}}`,
    "    table_access:",
    `      default: ${o.tableDefault ?? "read_write"}`,
    "      tables: {}",
  ];
  if (o.tenantScope) lines.push("    tenant_scope:", "      column: tenant_id");
  lines.push("    guardrails:", "      block_unqualified_dml: true", "      block_ddl: true");
  const features = [...(o.masks ? ["column_masks"] : []), ...(o.approvals ? ["write_approvals"] : [])];
  if (features.length) lines.push("    requires_features:", ...features.map((f) => `      - ${f}`));
  if (o.masks) lines.push("    column_masks:", "      public.users:", "        email: full-redact");
  if (o.approvals) lines.push("    approvals:", "      writes: true");
  return lines;
}

function bundlePolicy(...dbs: DbOpts[]): string {
  return ["databases:", ...dbs.flatMap(dbYaml)].join("\n") + "\n";
}

describe("replacePolicy", () => {
  let dir: string;
  let handle: BuiltEngineHandle;
  let gate: CountingGate;

  function build(cfgOver: Partial<Config> = {}, executor?: MockExecutor): BuiltEngineHandle {
    return buildEngine(
      {
        port: 0,
        host: "127.0.0.1",
        dbPath: join(dir, "audit.db"),
        tenantId: "__self_host__",
        transport: "http",
        maskSalt: "s".repeat(32),
        maskSourceRewrite: false,
        ...cfgOver,
      },
      { startEmpty: true, executor, approvalGate: gate },
    );
  }

  /** What the gateway runtime does with a verified bundle: check, resolve DSNs
   *  from its env, apply. */
  async function apply(yaml: string, version: number, env: Record<string, string> = defaultEnv()) {
    const checked = checkBundlePolicy(yaml);
    if (!checked.ok) throw new Error(checked.reason);
    const dbs: ReplaceDatabase[] = checked.databases.map((d) => {
      const dsn = env[d.dsnEnv];
      return { spec: { ...d.spec, url: dsn ?? "" }, dsnEnv: d.dsnEnv, configured: Boolean(dsn) };
    });
    return handle.replacePolicy(dbs, { bundleVersion: version });
  }

  function defaultEnv(): Record<string, string> {
    return { [MAIN_ENV]: "postgres://gw@db.internal/main", [ANALYTICS_ENV]: "postgres://gw@db.internal/analytics" };
  }

  function queryTool(server: ReturnType<typeof buildServer>) {
    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown) => Promise<unknown> }> })
      ._registeredTools;
    return (sql: string) => tools.query!.handler({ sql, intent: "test" }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "midplane-replace-"));
    gate = new CountingGate();
  });

  afterEach(async () => {
    await handle?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("starts empty: never received a policy ⇒ nothing registered", () => {
    handle = build({}, new MockExecutor());
    expect(handle.registry.count()).toBe(0);
    expect(handle.policySnapshot()).toEqual([]);
  });

  test("approvals and tenant scope switched OFF reach a warm gateway, same session, no restart", async () => {
    const executor = new MockExecutor();
    handle = build({}, executor);
    await apply(bundlePolicy({ approvals: true, tenantScope: true }), 1);

    const server = buildServer({ handle, approvalGate: gate });
    const query = queryTool(server);

    // v1: the write is held (the gate is consulted) and the unscoped read is denied.
    await query(WRITE);
    expect(gate.seen).toHaveLength(1);
    const denied = await query(UNSCOPED_READ);
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toContain("tenant_scope");

    // v2 omits both sections — the control plane's serializer emits nothing for
    // a switched-off section. Under the patch semantics this changed nothing.
    await apply(bundlePolicy({}), 2);

    const executedBefore = executor.calls.length;
    await query(WRITE);
    expect(gate.seen).toHaveLength(1); // not consulted: approvals are off
    const allowed = await query(UNSCOPED_READ);
    expect(allowed.isError).toBeUndefined();
    expect(executor.calls.length).toBe(executedBefore + 2);

    const [snap] = handle.policySnapshot();
    expect(snap!.approvals).toEqual({ row_changes: false, whole_table_writes: false, schema_changes: false });
    expect(snap!.tenant_scope).toBeNull();
  });

  test("switching them back ON reaches the same session too", async () => {
    handle = build({}, new MockExecutor());
    await apply(bundlePolicy({}), 1);
    const query = queryTool(buildServer({ handle, approvalGate: gate }));
    await query(WRITE);
    expect(gate.seen).toHaveLength(0);

    await apply(bundlePolicy({ approvals: true }), 2);
    await query(WRITE);
    expect(gate.seen).toHaveLength(1);
  });

  test("masks: adding or removing them rebuilds the Engine but keeps the pool", async () => {
    // No injected executor: real (lazy, never-connected) pools, so identity is
    // meaningful. Nothing here queries the database.
    handle = build();
    await apply(bundlePolicy({ masks: true }), 1);
    const v1 = handle.registry.get("main");
    expect(handle.policySnapshot()[0]!.column_masks).toEqual({ "public.users": { email: "full-redact" } });

    await apply(bundlePolicy({}), 2);
    const v2 = handle.registry.get("main");
    expect(v2.engine).not.toBe(v1.engine);
    expect(v2.executor).toBe(v1.executor);
    expect(handle.policySnapshot()[0]!.column_masks).toBeNull();

    // A policy-only edit swaps in place: same Engine.
    await apply(bundlePolicy({ approvals: true }), 3);
    expect(handle.registry.get("main").engine).toBe(v2.engine);
  });

  test("a changed DSN rebuilds the entry with a new pool", async () => {
    handle = build();
    await apply(bundlePolicy({}), 1);
    const before = handle.registry.get("main");
    await apply(bundlePolicy({}), 2, { ...defaultEnv(), [MAIN_ENV]: "postgres://gw@db-2.internal/main" });
    expect(handle.registry.get("main").executor).not.toBe(before.executor);
  });

  test("a database dropped from the bundle is removed", async () => {
    handle = build({}, new MockExecutor());
    await apply(bundlePolicy({}, { name: "analytics", env: ANALYTICS_ENV }), 1);
    expect(handle.registry.names()).toEqual(["analytics", "main"]);
    await apply(bundlePolicy({}), 2);
    expect(handle.registry.names()).toEqual(["main"]);
  });

  test("a database whose DSN variable is unset refuses every call, naming it; the others take the bundle", async () => {
    handle = build({}, new MockExecutor());
    await apply(bundlePolicy({}, { name: "analytics", env: ANALYTICS_ENV }), 1, {
      [MAIN_ENV]: "postgres://gw@db.internal/main",
    });

    const snap = handle.policySnapshot();
    expect(snap.find((d) => d.name === "analytics")).toMatchObject({ status: "unconfigured", dsn_env: ANALYTICS_ENV });
    expect(snap.find((d) => d.name === "main")).toMatchObject({ status: "ready", dsn_env: MAIN_ENV });

    const ctx = { ...handle.registry.get("analytics").ctxBase, agent_name: "t", agent_version: "1" };
    await expect(handle.registry.get("analytics").engine.handle({ sql: "SELECT 1", ctx })).rejects.toThrow(
      new RegExp(`not configured on this gateway: set ${ANALYTICS_ENV}`),
    );
    const failed = handle.registry.audit
      .readSince("0", 100)
      .filter((r) => r.event_type === "FAILED" && r.database === "analytics");
    expect(failed).toHaveLength(1);
  });

  test("all-or-nothing: a database that can't be built leaves every other database untouched", async () => {
    // No salt: a masked database can't be built.
    handle = build({ maskSalt: undefined }, new MockExecutor());
    await apply(bundlePolicy({ tableDefault: "read_write" }), 1);

    await expect(
      apply(bundlePolicy({ tableDefault: "deny" }, { name: "analytics", env: ANALYTICS_ENV, masks: true }), 2),
    ).rejects.toThrow(/MIDPLANE_MASK_SALT/);

    expect(handle.registry.names()).toEqual(["main"]);
    expect(handle.policySnapshot()[0]!.table_access_default).toBe("read_write");
  });

  test("table_access and guardrails have no 'off': a spec without them is refused", async () => {
    handle = build({}, new MockExecutor());
    const checked = checkBundlePolicy(bundlePolicy({}));
    if (!checked.ok) throw new Error(checked.reason);
    const d = checked.databases[0]!;
    await expect(
      handle.replacePolicy([{ ...d, spec: { ...d.spec, tableAccess: null, hasTableAccess: false }, configured: true }], {
        bundleVersion: 1,
      }),
    ).rejects.toThrow(/no table_access/);
    expect(handle.registry.count()).toBe(0);
  });

  test("POLICY_RELOADED names the bundle version and reports approvals and masks", async () => {
    handle = build();
    await apply(bundlePolicy({ approvals: true, masks: true }), 7);
    await apply(bundlePolicy({}), 8);

    const rows = handle.registry.audit.readSince("0", 100).filter((r) => r.event_type === "POLICY_RELOADED");
    const last = rows.at(-1)!;
    const payload = (typeof last.payload === "string" ? JSON.parse(last.payload) : last.payload) as Record<string, unknown>;
    expect(payload.source).toBe("bundle");
    expect(payload.bundle_version).toBe(8);
    expect(payload.sections_changed).toEqual(["approvals", "column_masks"]);
    expect(payload.approvals).toEqual({ row_changes: false, whole_table_writes: false, schema_changes: false });
    expect(payload.column_masks).toBeNull();
    expect((payload.diff as Record<string, unknown>).column_masks).toEqual({ removed: ["public.users.email"] });
  });
});
