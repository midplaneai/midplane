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
import type { Executor, ExecuteContext, ExecutionResult, TxClient } from "@midplane/engine";

// Lift node-pg's QueryResult into the engine's ExecutionResult, mapping the
// driver's RowDescription provenance (tableID/columnID/dataTypeID) into the
// fields the masker reads. Shared by execute() and the transaction-scoped exec()
// so both paths report identical provenance (a computed output is tableID=0).
function liftResult(result: pg.QueryResult): ExecutionResult {
  return {
    rows: result.rows,
    rowCount: result.rowCount ?? 0,
    fields: (result.fields ?? []).map((f) => ({
      name: f.name,
      tableOid: f.tableID ?? 0,
      columnAttnum: f.columnID ?? 0,
      dataTypeOid: f.dataTypeID ?? 0,
    })),
  };
}

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

export type PgSslOption = boolean | { rejectUnauthorized: boolean } | undefined;

export interface PgConnectionConfig {
  /** DSN with sslmode/ssl query params stripped when we set `ssl` explicitly. */
  connectionString: string;
  /** Explicit pg `ssl`, or undefined to leave the DSN/env to decide. */
  ssl: PgSslOption;
}

// Build a node-postgres connection config that honors libpq's sslmode
// semantics. node-postgres (via pg-connection-string) upgrades
// sslmode=prefer|require|verify-ca to verify-full — it VERIFIES the server
// certificate — which is STRICTER than the PostgreSQL spec. libpq's `require`
// means "encrypt, but do NOT verify the certificate"; only verify-ca and
// verify-full verify. That mismatch rejects every legitimate self-signed or
// private-CA Postgres — including the hosted sample database (a self-signed
// cert on a private 6PN box) — with an opaque "self signed certificate" the
// moment an agent runs its first query.
//
// We must STRIP sslmode from the DSN, not just pass `ssl`: pg lets the parsed
// connection string override an explicit `ssl` config option
// (connection-parameters.js: `Object.assign(config, parse(connectionString))`),
// so `ssl` alone is silently ignored. With sslmode removed, our explicit `ssl`
// is the value pg uses.
//
//   disable                -> ssl:false                  (no TLS)
//   allow|prefer|require    -> {rejectUnauthorized:false}  (encrypt, don't verify)
//   no-verify               -> {rejectUnauthorized:false}
//   verify-ca|verify-full   -> {rejectUnauthorized:true}   (encrypt AND verify)
//
// A DSN with no sslmode (and an unparseable or unknown-mode DSN) is left
// untouched (`ssl: undefined`), preserving today's behavior for connections
// that don't name a mode.
export function libpqSslConfig(dsn: string): PgConnectionConfig {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return { connectionString: dsn, ssl: undefined };
  }
  const sslmode = url.searchParams.get("sslmode");
  if (!sslmode) return { connectionString: dsn, ssl: undefined };

  let ssl: PgSslOption;
  switch (sslmode) {
    case "disable":
      ssl = false;
      break;
    case "allow":
    case "prefer":
    case "require":
    case "no-verify":
      ssl = { rejectUnauthorized: false };
      break;
    case "verify-ca":
    case "verify-full":
      ssl = { rejectUnauthorized: true };
      break;
    default:
      // Unknown mode — don't guess; hand pg the raw DSN unchanged.
      return { connectionString: dsn, ssl: undefined };
  }
  // Strip both so the connection-string parser can't re-derive verify-full and
  // override our explicit `ssl`. `ssl` alongside `sslmode` is redundant anyway.
  url.searchParams.delete("sslmode");
  url.searchParams.delete("ssl");
  return { connectionString: url.toString(), ssl };
}

export class PgPoolExecutor implements Executor {
  private readonly pool: pg.Pool;

  constructor(opts: PgPoolExecutorOptions) {
    const { connectionString, ssl } = libpqSslConfig(opts.databaseUrl);
    this.pool = new pg.Pool({
      connectionString,
      max: opts.max ?? 10,
      ...(ssl !== undefined ? { ssl } : {}),
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
      return liftResult(result);
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

  // Transaction-scoped client for the masking source-rewrite path (T0). Same
  // checked-out-client + BEGIN + SET LOCAL search_path setup as execute(), but it
  // hands the caller a TxClient so catalog resolution (by name), the mask-salt
  // GUC, and the rewritten user query all run on ONE backend. The pooler can't
  // rebind mid-transaction, so the search_path pin and any SET LOCAL the caller
  // adds (the salt, via set_config(.., true)) are in force for every statement
  // and expire at COMMIT — no session state leaks back into the shared pool.
  async withTransaction<T>(_ctx: ExecuteContext, fn: (tx: TxClient) => Promise<T>): Promise<T> {
    let client: pg.PoolClient | null = null;
    let inTransaction = false;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      inTransaction = true;
      await client.query(SET_LOCAL_SEARCH_PATH_SQL);
      const c = client;
      const tx: TxClient = {
        query: async (sql, params = []) =>
          (await c.query(sql, params as unknown[])).rows as Record<string, unknown>[],
        exec: async (sql) => liftResult(await c.query(sql)),
      };
      const out = await fn(tx);
      await client.query("COMMIT");
      inTransaction = false;
      return out;
    } catch (err) {
      if (client && inTransaction) {
        await client.query("ROLLBACK").catch(() => {});
      }
      const e = err as Error & { code?: string };
      if (!e.code) e.code = "UNKNOWN";
      throw e;
    } finally {
      if (client) client.release();
    }
  }

  // Plain pooled query for catalog reads (the masking OID resolver). Unlike
  // execute(), no transaction / search_path pin — catalog lookups target
  // pg_catalog directly by oid and carry no agent SQL. Returns just the rows.
  async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const res = await this.pool.query(sql, params as unknown[]);
    return res.rows as Record<string, unknown>[];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
