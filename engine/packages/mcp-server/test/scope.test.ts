// scopedRegistry + ceilingFor — the subset gate + read-clamp mapping.

import { describe, expect, test } from "bun:test";

import { ceilingFor, scopedRegistry, type SessionScope } from "../src/scope.ts";
import type { EngineRegistry } from "../src/engine-factory.ts";

// Minimal fake registry. get() returns a sentinel tagged with the name so we
// can assert delegation without standing up real engines.
function fakeRegistry(names: string[]): EngineRegistry {
  const describeRow = (name: string) => ({
    name,
    tenant_scope_enabled: false,
    tenant_scope_column: null,
    tenant_scope_overrides: {},
    tenant_scope_exempt: [],
    table_access_default: "read_write" as const,
    guardrails_block_unqualified_dml: true,
    guardrails_block_ddl: true,
  });
  return {
    get: (name: string) => {
      if (!names.includes(name)) throw new Error(`base: unknown ${name}`);
      return { name, sentinel: true } as never;
    },
    has: (name: string) => names.includes(name),
    names: () => [...names],
    count: () => names.length,
    audit: { sentinel: "audit" } as never,
    describe: () => names.map(describeRow),
    setPolicy: async () => ({ applied_at: "t" }),
    dryRun: async () => ({}) as never,
    close: async () => {},
  };
}

const SCOPE: SessionScope = new Map([
  ["main", "read"],
  ["analytics", "write"],
]);

describe("scopedRegistry — subset gate", () => {
  test("names()/count() expose only granted DBs, sorted", () => {
    const r = scopedRegistry(fakeRegistry(["analytics", "main", "reports"]), SCOPE);
    expect(r.names()).toEqual(["analytics", "main"]); // "reports" gated out
    expect(r.count()).toBe(2);
  });

  test("has() is true only for granted DBs", () => {
    const r = scopedRegistry(fakeRegistry(["main", "reports"]), SCOPE);
    expect(r.has("main")).toBe(true);
    expect(r.has("reports")).toBe(false);
  });

  test("get() delegates for granted DBs, throws for out-of-scope", () => {
    const r = scopedRegistry(fakeRegistry(["main", "reports"]), SCOPE);
    expect((r.get("main") as { name: string }).name).toBe("main");
    expect(() => r.get("reports")).toThrow(/Unknown database "reports"/);
  });

  test("get()'s error never leaks out-of-scope DB names", () => {
    const r = scopedRegistry(fakeRegistry(["main", "reports", "secret"]), SCOPE);
    try {
      r.get("reports");
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      // The queried name ("reports") is echoed (the caller already knows it),
      // but OTHER out-of-scope DBs must never be listed — only the scoped set is.
      expect(msg).not.toContain("secret");
      expect(msg).toContain("Configured databases: main.");
    }
  });

  test("describe() lists only granted DBs and reflects the read clamp", () => {
    const r = scopedRegistry(fakeRegistry(["main", "analytics", "reports"]), SCOPE);
    const rows = r.describe();
    expect(rows.map((d) => d.name).sort()).toEqual(["analytics", "main"]);
    const main = rows.find((d) => d.name === "main")!;
    const analytics = rows.find((d) => d.name === "analytics")!;
    // main is read-granted → read_write default clamps to read in the listing.
    expect(main.table_access_default).toBe("read");
    // analytics is write-granted → unchanged.
    expect(analytics.table_access_default).toBe("read_write");
  });
});

describe("ceilingFor", () => {
  test('"read" → "read" (clamp writes), "write" → "read_write" (no clamp)', () => {
    expect(ceilingFor("read")).toBe("read");
    expect(ceilingFor("write")).toBe("read_write");
  });
});
