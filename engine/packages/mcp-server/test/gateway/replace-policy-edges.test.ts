// replacePolicy branches the main replace suite doesn't reach: refusals on a
// warm engine (duplicate names, no guardrails) that must change nothing, mask
// rule CHANGES and the enforcement-mode flip (both rebuild the Engine on the
// same pool), and a masked database whose DSN variable is unset.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEngine, type BuiltEngineHandle, type ReplaceDatabase } from "../../src/engine-factory.ts";
import type { Config } from "../../src/config.ts";
import { checkBundlePolicy } from "../../src/gateway/policy-check.ts";
import { MockExecutor } from "../_helpers.ts";

const MAIN_ENV = "MIDPLANE_DSN_01MAINAAAAAAAAAAAAAAAAAAAA";
const ANALYTICS_ENV = "MIDPLANE_DSN_01ANALYTICSAAAAAAAAAAAAAAA";

interface Db {
  name?: string;
  env?: string;
  masks?: Record<string, string>;
  rewrite?: boolean;
  tableDefault?: string;
}

function yaml(...dbs: Db[]): string {
  const lines = ["databases:"];
  for (const d of dbs) {
    lines.push(
      `  - name: ${d.name ?? "main"}`,
      `    url: \${${d.env ?? MAIN_ENV}}`,
      "    table_access:",
      `      default: ${d.tableDefault ?? "read"}`,
      "      tables: {}",
      "    guardrails:",
      "      block_unqualified_dml: true",
      "      block_ddl: true",
    );
    const features = [...(d.masks ? ["column_masks"] : []), ...(d.rewrite !== undefined ? ["mask_source_rewrite"] : [])];
    if (features.length) lines.push("    requires_features:", ...features.map((f) => `      - ${f}`));
    if (d.rewrite !== undefined) lines.push(`    mask_source_rewrite: ${d.rewrite}`);
    if (d.masks) {
      lines.push("    column_masks:", "      public.users:", ...Object.entries(d.masks).map(([c, r]) => `        ${c}: ${r}`));
    }
  }
  return lines.join("\n") + "\n";
}

describe("replacePolicy — edges", () => {
  let dir: string;
  let handle: BuiltEngineHandle;

  function build(executor?: MockExecutor, over: Partial<Config> = {}): BuiltEngineHandle {
    return buildEngine(
      {
        port: 0,
        host: "127.0.0.1",
        dbPath: join(dir, "audit.db"),
        tenantId: "__self_host__",
        transport: "http",
        maskSalt: "s".repeat(32),
        maskSourceRewrite: false,
        ...over,
      },
      { startEmpty: true, executor },
    );
  }

  function resolve(y: string, env: Record<string, string>): ReplaceDatabase[] {
    const checked = checkBundlePolicy(y);
    if (!checked.ok) throw new Error(checked.reason);
    return checked.databases.map((d) => {
      const dsn = env[d.dsnEnv];
      return { spec: { ...d.spec, url: dsn ?? "" }, dsnEnv: d.dsnEnv, configured: Boolean(dsn) };
    });
  }

  const ENV = { [MAIN_ENV]: "postgres://gw@db.internal/main", [ANALYTICS_ENV]: "postgres://gw@db.internal/analytics" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "midplane-replace-edge-"));
  });
  afterEach(async () => {
    await handle?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a duplicate database or a missing guardrails section is refused on a warm engine, changing nothing", async () => {
    handle = build(new MockExecutor());
    await handle.replacePolicy(resolve(yaml({}, { name: "analytics", env: ANALYTICS_ENV }), ENV), { bundleVersion: 1 });
    const before = handle.policySnapshot();
    const engines = handle.registry.names().map((n) => handle.registry.get(n).engine);
    const reloads = () => handle.registry.audit.readSince("0", 100).filter((r) => r.event_type === "POLICY_RELOADED").length;
    const rowsBefore = reloads();

    const [main] = resolve(yaml({ tableDefault: "read_write" }), ENV);
    await expect(handle.replacePolicy([main!, main!], { bundleVersion: 2 })).rejects.toThrow(/more than once/);
    await expect(
      handle.replacePolicy([{ ...main!, spec: { ...main!.spec, hasGuardrails: false } }], { bundleVersion: 2 }),
    ).rejects.toThrow(/no guardrails/);

    expect(handle.policySnapshot()).toEqual(before);
    expect(handle.registry.names().map((n) => handle.registry.get(n).engine)).toEqual(engines);
    expect(reloads()).toBe(rowsBefore); // a refused bundle writes no reload row
  });

  test("a changed mask rule or enforcement mode rebuilds the Engine on the same pool, and the row says what changed", async () => {
    // Real (lazy, never-connected) pools: masking needs an executor with query().
    handle = build();
    await handle.replacePolicy(resolve(yaml({ masks: { email: "full-redact" } }), ENV), { bundleVersion: 1 });
    const v1 = handle.registry.get("main");
    expect(handle.policySnapshot()[0]!.mask_source_rewrite).toBe(false); // inherits the engine default

    await handle.replacePolicy(resolve(yaml({ masks: { email: "null-out", phone: "full-redact" } }), ENV), { bundleVersion: 2 });
    const v2 = handle.registry.get("main");
    expect(v2.engine).not.toBe(v1.engine);
    expect(v2.executor).toBe(v1.executor);
    const rows = handle.registry.audit.readSince("0", 100).filter((r) => r.event_type === "POLICY_RELOADED");
    const payload = rows.at(-1)!.payload as { bundle_version: number; sections_changed: string[]; diff: { column_masks: unknown } };
    expect(payload.bundle_version).toBe(2);
    expect(payload.sections_changed).toEqual(["column_masks"]);
    expect(payload.diff.column_masks).toEqual({
      added: { "public.users.phone": "full-redact" },
      changed: { "public.users.email": { from: "full-redact", to: "null-out" } },
    });

    // Same masks, enforcement mode flipped per database: still a rebuild.
    await handle.replacePolicy(resolve(yaml({ masks: { email: "null-out", phone: "full-redact" }, rewrite: true }), ENV), {
      bundleVersion: 3,
    });
    const v3 = handle.registry.get("main");
    expect(v3.engine).not.toBe(v2.engine);
    expect(v3.executor).toBe(v1.executor);
    expect(handle.policySnapshot()[0]!.mask_source_rewrite).toBe(true);

    // Identical bundle content under a new version: nothing to rebuild.
    await handle.replacePolicy(resolve(yaml({ masks: { email: "null-out", phone: "full-redact" }, rewrite: true }), ENV), {
      bundleVersion: 4,
    });
    expect(handle.registry.get("main").engine).toBe(v3.engine);
  });

  test("a masked database without its DSN variable builds, and refuses in either masking mode, naming the variable", async () => {
    const executor = new MockExecutor();
    handle = build(executor);
    await handle.replacePolicy(
      resolve(
        yaml(
          { masks: { email: "full-redact" } },
          { name: "analytics", env: ANALYTICS_ENV, masks: { email: "full-redact" }, rewrite: true },
        ),
        {}, // neither variable set
      ),
      { bundleVersion: 1 },
    );
    expect(handle.policySnapshot().map((d) => d.status)).toEqual(["unconfigured", "unconfigured"]);

    for (const [db, env] of [
      ["main", MAIN_ENV],
      ["analytics", ANALYTICS_ENV],
    ] as const) {
      const entry = handle.registry.get(db);
      const ctx = { ...entry.ctxBase, agent_name: "t", agent_version: "1" };
      await expect(entry.engine.handle({ sql: "SELECT email FROM public.users", ctx })).rejects.toThrow(
        new RegExp(`not configured on this gateway: set ${env}`),
      );
    }
    expect(executor.calls).toHaveLength(0); // the injected executor never stands in for a missing DSN
  });
});
