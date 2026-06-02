// MysqlPoolExecutor tests — security invariant + result/error mapping.
//
// Mirrors pg-pool.test.ts. Uses a fake pool injected over the real mysql2 pool
// so nothing connects to a database. Guards:
//   1. multipleStatements is false (the multi_statement rule's executor-side
//      backstop — with it true, `SELECT 1; DROP TABLE x` would run both halves).
//   2. SELECT result → { rows, rowCount=rows.length }; DML ResultSetHeader →
//      { rows: [], rowCount=affectedRows }.
//   3. Errors map sqlState → .code (PG puts SQLSTATE on .code; the engine's
//      FAILED audit reads .code for error_class). No sqlState → 'HY000'.

import { describe, expect, test } from "bun:test";
import { MysqlPoolExecutor } from "../../src/executor/mysql-pool.ts";
import type { ExecuteContext } from "@midplane/engine";

const ctx: ExecuteContext = { tenant_id: "t", agent_name: null, agent_version: null };

// Inject a fake pool exposing the one method the executor uses: query(sql) →
// [result, fields]. close() is exercised via end().
function withFakePool(
  exec: MysqlPoolExecutor,
  query: (sql: string) => Promise<[unknown, unknown]>,
): void {
  (exec as unknown as { pool: { query: typeof query; end: () => Promise<void> } }).pool = {
    query,
    end: async () => {},
  };
}

describe("MysqlPoolExecutor — security invariant", () => {
  test("pool is built with multipleStatements: false", () => {
    const exec = new MysqlPoolExecutor({ databaseUrl: "mysql://u:p@host:3306/app" });
    expect(exec.poolOptions.multipleStatements).toBe(false);
    expect(exec.poolOptions.uri).toBe("mysql://u:p@host:3306/app");
  });
});

describe("MysqlPoolExecutor — result mapping", () => {
  test("SELECT result (array) → rows + rowCount=length", async () => {
    const exec = new MysqlPoolExecutor({ databaseUrl: "mysql://stub/app" });
    withFakePool(exec, async () => [[{ id: 1 }, { id: 2 }], []]);
    const r = await exec.execute("SELECT id FROM users WHERE org_id = 42", ctx);
    expect(r).toEqual({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 });
  });

  test("DML ResultSetHeader → rows=[] + rowCount=affectedRows", async () => {
    const exec = new MysqlPoolExecutor({ databaseUrl: "mysql://stub/app" });
    withFakePool(exec, async () => [{ affectedRows: 3, insertId: 0 } as unknown, undefined]);
    const r = await exec.execute("UPDATE users SET x = 1 WHERE org_id = 42", ctx);
    expect(r).toEqual({ rows: [], rowCount: 3 });
  });
});

describe("MysqlPoolExecutor — error mapping (sqlState → code)", () => {
  test("error with sqlState surfaces .code = sqlState", async () => {
    const exec = new MysqlPoolExecutor({ databaseUrl: "mysql://stub/app" });
    withFakePool(exec, async () => {
      const err = new Error("Table 'app.nope' doesn't exist") as Error & {
        code?: string;
        sqlState?: string;
      };
      err.code = "ER_NO_SUCH_TABLE"; // mysql2's MySQL-specific name
      err.sqlState = "42S02"; // the SQLSTATE
      throw err;
    });
    await expect(exec.execute("SELECT * FROM nope", ctx)).rejects.toMatchObject({
      code: "42S02",
    });
  });

  test("error without sqlState falls back to .code = 'HY000'", async () => {
    const exec = new MysqlPoolExecutor({ databaseUrl: "mysql://stub/app" });
    withFakePool(exec, async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await expect(exec.execute("SELECT 1", ctx)).rejects.toMatchObject({
      code: "HY000",
    });
  });
});
