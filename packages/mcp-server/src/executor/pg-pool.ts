// Executor backed by pg.Pool. One pool per DSN.
//
// V1 single-tenant: a single pool keyed by databaseUrl. Multi-tenant pool
// eviction is V1.5+. Maps pg errors to {code, message} so the engine's FAILED
// audit captures SQLSTATE.
//
// search_path pin: the engine's table_access rule resolves bare table refs
// (`FROM users`) against `public.<name>` policy keys. That assumption only
// holds at execution time if the actual connection's search_path puts
// `public` first. Postgres's default `"$user", public` would resolve
// `FROM users` to `alice.users` for a role named `alice` if that schema
// has the table; role/db-level `ALTER ... SET search_path = tenant_schema,
// public` makes it worse. We pin search_path to `public, pg_catalog` via
// the libpq `options` startup parameter so every connection from this
// pool starts there. Combined with table_access denying VariableSetStmt,
// agent SQL can't redirect bare-name resolution to a different schema.
//
// Tradeoff: deployments whose tables live outside `public` MUST use
// schema-qualified refs in agent SQL (`FROM app_data.users`) and policy
// keys (`app_data.users: read`). Bare refs always resolve to public.

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
      options: "-c search_path=public,pg_catalog",
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
