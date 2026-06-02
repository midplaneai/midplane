// Executor backed by mysql2's promise pool. One pool per DSN — the MySQL analog
// of pg-pool.ts.
//
// Bare-name soundness (the MySQL analog of the PG search_path pin): the DSN
// names the database (`mysql://user:pass@host:3306/app_db`), and mysql2 pins it
// as the connection's default schema. MySQL has no search_path to tamper with;
// the only way to change the active database is `USE`, which the MySQL dialect
// denies (unsupported), and stacked statements, which `multipleStatements:false`
// rejects at the driver. So `FROM users` provably resolves to `app_db.users`
// and bare/own-db policy keys are sound. (The dialect also rejects cross-database
// `otherdb.users` refs — see dialects/mysql/normalize.ts.)
//
// multipleStatements is asserted false. mysql2 defaults it false, but a security
// tool states the invariant explicitly: with it true, `SELECT 1; DROP TABLE x`
// would run both halves in one round-trip, defeating the multi_statement rule's
// guarantee that each statement is policy-checked in isolation.
//
// No per-query transaction wrapper is needed (unlike pg-pool, which wraps to keep
// SET LOCAL search_path in force across poolers). MySQL's database pin is a
// connection property, not session SQL, so there's nothing to re-pin per query.

import mysql from "mysql2/promise";
import type { Executor, ExecuteContext, ExecutionResult } from "@midplane/engine";

export interface MysqlPoolExecutorOptions {
  databaseUrl: string;
  max?: number;
}

// The pool options every MysqlPoolExecutor is built with. Exposed (readonly) so
// the security invariant — multipleStatements:false — is assertable in tests
// without reaching into mysql2 internals.
export interface ResolvedMysqlPoolOptions {
  uri: string;
  multipleStatements: false;
  connectionLimit: number;
}

export class MysqlPoolExecutor implements Executor {
  private readonly pool: mysql.Pool;
  // Snapshot of the options the pool was created with (test-observable).
  readonly poolOptions: ResolvedMysqlPoolOptions;

  constructor(opts: MysqlPoolExecutorOptions) {
    this.poolOptions = {
      uri: opts.databaseUrl,
      // SECURITY INVARIANT — see file header. Never make this configurable.
      multipleStatements: false,
      connectionLimit: opts.max ?? 10,
    };
    this.pool = mysql.createPool(this.poolOptions);
  }

  async execute(sql: string, _ctx: ExecuteContext): Promise<ExecutionResult> {
    try {
      const [result] = await this.pool.query(sql);
      // SELECT (and SHOW/DESCRIBE) → an array of row objects. DML → a
      // ResultSetHeader carrying affectedRows. Discriminate on Array.isArray.
      if (Array.isArray(result)) {
        return { rows: result as unknown[], rowCount: result.length };
      }
      const header = result as { affectedRows?: number };
      return { rows: [], rowCount: header.affectedRows ?? 0 };
    } catch (err) {
      // The engine's FAILED audit reads `.code` for error_class. PG puts SQLSTATE
      // there; mysql2 instead sets `.code` to a MySQL-specific name
      // (ER_NO_SUCH_TABLE) and the SQLSTATE on `.sqlState`. Map sqlState → code
      // so error_class is a SQLSTATE class consistent across dialects. The
      // original mysql2 message is preserved (it carries the ER_* detail).
      const e = err as Error & { code?: string; sqlState?: string };
      e.code = e.sqlState ?? "HY000";
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
