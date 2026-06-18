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
// public` makes it worse. Combined with table_access denying
// VariableSetStmt, a per-query pin makes bare-name resolution a hard
// guarantee from agent SQL's perspective.
//
// Where the pin lives — and why not the libpq `options=` startup parameter:
// PgBouncer-style poolers (Neon's pooled endpoint, Supavisor in
// transaction mode, RDS Proxy) reject any startup parameter not on
// their allowlist with SQLSTATE 08P01 ("unsupported startup parameter
// in options"). So `options=` is out — it breaks every customer pooled
// DSN at connect time.
//
// Where the pin lives — and why not a one-shot `SET search_path` at
// pool connect time: in transaction-pooled mode the pooler rents a
// backend for one transaction, then returns it to a shared pool. A
// connect-time SET only pins the backend the frontend happened to land
// on for that first transaction; subsequent statements can rebind to
// different backends still running with their default search_path.
// PgBouncer's `track_extra_parameters` does not include `search_path`
// in its default set, and we can't rely on operators having tuned it.
//
// What we actually do: every execute() opens a transaction on a checked
// -out client, runs `SET LOCAL search_path = "public", "pg_catalog"` as
// the first statement of that transaction, then runs the user's SQL,
// then COMMITs. The pooler cannot rebind mid-transaction, so the
// SET LOCAL is in force for the user's query on every pooler mode
// (session, transaction, statement) and on direct connections. SET
// LOCAL also expires at COMMIT, so no session state leaks back into
// the shared backend pool.
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

// Schemas pinned on every transaction. Order matters: `public` first so
// bare table refs resolve there; `pg_catalog` after so built-ins remain
// reachable (Postgres prepends pg_catalog implicitly only when it's absent
// from the explicit search_path).
const PINNED_SEARCH_PATH_SCHEMAS = ["public", "pg_catalog"] as const;

// Identifier-quote a Postgres name so it can be embedded in a SET
// statement without breaking out of the identifier context. Internal
// double-quotes are doubled per Postgres SQL rules. Defensive: today the
// schema list is a static allowlist of known-safe names, but the same
// helper covers any future surface that lets operators configure the
// search path (env var / table_access YAML / per-tenant override).
export function quoteSchemaIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export const SET_LOCAL_SEARCH_PATH_SQL = `SET LOCAL search_path = ${PINNED_SEARCH_PATH_SCHEMAS.map(
  quoteSchemaIdentifier,
).join(", ")}`;

export class PgPoolExecutor implements Executor {
  private readonly pool: pg.Pool;

  constructor(opts: PgPoolExecutorOptions) {
    this.pool = new pg.Pool({
      connectionString: opts.databaseUrl,
      max: opts.max ?? 10,
    });
  }

  async execute(sql: string, _ctx: ExecuteContext): Promise<ExecutionResult> {
    let client: pg.PoolClient | null = null;
    let inTransaction = false;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      inTransaction = true;
      await client.query(SET_LOCAL_SEARCH_PATH_SQL);
      const result = await client.query(sql);
      await client.query("COMMIT");
      inTransaction = false;
      return {
        rows: result.rows,
        rowCount: result.rowCount ?? 0,
      };
    } catch (err) {
      if (client && inTransaction) {
        // ROLLBACK can itself fail when the connection is already torn
        // down by a prior error; swallow that secondary failure so the
        // original SQLSTATE-bearing error is what the engine's FAILED
        // audit records.
        await client.query("ROLLBACK").catch(() => {});
      }
      // Surface SQLSTATE on .code so engine FAILED audit captures error_class.
      const e = err as Error & { code?: string };
      if (!e.code) e.code = "UNKNOWN";
      throw e;
    } finally {
      if (client) client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
