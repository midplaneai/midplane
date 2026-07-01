// column_masks config parsing + the forward-compat feature guard (T3) + the
// factory wiring (salt fail-closed, masks reach the engine).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePolicyYaml } from "../src/config.ts";
import { buildEngine, type EngineHandle } from "../src/engine-factory.ts";
import { warmup } from "@midplane/engine";
import type { Executor, ExecutionResult, TxClient } from "@midplane/engine";

describe("config: column_masks parsing", () => {
  test("legacy shape resolves column_masks onto the default DB spec", () => {
    const p = parsePolicyYaml(
      "table_access:\n  default: read\ncolumn_masks:\n  public.users:\n    email: full-redact\n    ssn: consistent-hash\n",
      "test",
    );
    const db = p.databases[0]!;
    expect(db.hasColumnMasks).toBe(true);
    expect(db.columnMasks).toEqual({
      "public.users": { email: "full-redact", ssn: "consistent-hash" },
    });
  });

  test("omitted column_masks resolves to null + hasColumnMasks=false", () => {
    const p = parsePolicyYaml("table_access:\n  default: read\n", "test");
    expect(p.databases[0]!.columnMasks).toBeNull();
    expect(p.databases[0]!.hasColumnMasks).toBe(false);
  });

  test("multi-DB shape resolves per-entry column_masks", () => {
    const p = parsePolicyYaml(
      "databases:\n  - name: prod\n    url: postgres://x\n    column_masks:\n      public.users:\n        email: full-redact\n",
      "test",
    );
    const db = p.databases.find((d) => d.name === "prod")!;
    expect(db.columnMasks).toEqual({ "public.users": { email: "full-redact" } });
  });

  test("mask_source_rewrite resolves onto the spec (true / false / omitted)", () => {
    const on = parsePolicyYaml(
      "table_access:\n  default: read\nmask_source_rewrite: true\n",
      "test",
    );
    expect(on.databases[0]!.maskSourceRewrite).toBe(true);

    const off = parsePolicyYaml(
      "table_access:\n  default: read\nmask_source_rewrite: false\n",
      "test",
    );
    expect(off.databases[0]!.maskSourceRewrite).toBe(false);

    // Omitted ⇒ null (inherit the engine-wide env default at buildMaskingConfig).
    const absent = parsePolicyYaml("table_access:\n  default: read\n", "test");
    expect(absent.databases[0]!.maskSourceRewrite).toBeNull();
  });

  test("multi-DB shape resolves per-entry mask_source_rewrite", () => {
    const p = parsePolicyYaml(
      "databases:\n  - name: prod\n    url: postgres://x\n    mask_source_rewrite: true\n  - name: analytics\n    url: postgres://y\n",
      "test",
    );
    expect(p.databases.find((d) => d.name === "prod")!.maskSourceRewrite).toBe(true);
    // Sibling DB with no key inherits (null), so a canary on one DB never flips the other.
    expect(p.databases.find((d) => d.name === "analytics")!.maskSourceRewrite).toBeNull();
  });

  test("requires_features: [mask_source_rewrite] is accepted (this engine supports it)", () => {
    expect(() =>
      parsePolicyYaml(
        "requires_features:\n  - mask_source_rewrite\ntable_access:\n  default: read\n",
        "test",
      ),
    ).not.toThrow();
  });

  test("parses the parametric object forms (partial + generalize)", () => {
    const p = parsePolicyYaml(
      [
        "column_masks:",
        "  public.users:",
        "    ssn:",
        "      t: partial",
        "      keepEnd: 4",
        "    dob:",
        "      t: generalize",
        "      granularity: year",
        "    salary:",
        "      t: generalize",
        "      granularity: 1000",
        "",
      ].join("\n"),
      "test",
    );
    expect(p.databases[0]!.columnMasks).toEqual({
      "public.users": {
        ssn: { t: "partial", keepEnd: 4 },
        dob: { t: "generalize", granularity: "year" },
        salary: { t: "generalize", granularity: 1000 },
      },
    });
  });

  test("parses the spike object forms (pseudonymize + noise)", () => {
    const p = parsePolicyYaml(
      [
        "column_masks:",
        "  public.people:",
        "    email:",
        "      t: pseudonymize",
        "      kind: email",
        "    salary:",
        "      t: noise",
        "      ratio: 0.1",
        "",
      ].join("\n"),
      "test",
    );
    expect(p.databases[0]!.columnMasks).toEqual({
      "public.people": {
        email: { t: "pseudonymize", kind: "email" },
        salary: { t: "noise", ratio: 0.1 },
      },
    });
  });

  test("an unknown transform kind is rejected at parse (engine-sourced union)", () => {
    expect(() =>
      parsePolicyYaml(
        "column_masks:\n  public.users:\n    email: format-preserving-fake\n",
        "test",
      ),
    ).toThrow();
  });

  test("an unknown pseudonymize kind is rejected at parse (no engine dictionary)", () => {
    // The kind enum is the engine's PSEUDONYMIZE_KINDS — a kind with no shipped
    // dictionary fails closed at BOOT, never reaching the result-set masker.
    expect(() =>
      parsePolicyYaml(
        "column_masks:\n  public.users:\n    city:\n      t: pseudonymize\n      kind: city\n",
        "test",
      ),
    ).toThrow();
  });

  test("a noise ratio outside (0, 1] is rejected at parse", () => {
    expect(() =>
      parsePolicyYaml(
        "column_masks:\n  public.people:\n    salary:\n      t: noise\n      ratio: 1.5\n",
        "test",
      ),
    ).toThrow();
    expect(() =>
      parsePolicyYaml(
        "column_masks:\n  public.people:\n    salary:\n      t: noise\n      ratio: 0\n",
        "test",
      ),
    ).toThrow();
  });

  test("the retired keep-last-4 name is rejected at parse (absorbed by partial)", () => {
    expect(() =>
      parsePolicyYaml(
        "column_masks:\n  public.users:\n    ssn: keep-last-4\n",
        "test",
      ),
    ).toThrow();
  });
});

describe("config: requires_features forward-guard (T3)", () => {
  test("an unsupported required feature refuses the policy", () => {
    expect(() =>
      parsePolicyYaml("requires_features:\n  - row_masks\n", "test"),
    ).toThrow(/does not support/);
  });

  test("requires_features: [column_masks] is accepted (this engine supports it)", () => {
    const p = parsePolicyYaml(
      "requires_features:\n  - column_masks\ntable_access:\n  default: read\n",
      "test",
    );
    expect(p.databases[0]!.hasColumnMasks).toBe(false);
  });
});

describe("engine-factory: masking wiring", () => {
  let dir: string;
  let policyPath: string;
  let handle: EngineHandle | null;

  // Stub executor that can run catalog queries (so buildMaskingConfig wires
  // the resolver) without a real Postgres.
  const stubExecutor: Executor & { query: () => Promise<Record<string, unknown>[]> } = {
    execute: async () => ({ rows: [], rowCount: 0, fields: [] }),
    query: async () => [],
  };

  const COLUMN_MASKS_YAML =
    "table_access:\n  default: read\ncolumn_masks:\n  public.users:\n    email: full-redact\n";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "midplane-mask-cfg-"));
    policyPath = join(dir, "policy.yaml");
    handle = null;
  });
  afterEach(async () => {
    if (handle) await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function boot(yaml: string, maskSalt?: string): EngineHandle {
    writeFileSync(policyPath, yaml);
    return buildEngine(
      {
        databaseUrl: "postgres://stub",
        port: 0,
        dbPath: join(dir, "audit.db"),
        tenantId: "__self_host__",
        policyFile: policyPath,
        transport: "http",
        maskSalt,
      },
      { executor: stubExecutor, credentials: { resolve: async () => "postgres://stub" } },
    );
  }

  test("declared column_masks WITHOUT a salt refuses to boot (fail-closed)", () => {
    expect(() => boot(COLUMN_MASKS_YAML, undefined)).toThrow(/MIDPLANE_MASK_SALT/);
  });

  test("declared column_masks WITH a salt boots a registry", () => {
    handle = boot(COLUMN_MASKS_YAML, "a-secret-salt");
    expect(handle.registry.names()).toContain("__default__");
  });

  test("no column_masks boots without needing a salt", () => {
    handle = boot("table_access:\n  default: read\n", undefined);
    expect(handle.registry.names()).toContain("__default__");
  });
});

// A1: the MIDPLANE_MASK_SOURCE_REWRITE env default + per-DB `mask_source_rewrite:`
// YAML override must reach MaskingConfig.sourceRewrite.enabled. We assert the WIRING
// end-to-end through the factory: flag ON ⇒ handle() executes the REWRITTEN (wrapped)
// SQL on the transaction-scoped client; flag OFF ⇒ the plain execute() + retained
// post-exec masker runs (byte-identical to today). Value-level masking is proven by
// the rewriter unit tests + the live-PG harness — here we only prove the flag flows.
describe("engine-factory: source-rewrite flag wiring (A1)", () => {
  beforeAll(async () => {
    await warmup();
  });

  // Executor that supports BOTH paths: withTransaction (rewrite) answers the catalog
  // queries for `users` and records the executed (rewritten) SQL; execute() records
  // plain fallback calls. Mirrors the engine test's RewriteMockExecutor.
  class DualPathExecutor implements Executor {
    executed: string[] = [];
    plainCalls: string[] = [];
    result: ExecutionResult = { rows: [], rowCount: 0, fields: [] };

    async execute(sql: string): Promise<ExecutionResult> {
      this.plainCalls.push(sql);
      return this.result;
    }
    async query(): Promise<Record<string, unknown>[]> {
      return []; // by-OID resolver (post-exec masker path) — no masked columns in result
    }
    async withTransaction<T>(_ctx: unknown, fn: (tx: TxClient) => Promise<T>): Promise<T> {
      const self = this;
      const tx: TxClient = {
        async query(sql, params = []) {
          if (sql.includes("set_config")) return [{ v: params[1] }];
          if (sql.includes("(n.nspname, c.relname) IN"))
            return [{ oid: 100, relname: "users", relkind: "r", schema: "public" }];
          if (sql.includes("FROM pg_inherits")) return [];
          if (sql.includes("c.oid = ANY($1::oid[])") && sql.includes("relname"))
            return [{ oid: 100, relname: "users", schema: "public" }];
          if (sql.includes("pg_attribute"))
            return [
              { oid: 100, attname: "id", typcategory: "N" },
              { oid: 100, attname: "email", typcategory: "S" },
            ];
          return []; // pg_proc / pg_operator shadow scan
        },
        async exec(sql) {
          self.executed.push(sql);
          return self.result;
        },
      };
      return fn(tx);
    }
  }

  let dir: string;
  let policyPath: string;
  let handle: EngineHandle | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "midplane-sr-cfg-"));
    policyPath = join(dir, "policy.yaml");
    handle = null;
  });
  afterEach(async () => {
    if (handle) await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Boot the factory with our dual-path executor and the given env default +
  // policy YAML, then drive one masked SELECT through the built engine.
  async function run(
    yaml: string,
    envDefault: boolean,
  ): Promise<{ executor: DualPathExecutor; allowed: boolean }> {
    writeFileSync(policyPath, yaml);
    const executor = new DualPathExecutor();
    handle = buildEngine(
      {
        databaseUrl: "postgres://stub",
        port: 0,
        dbPath: join(dir, "audit.db"),
        tenantId: "__self_host__",
        policyFile: policyPath,
        transport: "http",
        maskSalt: "a-secret-salt",
        maskSourceRewrite: envDefault,
      },
      { executor, credentials: { resolve: async () => "postgres://stub" } },
    );
    const entry = handle.registry.get("__default__");
    const d = await entry.engine.handle({ sql: "SELECT email FROM users", ctx: entry.ctxBase });
    return { executor, allowed: d.allowed };
  }

  const MASKS_YAML = "table_access:\n  default: read\ncolumn_masks:\n  public.users:\n    email: full-redact\n";

  test("env default ON ⇒ the REWRITTEN (wrapped) sql executes, plain execute() is never called", async () => {
    const { executor, allowed } = await run(MASKS_YAML, true);
    expect(allowed).toBe(true);
    expect(executor.plainCalls).toHaveLength(0);
    expect(executor.executed).toHaveLength(1);
    expect(executor.executed[0]).toContain("'***'::text AS \"email\"");
    expect(executor.executed[0]).toContain("FROM (SELECT");
  });

  test("env default OFF ⇒ the ORIGINAL sql runs plain (post-exec masker fallback), no rewrite", async () => {
    const { executor, allowed } = await run(MASKS_YAML, false);
    expect(allowed).toBe(true);
    expect(executor.executed).toHaveLength(0);
    expect(executor.plainCalls).toEqual(["SELECT email FROM users"]);
  });

  test("per-DB `mask_source_rewrite: true` overrides an OFF env default (canary a single DB)", async () => {
    const yaml = MASKS_YAML + "mask_source_rewrite: true\n";
    const { executor } = await run(yaml, false);
    expect(executor.plainCalls).toHaveLength(0);
    expect(executor.executed).toHaveLength(1);
  });

  test("per-DB `mask_source_rewrite: false` overrides an ON env default (opt one DB back out)", async () => {
    const yaml = MASKS_YAML + "mask_source_rewrite: false\n";
    const { executor } = await run(yaml, true);
    expect(executor.executed).toHaveLength(0);
    expect(executor.plainCalls).toEqual(["SELECT email FROM users"]);
  });
});
