// MySQL dialect — parse-level pins.
//
// The MySQL mirror of dialects/postgres/parse.test.ts: targets behavior unique
// to the node-sql-parser wrapper (AST shape, MySQL-specific syntax, parse-error
// semantics). Pins the AST shapes the normalize adapter depends on, so a
// node-sql-parser bump that reshapes them surfaces here instead of silently
// breaking policy. Policy outcomes live in adversarial/; cross-dialect contract
// pins live in dialects/registry.test.ts.

import { describe, expect, test } from "bun:test";
import { parse } from "../../../src/dialects/mysql/parse.ts";

// Local view of the node-sql-parser AST shapes this file asserts on.
type Ast = Record<string, unknown>;

describe("dialects/mysql: AST shape (node-sql-parser)", () => {
  test("single statement → one AST object with a lowercase `type`", async () => {
    const r = await parse("SELECT 1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.isArray(r.ast)).toBe(false);
    expect((r.ast as Ast).type).toBe("select");
  });

  test("multi-statement input → array of N ASTs (drives statementCount)", async () => {
    const r = await parse("SELECT 1; SELECT 2; SELECT 3");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.isArray(r.ast)).toBe(true);
    expect((r.ast as Ast[]).length).toBe(3);
  });

  test("trailing semicolon yields an array (still one statement)", async () => {
    const r = await parse("SELECT 1;");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.isArray(r.ast)).toBe(true);
    expect((r.ast as Ast[]).length).toBe(1);
  });

  test("FROM table exposes { db, table, as }", async () => {
    const r = await parse("SELECT id FROM users u");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const from = (r.ast as Ast).from as Ast[];
    expect(from[0]).toMatchObject({ db: null, table: "users", as: "u" });
  });

  test("backtick identifiers are normalized to bare names in the AST", async () => {
    // node-sql-parser strips backticks, so the normalize adapter's rule keys
    // match policy keys without special handling. Pin it so a parser change
    // that started preserving backticks surfaces here.
    const r = await parse("SELECT * FROM `users` WHERE `org_id` = 42");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const from = (r.ast as Ast).from as Ast[];
    expect(from[0]).toMatchObject({ table: "users" });
    const where = (r.ast as Ast).where as Ast;
    expect((where.left as Ast).column).toBe("org_id");
  });

  test("db.table.col exposes `db` on both the table ref and the column ref", async () => {
    // The cross-DB guard keys off these `db` fields.
    const r = await parse("SELECT * FROM appdb.users WHERE appdb.users.org_id = 42");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const from = (r.ast as Ast).from as Ast[];
    expect(from[0]).toMatchObject({ db: "appdb", table: "users" });
    const where = (r.ast as Ast).where as Ast;
    expect((where.left as Ast)).toMatchObject({ db: "appdb", table: "users", column: "org_id" });
  });
});

describe("dialects/mysql: MySQL-specific syntax accepted", () => {
  test("INSERT … ON DUPLICATE KEY UPDATE exposes on_duplicate_update", async () => {
    const r = await parse("INSERT INTO users (id) VALUES (1) ON DUPLICATE KEY UPDATE id = 2");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.ast as Ast).on_duplicate_update).toBeTruthy();
  });

  test("REPLACE INTO parses as type 'replace'", async () => {
    const r = await parse("REPLACE INTO users (id) VALUES (1)");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.ast as Ast).type).toBe("replace");
  });

  test("INSERT … SET form parses", async () => {
    const r = await parse("INSERT INTO users SET id = 1, org_id = 42");
    expect(r.ok).toBe(true);
  });

  test("USE parses as type 'use'", async () => {
    const r = await parse("USE otherdb");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.ast as Ast).type).toBe("use");
  });
});

describe("dialects/mysql: parse-failure semantics", () => {
  test("syntax error → { ok: false } (no throw)", async () => {
    const r = await parse("SELEKT 1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(typeof r.error).toBe("string");
    expect(r.error.length).toBeGreaterThan(0);
  });

  test("MERGE → { ok: false } (node-sql-parser rejects it in MySQL mode)", async () => {
    // MySQL has no MERGE; node-sql-parser throws → parse_error DENY before the
    // adapter is reached. (The adapter's unsupported sink is the backstop if a
    // future parser ever started accepting it.)
    const r = await parse("MERGE INTO t USING s ON (t.id = s.id) WHEN MATCHED THEN UPDATE SET t.x = s.x");
    expect(r.ok).toBe(false);
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

  test("sql exceeding 1 MiB cap → { ok: false }", async () => {
    const huge = "SELECT '" + "a".repeat(1_048_577) + "'";
    const r = await parse(huge);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/exceeds/);
  });
});
