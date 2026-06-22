// column_masks config parsing + the forward-compat feature guard (T3) + the
// factory wiring (salt fail-closed, masks reach the engine).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePolicyYaml } from "../src/config.ts";
import { buildEngine, type EngineHandle } from "../src/engine-factory.ts";
import type { Executor } from "@midplane/engine";

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
