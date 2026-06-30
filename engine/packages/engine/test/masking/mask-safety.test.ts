// Covert-channel mask-safety gate (ET2) — the assertions that keep source-rewrite
// from being fail-open against opaque reads.

import { beforeAll, describe, expect, test } from "bun:test";
import { warmup } from "../../src/dialects/postgres/index.ts";
import { checkMaskSafeShape, shadowScan } from "../../src/dialects/postgres/mask-safety.ts";
import type { TxClient } from "../../src/executor.ts";

beforeAll(async () => {
  await warmup();
});

describe("checkMaskSafeShape — allows analytics builtins", () => {
  test("aggregates + arithmetic + comparison pass, and report the names used", () => {
    const r = checkMaskSafeShape(
      "SELECT count(*), sum(age), avg(price) FROM customers WHERE age + 1 > 5 GROUP BY country",
    );
    expect(r.ok).toBe(true);
    expect((r as { allowlistedFns: string[] }).allowlistedFns.sort()).toEqual(["avg", "count", "sum"]);
  });

  test("a query with no functions or operators passes", () => {
    expect(checkMaskSafeShape("SELECT credit_card FROM customers").ok).toBe(true);
  });
});

describe("checkMaskSafeShape — denies the covert-read channels (deny-by-default)", () => {
  const denied: [string, string][] = [
    ["query_to_xml (executes an opaque SQL string)", "SELECT query_to_xml('SELECT cc FROM customers', true, false, '')"],
    ["pg_catalog-qualified reflective fn", "SELECT pg_catalog.query_to_xml('x', true, false, '')"],
    ["dblink (reads another database)", "SELECT * FROM dblink('host=x', 'SELECT cc FROM customers') AS t(cc text)"],
    ["schema-qualified UDF", "SELECT public.exfil(credit_card) FROM customers"],
    ["to_jsonb whole-row serialization", "SELECT to_jsonb(c) FROM customers c"],
    ["current_setting (would read the mask-salt GUC)", "SELECT current_setting('midplane.mask_salt')"],
    ["off-allowlist scalar fn", "SELECT pg_read_file('/etc/passwd')"],
  ];
  for (const [label, sql] of denied) {
    test(`denies ${label}`, () => {
      const r = checkMaskSafeShape(sql);
      expect(r.ok).toBe(false);
    });
  }

  test("a schema-qualified operator is denied", () => {
    const r = checkMaskSafeShape("SELECT 1 OPERATOR(public.=) 1");
    expect(r.ok).toBe(false);
  });
});

describe("shadowScan — catches a builtin shadowed by a user-schema UDF", () => {
  function fakeTx(rows: Record<string, unknown>[]) {
    let queried: { sql: string; params: unknown[] } | null = null;
    const tx: TxClient = {
      query: async (sql, params = []) => {
        queried = { sql, params };
        return rows;
      },
      exec: async () => ({ rows: [], rowCount: 0 }),
    };
    return { tx, getQueried: () => queried };
  }

  test("no names → no round-trip", async () => {
    const { tx, getQueried } = fakeTx([]);
    expect(await shadowScan(tx, [])).toEqual({ ok: true });
    expect(getQueried()).toBeNull();
  });

  test("allowlisted name with no user-schema definition → ok", async () => {
    const { tx } = fakeTx([]);
    expect(await shadowScan(tx, ["sum"])).toEqual({ ok: true });
  });

  test("public.sum shadowing the builtin → reject (Codex #5)", async () => {
    const { tx } = fakeTx([{ schema: "public", name: "sum" }]);
    const r = await shadowScan(tx, ["sum"]);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("shadowed");
  });
});
