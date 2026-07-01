// Live-Postgres equivalence harness for the source-rewrite path (ET7).
//
// Runs the REAL engine code (postgresSourceRewriter + buildCatalogByName +
// transformToSql + the salt GUC) against a real Postgres and proves the rewritten
// query is semantically equivalent to the original except that masked columns carry
// their mask — the property the Phase-0 spike proved on prototype code, now pinned
// on the shipped rewriter. Also pins the ET5 token alignment: the JS consistent-hash
// (applyTransform) equals the in-DB md5(salt||col::text).
//
// Gated on MASKING_LIVE_PG_DSN so normal CI (no database) skips it. Run with:
//   MASKING_LIVE_PG_DSN=postgres://postgres@127.0.0.1:55432/probe \
//     bun test packages/engine/test/masking/source-rewrite.live.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pg from "pg";
import { warmup } from "../../src/dialects/postgres/index.ts";
import { postgresSourceRewriter as RW } from "../../src/dialects/postgres/source-rewrite.ts";
import { buildCatalogByName, type CatalogQueryFn } from "../../src/masking/catalog.ts";
import { MASK_SALT_GUC } from "../../src/masking/source-rewrite.ts";
import { applyTransform } from "../../src/masking/transforms.ts";
import type { ColumnMasks, MaskRule } from "../../src/masking/mask-result-set.ts";
import type { TxClient } from "../../src/executor.ts";

const DSN = process.env.MASKING_LIVE_PG_DSN;
const d = DSN ? describe : describe.skip;
const SALT = "LIVESALT";

const MASKS: ColumnMasks = new Map([
  [
    "public.customers",
    new Map<string, MaskRule>([
      ["credit_card", "full-redact"],
      ["email", "consistent-hash"],
    ]),
  ],
]);

const SCHEMA = `
DROP TABLE IF EXISTS customers, products, orders CASCADE;
CREATE TABLE customers (id int primary key, name text, age int, country text, credit_card text, email text);
CREATE TABLE products (id int primary key, price_cents int);
CREATE TABLE orders (id int primary key, cid int, amount int);
INSERT INTO customers VALUES
  (1,'Alice',30,'DE','4111111111111111','alice@acme.io'),
  (2,'Bob',25,'US','4222222222222222','bob@acme.io'),
  (3,'Carol',40,'DE','4333333333333333','carol@acme.io');
INSERT INTO products VALUES (100,999),(101,1500);
INSERT INTO orders VALUES (10,1,100),(11,1,200),(12,2,50);
`;

d("source-rewrite live equivalence", () => {
  let client: pg.Client;
  let queryFn: CatalogQueryFn;

  beforeAll(async () => {
    await warmup();
    client = new pg.Client({ connectionString: DSN });
    await client.connect();
    await client.query(SCHEMA);
    queryFn = async (s, p) => (await client.query(s, p)).rows as Record<string, unknown>[];
  });
  afterAll(async () => {
    await client?.query("DROP TABLE IF EXISTS customers, products, orders CASCADE").catch(() => {});
    await client?.end();
  });

  async function rewritten(sql: string): Promise<Record<string, unknown>[]> {
    const refs = RW.collectRefs(sql);
    const catalog = await buildCatalogByName(queryFn, refs);
    const out = RW.rewrite(sql, MASKS, catalog);
    if (!out.ok) throw new Error(`rewrite rejected: ${out.reason}`);
    await client.query("BEGIN");
    await client.query("SELECT set_config($1, $2, true)", [MASK_SALT_GUC, SALT]);
    try {
      const r = await client.query(out.sql);
      return r.rows as Record<string, unknown>[];
    } finally {
      await client.query("COMMIT");
    }
  }
  const raw = async (sql: string) => (await client.query(sql)).rows as Record<string, unknown>[];

  test("count over an UNMASKED table is untouched (the ISSUE-007 regression)", async () => {
    expect(await rewritten("SELECT count(*)::int AS c FROM products")).toEqual(await raw("SELECT count(*)::int AS c FROM products"));
  });

  test("aggregate over a masked table: count + avg(unmasked col) match the original", async () => {
    const q = "SELECT count(*)::int AS c, avg(age)::float8 AS a FROM customers WHERE country='DE'";
    expect(await rewritten(q)).toEqual(await raw(q));
  });

  test("full-redact: masked column is '***', other columns unchanged, no raw card leaks", async () => {
    const rows = await rewritten("SELECT id, name, credit_card FROM customers ORDER BY id");
    expect(rows.map((r) => r.credit_card)).toEqual(["***", "***", "***"]);
    expect(rows.map((r) => r.name)).toEqual(["Alice", "Bob", "Carol"]);
    expect(JSON.stringify(rows)).not.toContain("4111111111111111");
  });

  test("consistent-hash token parity: in-DB md5 == JS applyTransform (ET5 alignment)", async () => {
    const rows = await rewritten("SELECT id, email FROM customers ORDER BY id");
    for (const r of rows) {
      const original = ["", "alice@acme.io", "bob@acme.io", "carol@acme.io"][r.id as number];
      const jsToken = applyTransform("consistent-hash", original, { salt: SALT });
      expect(r.email).toBe(jsToken); // same token both paths → fallback flag is token-stable
      expect(r.email).not.toBe(original); // never the raw value
    }
  });

  test("WHERE / JOIN / GROUP BY on a masked column operate on the masked value (inference closed)", async () => {
    // filtering on the RAW card returns nothing (the wrap masked it first).
    const rows = await rewritten("SELECT count(*)::int AS c FROM customers WHERE credit_card = '4111111111111111'");
    expect(rows[0]!.c).toBe(0);
  });

  test("RETURNING a masked column: the write stores the RAW value, RETURNING returns it MASKED (B4)", async () => {
    // read-side masking: the raw card lands in the table; the RETURNING projection is masked.
    const returned = await rewritten(
      "INSERT INTO customers (id, credit_card) VALUES (90, '4900000000000000') RETURNING id, credit_card",
    );
    expect(returned).toEqual([{ id: 90, credit_card: "***" }]);
    const stored = await raw("SELECT credit_card FROM customers WHERE id=90");
    expect(stored).toEqual([{ credit_card: "4900000000000000" }]); // stored raw (write is not masked)
    await client.query("DELETE FROM customers WHERE id=90");
  });

  test("RETURNING *: masked columns come back masked, others real (B4)", async () => {
    const returned = await rewritten(
      "INSERT INTO customers (id, name, credit_card, email) VALUES (91, 'Zed', '4911111111111111', 'zed@acme.io') RETURNING *",
    );
    const row = returned[0]!;
    expect(row.name).toBe("Zed"); // unmasked column: real
    expect(row.credit_card).toBe("***"); // full-redact
    expect(row.email).not.toBe("zed@acme.io"); // consistent-hash token, not the raw email
    expect(row.email).toBe(applyTransform("consistent-hash", "zed@acme.io", { salt: SALT }));
    expect(JSON.stringify(returned)).not.toContain("4911111111111111");
    await client.query("DELETE FROM customers WHERE id=91");
  });

  test("RETURNING a computed expression over a masked column → rejected (fail-closed, B4)", async () => {
    await expect(
      rewritten("UPDATE customers SET name=name WHERE id=1 RETURNING credit_card || 'x'"),
    ).rejects.toThrow(/computed expression/);
  });

  test("json_build_object over a masked column serializes the MASKED value (B6)", async () => {
    // The wrap masks credit_card before json_build_object sees it — the argument, not
    // a whole-row composite, so no raw value reaches the serializer.
    const rows = await rewritten("SELECT json_build_object('id', id, 'cc', credit_card) AS j FROM customers WHERE id=1");
    expect(rows).toEqual([{ j: { id: 1, cc: "***" } }]);
    expect(JSON.stringify(rows)).not.toContain("4111111111111111");
  });

  test("operator shadow scan rejects a user-schema operator that redefines a builtin (Codex High)", async () => {
    // The exact PoC: a public.|| whose body reads the mask salt. The pg_operator scan
    // must reject it — a spelling-only allowlist would have passed it.
    await client.query(`
      CREATE OR REPLACE FUNCTION public.leak_concat(text, text) RETURNS text LANGUAGE sql STABLE
        AS $$ SELECT current_setting('midplane.mask_salt', true) $$;
      DROP OPERATOR IF EXISTS public.|| (text, text);
      CREATE OPERATOR public.|| (LEFTARG = text, RIGHTARG = text, PROCEDURE = public.leak_concat);
    `);
    const tx: TxClient = {
      query: async (s, p = []) => (await client.query(s, p)).rows as Record<string, unknown>[],
      exec: async () => ({ rows: [], rowCount: 0 }),
    };
    const r = await RW.shadowScan(tx, { functions: [], operators: ["||"] });
    await client.query(`DROP OPERATOR IF EXISTS public.|| (text, text); DROP FUNCTION IF EXISTS public.leak_concat(text, text)`);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain("operator");
  });
});
