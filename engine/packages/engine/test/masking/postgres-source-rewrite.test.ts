// Postgres SourceRewriter (span-splice) + transformToSql — unit tests, no live DB.
// Catalog is hand-built so we exercise the rewrite/quoting/reject logic in isolation;
// the live-PG semantic-equivalence run is the Phase-1 harness (the spike proved it).

import { beforeAll, describe, expect, test } from "bun:test";
import { parseSync } from "libpg-query";
import { warmup } from "../../src/dialects/postgres/index.ts";
import { postgresSourceRewriter as RW } from "../../src/dialects/postgres/source-rewrite.ts";
import { transformToSql, quoteLiteral } from "../../src/dialects/postgres/transform-sql.ts";
import type { ByNameCatalog } from "../../src/masking/catalog.ts";
import type { ColumnMasks } from "../../src/masking/mask-result-set.ts";

beforeAll(async () => {
  await warmup();
});

const reparses = (sql: string): boolean => {
  try {
    parseSync(sql);
    return true;
  } catch {
    return false;
  }
};

describe("transformToSql", () => {
  test("null-out is type-preserving (untyped NULL)", () => {
    expect(transformToSql("null-out", '"x"', "N")).toEqual({ ok: true, sql: "NULL" });
  });
  test("full-redact: text only", () => {
    expect(transformToSql("full-redact", '"x"', "S")).toEqual({ ok: true, sql: "'***'::text" });
    expect(transformToSql("full-redact", '"x"', "N").ok).toBe(false);
  });
  test("consistent-hash: md5 over the salt GUC, text only", () => {
    const r = transformToSql("consistent-hash", '"cc"', "S");
    expect(r.ok).toBe(true);
    expect((r as { sql: string }).sql).toContain("md5(current_setting('midplane.mask_salt') || \"cc\"::text)");
    expect(transformToSql("consistent-hash", '"cc"', "N").ok).toBe(false);
  });
  test("partial: CASE guard, text only; glyph is escaped", () => {
    const r = transformToSql({ t: "partial", keepStart: 0, keepEnd: 4, glyph: "'" }, '"cc"', "S");
    expect(r.ok).toBe(true);
    // a glyph containing a quote must be doubled, never break out of the literal
    expect((r as { sql: string }).sql).toContain("repeat('''',");
    expect(transformToSql({ t: "partial", keepEnd: 4 }, '"n"', "N").ok).toBe(false);
  });
  test("generalize: date_trunc on D, floor-bucket on N, domain-checked", () => {
    expect(transformToSql({ t: "generalize", granularity: "month" }, '"d"', "D")).toEqual({
      ok: true,
      sql: "date_trunc('month', \"d\")",
    });
    expect(transformToSql({ t: "generalize", granularity: 1000 }, '"sal"', "N")).toEqual({
      ok: true,
      sql: '(floor("sal" / 1000) * 1000)',
    });
    expect(transformToSql({ t: "generalize", granularity: "year" }, '"n"', "N").ok).toBe(false);
  });
  test("noise: numeric only", () => {
    expect(transformToSql({ t: "noise", ratio: 0.1 }, '"sal"', "N").ok).toBe(true);
    expect(transformToSql({ t: "noise", ratio: 0.1 }, '"s"', "S").ok).toBe(false);
  });
  test("pseudonymize is projection-only → rejected for rewrite", () => {
    expect(transformToSql({ t: "pseudonymize", kind: "email" }, '"e"', "S").ok).toBe(false);
  });
  test("quoteLiteral doubles embedded quotes", () => {
    expect(quoteLiteral("a'b")).toBe("'a''b'");
  });
});

// ── rewriter ──────────────────────────────────────────────────────────────────
const catalog: ByNameCatalog = new Map([
  [
    "public.customers",
    {
      oid: 1,
      schema: "public",
      relname: "customers",
      relkind: "r",
      parentKey: "public.customers",
      columns: ["id", "name", "credit_card"],
      columnTypes: new Map([["id", "N"], ["name", "S"], ["credit_card", "S"]]),
    },
  ],
  [
    "public.products",
    {
      oid: 2,
      schema: "public",
      relname: "products",
      relkind: "r",
      parentKey: "public.products",
      columns: ["id", "price_cents"],
      columnTypes: new Map([["id", "N"], ["price_cents", "N"]]),
    },
  ],
  [
    "public.cust_view",
    {
      oid: 3,
      schema: "public",
      relname: "cust_view",
      relkind: "v",
      parentKey: "public.cust_view",
      columns: ["id", "credit_card"],
      columnTypes: new Map([["credit_card", "S"]]),
    },
  ],
]);
const masks: ColumnMasks = new Map([
  ["public.customers", new Map([["credit_card", "full-redact" as const]])],
  ["public.cust_view", new Map([["credit_card", "full-redact" as const]])],
]);

describe("postgresSourceRewriter.collectRefs", () => {
  test("returns every relation reference", () => {
    const refs = RW.collectRefs("SELECT * FROM customers c JOIN orders o ON o.cid=c.id");
    expect(refs).toContainEqual({ schema: null, relname: "customers" });
    expect(refs).toContainEqual({ schema: null, relname: "orders" });
  });

  test("includes the write TARGET (inline relation, missed by the RangeVar walk)", () => {
    // Without this a write to a masked table can't be resolved by name and rejects as
    // "could not resolve" once the flag is on (the target isn't a {RangeVar:…} node).
    expect(RW.collectRefs("UPDATE customers SET name='x' WHERE id=1")).toContainEqual({
      schema: null,
      relname: "customers",
    });
    // read-position tables inside a write are also surfaced, alongside the target.
    const refs = RW.collectRefs("UPDATE customers SET name='x' FROM orders WHERE orders.cid=customers.id");
    expect(refs).toContainEqual({ schema: null, relname: "customers" });
    expect(refs).toContainEqual({ schema: null, relname: "orders" });
  });
});

describe("postgresSourceRewriter.rewrite", () => {
  test("wraps a masked table; output reparses and masks the column", () => {
    const out = RW.rewrite("SELECT credit_card FROM customers", masks, catalog);
    expect(out.ok).toBe(true);
    const sql = (out as { sql: string }).sql;
    expect(reparses(sql)).toBe(true);
    expect(sql).toContain("'***'::text AS \"credit_card\"");
    expect(sql).toContain("FROM (SELECT");
  });

  test("keeps the user's clause text verbatim (minimal blast radius)", () => {
    const out = RW.rewrite("SELECT count(*) FROM customers c WHERE c.id=1", masks, catalog);
    expect(out.ok).toBe(true);
    expect((out as { sql: string }).sql).toContain("WHERE c.id=1"); // untouched, byte-for-byte
  });

  test("unmasked table → returned byte-for-byte unchanged", () => {
    const q = "SELECT count(*) FROM products";
    expect(RW.rewrite(q, masks, catalog)).toEqual({ ok: true, sql: q, maskedColumns: [] });
  });

  test("masked view → fail closed", () => {
    const out = RW.rewrite("SELECT credit_card FROM cust_view", masks, catalog);
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toContain("view");
  });

  test("schema-qualified column ref on a wrapped table → fail closed (Codex #5a)", () => {
    const out = RW.rewrite("SELECT public.customers.credit_card FROM public.customers", masks, catalog);
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toContain("schema-qualified");
  });

  test("masked table absent from catalog (stale) → fail closed, retryable phrasing", () => {
    const out = RW.rewrite("SELECT credit_card FROM customers", masks, new Map());
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toContain("re-scan");
  });

  test("self-join of a masked table wraps both references", () => {
    const out = RW.rewrite(
      "SELECT a.credit_card, b.name FROM customers a JOIN customers b ON a.id=b.id",
      masks,
      catalog,
    );
    expect(out.ok).toBe(true);
    const sql = (out as { sql: string }).sql;
    expect(reparses(sql)).toBe(true);
    // both references wrapped → the masked projection appears twice (one per wrap)
    expect(sql.match(/'\*\*\*'::text/g)?.length).toBe(2);
  });
});

describe("postgresSourceRewriter.rewrite — write path", () => {
  test("UPDATE with a WHERE on a masked column → fail closed (inference hole)", () => {
    const out = RW.rewrite("UPDATE customers SET name='x' WHERE credit_card='4111'", masks, catalog);
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toContain("WHERE");
  });

  test("DELETE with a WHERE on a masked column → fail closed", () => {
    const out = RW.rewrite("DELETE FROM customers WHERE credit_card='4111'", masks, catalog);
    expect(out.ok).toBe(false);
  });

  test("write target is NOT wrapped — a plain write to a masked table passes verbatim (no invalid SQL)", () => {
    const q = "UPDATE customers SET name='x' WHERE id=1";
    expect(RW.rewrite(q, masks, catalog)).toEqual({ ok: true, sql: q, maskedColumns: [] });
  });

  test("INSERT without masked-col refs → verbatim (target not wrapped)", () => {
    const q = "INSERT INTO customers (name) VALUES ('x')";
    expect(RW.rewrite(q, masks, catalog)).toEqual({ ok: true, sql: q, maskedColumns: [] });
  });
});

describe("postgresSourceRewriter.rewrite — system columns", () => {
  test("system column on a wrapped table → fail closed", () => {
    const out = RW.rewrite("SELECT ctid FROM customers", masks, catalog);
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toContain("system column");
  });

  test("qualified system column on a wrapped table → fail closed", () => {
    const out = RW.rewrite("SELECT customers.tableoid FROM customers", masks, catalog);
    expect(out.ok).toBe(false);
  });

  test("system column on an UNmasked table → verbatim (no wrap, no reject)", () => {
    const q = "SELECT ctid FROM products";
    expect(RW.rewrite(q, masks, catalog)).toEqual({ ok: true, sql: q, maskedColumns: [] });
  });
});

describe("postgresSourceRewriter.rewrite — RETURNING masking (B4)", () => {
  test("RETURNING a masked column → masks it in place, output name preserved", () => {
    const out = RW.rewrite("INSERT INTO customers (name) VALUES ('x') RETURNING credit_card", masks, catalog);
    expect(out.ok).toBe(true);
    const sql = (out as { sql: string }).sql;
    expect(reparses(sql)).toBe(true);
    expect(sql).toContain("'***'::text AS \"credit_card\""); // name kept, not `md5`/expr default
    expect(sql).toContain("VALUES ('x')"); // rest of the write is verbatim
    expect((out as { maskedColumns: string[] }).maskedColumns).toEqual(["public.customers.credit_card"]);
  });

  test("RETURNING masked col AS alias → masks, explicit alias kept verbatim", () => {
    const out = RW.rewrite("UPDATE customers SET name='x' WHERE id=1 RETURNING credit_card AS cc", masks, catalog);
    expect(out.ok).toBe(true);
    const sql = (out as { sql: string }).sql;
    expect(reparses(sql)).toBe(true);
    expect(sql).toContain("'***'::text AS cc"); // explicit alias, not re-aliased to credit_card
  });

  test("RETURNING mixed masked + unmasked → only the masked column is rewritten", () => {
    const out = RW.rewrite("INSERT INTO customers (name) VALUES ('x') RETURNING id, credit_card, name", masks, catalog);
    expect(out.ok).toBe(true);
    const sql = (out as { sql: string }).sql;
    expect(reparses(sql)).toBe(true);
    expect(sql).toContain("RETURNING id, '***'::text AS \"credit_card\", name"); // id/name verbatim
  });

  test("RETURNING * → expands to the full masked projection", () => {
    const out = RW.rewrite("INSERT INTO customers (name) VALUES ('x') RETURNING *", masks, catalog);
    expect(out.ok).toBe(true);
    const sql = (out as { sql: string }).sql;
    expect(reparses(sql)).toBe(true);
    expect(sql).toContain('"id", "name", \'***\'::text AS "credit_card"'); // all cols, masked one wrapped
    expect((out as { maskedColumns: string[] }).maskedColumns).toEqual(["public.customers.credit_card"]);
  });

  test("RETURNING only unmasked columns → verbatim, target not wrapped", () => {
    const q = "INSERT INTO customers (name) VALUES ('x') RETURNING id, name";
    expect(RW.rewrite(q, masks, catalog)).toEqual({ ok: true, sql: q, maskedColumns: [] });
  });

  test("RETURNING a computed expression over a masked column → fail closed (v1)", () => {
    const out = RW.rewrite("DELETE FROM customers WHERE id=1 RETURNING credit_card || 'z'", masks, catalog);
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toContain("computed expression");
  });

  test("RETURNING <table>.* (qualified whole-row) → fail closed (v1)", () => {
    const out = RW.rewrite("UPDATE customers t SET name='x' WHERE id=1 RETURNING t.*", masks, catalog);
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toContain("*");
  });

  test("RETURNING whole-row composite of the target → fail closed", () => {
    const out = RW.rewrite("UPDATE customers SET name='x' WHERE id=1 RETURNING customers", masks, catalog);
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toContain("whole-row");
  });
});

describe("postgresSourceRewriter.rewrite — CTE shadowing (reviewer #2)", () => {
  test("a CTE named like a masked table → fail closed (would rewrite the CTE as the base table)", () => {
    const out = RW.rewrite("WITH customers AS (SELECT 1 AS id) SELECT * FROM customers", masks, catalog);
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toContain("CTE");
  });

  test("a non-colliding CTE reading a masked table in its body still wraps the base table", () => {
    const out = RW.rewrite("WITH recent AS (SELECT credit_card FROM customers) SELECT * FROM recent", masks, catalog);
    expect(out.ok).toBe(true);
    expect((out as { sql: string }).sql).toContain("'***'::text AS \"credit_card\"");
  });
});
