// Postgres dialect — parse-level pins.
//
// These tests target behavior that is *unique* to the Postgres dialect's
// libpg_query wrapper (AST shape, PG-specific syntax, error semantics).
// They sit beside `dialects/registry.test.ts` (which pins the dialect-
// neutral seam) and form the template a future dialect would mirror under
// `dialects/<name>/parse.test.ts` with its own dialect-specific expectations.
//
// What's intentionally NOT here:
//   - Policy outcomes (those live in `adversarial/` and `policy/`).
//   - Cross-dialect contract pins (those live in `dialects/registry.test.ts`).

import { describe, expect, test } from "bun:test";
import { parse } from "../../../src/dialects/postgres/parse.ts";

describe("dialects/postgres: AST shape (libpg_query tagged-union)", () => {
  test("ok=true result carries `ast.stmts` array of `{ stmt: { TaggedKind: {...} } }`", async () => {
    const r = await parse("SELECT 1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.isArray(r.ast.stmts)).toBe(true);
    expect(r.ast.stmts.length).toBe(1);
    // Tagged-union outer shape — exactly one capitalized key whose value
    // is the inner node. Rules walk this shape; if libpg_query ever
    // changed it, every PG rule would break.
    const stmt0 = r.ast.stmts[0]!.stmt;
    const keys = Object.keys(stmt0);
    expect(keys.length).toBe(1);
    expect(keys[0]).toMatch(/^[A-Z]/);
    expect(keys[0]).toBe("SelectStmt");
  });

  test("multi-statement input populates ast.stmts with N entries", async () => {
    // `tree.stmts.length` is what the multi_statement rule counts (NOT
    // raw semicolons). Pin that the dialect actually populates this for
    // every top-level statement.
    const r = await parse("SELECT 1; SELECT 2; SELECT 3");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast.stmts.length).toBe(3);
  });

  test("DML statements expose `relation` as a bare RangeVar shape", async () => {
    // The PG visitor's `walkInner()` surfaces InsertStmt.relation as a
    // virtual RangeVar (it's a bare object, not tagged-union wrapped).
    // Pin the shape so a libpg_query bump that started tagged-wrapping it
    // surfaces here instead of breaking table_access silently.
    const r = await parse("INSERT INTO users(id) VALUES (1)");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const insert = (r.ast.stmts[0]!.stmt as Record<string, unknown>)
      .InsertStmt as Record<string, unknown>;
    expect(insert).toBeTruthy();
    const relation = insert.relation as Record<string, unknown>;
    // Bare shape — no `RangeVar:` wrapper around it.
    expect(relation.relname).toBe("users");
  });
});

describe("dialects/postgres: PG-specific syntax accepted", () => {
  test("CTE: `WITH x AS (...) SELECT * FROM x`", async () => {
    const r = await parse(
      "WITH cte AS (SELECT 1 AS n) SELECT * FROM cte",
    );
    expect(r.ok).toBe(true);
  });

  test("WITH RECURSIVE", async () => {
    const r = await parse(
      "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n<5) SELECT * FROM t",
    );
    expect(r.ok).toBe(true);
  });

  test("RETURNING clause on DML", async () => {
    // RETURNING is PG-specific (not standard SQL, not MySQL). The visitor
    // walks the returningList; pin that it parses to verify the dialect
    // is the real PG parser, not a generic SQL-92 stub.
    const r = await parse("UPDATE users SET n=1 WHERE id=1 RETURNING id");
    expect(r.ok).toBe(true);
  });

  test("ON CONFLICT (upsert)", async () => {
    const r = await parse(
      "INSERT INTO users(id, n) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET n = EXCLUDED.n",
    );
    expect(r.ok).toBe(true);
  });

  test("`::` cast operator", async () => {
    const r = await parse("SELECT '1'::int");
    expect(r.ok).toBe(true);
  });

  test("dollar-quoted string body (semicolon-inside-literal)", async () => {
    // Critical: the body contains a semicolon. The dialect MUST recognize
    // the dollar-quote so the semicolon doesn't promote this to a multi-
    // statement parse. tree.stmts.length must stay 1.
    const r = await parse("SELECT $tag$one;two$tag$");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ast.stmts.length).toBe(1);
  });

  test("LATERAL join", async () => {
    const r = await parse(
      "SELECT * FROM t1, LATERAL (SELECT * FROM t2 WHERE t2.id = t1.id) t2",
    );
    expect(r.ok).toBe(true);
  });

  test("array literal + `ANY` operator", async () => {
    const r = await parse("SELECT * FROM users WHERE id = ANY(ARRAY[1,2,3])");
    expect(r.ok).toBe(true);
  });
});

describe("dialects/postgres: parse-failure semantics", () => {
  test("syntax error → { ok: false, error } (no throw)", async () => {
    const r = await parse("SELEKT 1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(typeof r.error).toBe("string");
    expect(r.error.length).toBeGreaterThan(0);
  });

  test("empty input → { ok: false, error: 'empty input' }", async () => {
    const r = await parse("");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("empty input");
  });

  test("whitespace-only input → { ok: false }", async () => {
    const r = await parse("   \n\t  ");
    expect(r.ok).toBe(false);
  });

  test("comment-only input → { ok: false, error: 'no statements' }", async () => {
    // libpg_query parses comment-only input as ok=true with stmts=[]. The
    // dialect intentionally promotes that to a parse failure so the
    // engine doesn't pass a syntactically-empty query to executor.
    const r = await parse("-- just a comment");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("no statements");
  });

  test("sql exceeding 1 MiB cap → { ok: false }", async () => {
    const huge = "SELECT '" + "a".repeat(1_048_577) + "'";
    const r = await parse(huge);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/exceeds/);
  });
});
