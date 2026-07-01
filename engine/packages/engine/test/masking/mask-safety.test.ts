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

  test("expanded analytics functions pass (math / string / date / stat / window)", () => {
    const q =
      "SELECT round(avg(salary), 2), stddev(salary), corr(x, y), upper(name), " +
      "regexp_replace(name, 'a', 'b'), string_agg(name, ','), date_bin('1 hour', ts, ts), " +
      "rank() OVER (ORDER BY salary), ntile(4) OVER (ORDER BY salary) FROM customers";
    expect(checkMaskSafeShape(q).ok).toBe(true);
  });

  test("regex + bitwise operators pass", () => {
    expect(checkMaskSafeShape("SELECT name FROM customers WHERE name ~ '^A' AND (flags & 1) = 1").ok).toBe(true);
  });

  test("json CONSTRUCTION from explicit scalar args passes (B6) — the arg is masked by the wrap", () => {
    // json_build_object/_array have no whole-row overload; a masked-column arg is
    // already masked before serialization (verified live: {"cc":"***"}).
    const r = checkMaskSafeShape(
      "SELECT json_build_object('id', id, 'cc', credit_card), jsonb_build_array(name, age) FROM customers",
    );
    expect(r.ok).toBe(true);
    expect((r as { allowlistedFns: string[] }).allowlistedFns.sort()).toEqual([
      "json_build_object",
      "jsonb_build_array",
    ]);
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
    ["nextval — dereferences a sequence", "SELECT nextval('s')"],
    ["pg_relation_size — reads the named object", "SELECT pg_relation_size('customers')"],
    ["pg_sleep — DoS", "SELECT pg_sleep(10)"],
    ["generate_series — set-returning", "SELECT generate_series(1, 100)"],
    ["json_agg — whole-row/json serialization", "SELECT json_agg(c) FROM customers c"],
    ["row_to_json — whole-row serialization (composite-capable)", "SELECT row_to_json(c) FROM customers c"],
    ["json_populate_record — rowtype/table-name deref (bypasses the wrap)", "SELECT json_populate_record(null::customers, '{}')"],
    ["jsonb_to_record — untyped record from json", "SELECT * FROM jsonb_to_record('{}') AS x(a int)"],
    ["lo_get — large object", "SELECT lo_get(1)"],
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
    expect(await shadowScan(tx, { functions: [], operators: [] })).toEqual({ ok: true });
    expect(getQueried()).toBeNull();
  });

  test("allowlisted name with no user-schema definition → ok", async () => {
    const { tx } = fakeTx([]);
    expect(await shadowScan(tx, { functions: ["sum"], operators: [] })).toEqual({ ok: true });
  });

  test("public.sum shadowing the builtin FUNCTION → reject (Codex #5)", async () => {
    const { tx } = fakeTx([{ schema: "public", name: "sum" }]);
    const r = await shadowScan(tx, { functions: ["sum"], operators: [] });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("shadowed");
  });

  test("public.|| shadowing a builtin OPERATOR → reject (Codex allowlist review, High)", async () => {
    // a user operator whose body calls current_setting/query_to_xml would bypass the
    // spelling-only allowlist; the pg_operator scan catches it.
    const { tx } = fakeTx([{ schema: "public", name: "||" }]);
    const r = await shadowScan(tx, { functions: [], operators: ["||"] });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("operator");
  });
});
