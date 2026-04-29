// Executor backed by pg.Pool. One pool per DSN.
//
// V1 single-tenant: a single pool keyed by databaseUrl. Multi-tenant pool
// eviction is V1.5+. Maps pg errors to {code, message} so the engine's FAILED
// audit captures SQLSTATE.

import pg from "pg";
import type { Executor, ExecuteContext, ExecutionResult } from "@midplane/engine";

export interface PgPoolExecutorOptions {
  databaseUrl: string;
  max?: number;
}

export class PgPoolExecutor implements Executor {
  private readonly pool: pg.Pool;

  constructor(opts: PgPoolExecutorOptions) {
    this.pool = new pg.Pool({
      connectionString: opts.databaseUrl,
      max: opts.max ?? 10,
    });
  }

  async execute(sql: string, _ctx: ExecuteContext): Promise<ExecutionResult> {
    try {
      const result = await this.pool.query(sql);
      return {
        rows: result.rows,
        rowCount: result.rowCount ?? 0,
      };
    } catch (err) {
      // Surface SQLSTATE on .code so engine FAILED audit captures error_class.
      const e = err as Error & { code?: string };
      if (!e.code) e.code = "UNKNOWN";
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
