// Regression tests for PgPoolExecutor's search_path pinning.
//
// Background: a previous build pinned search_path via the libpq `options=`
// startup parameter. Pooled (PgBouncer-style) endpoints — Neon's pooled
// endpoint, Supavisor in transaction mode, RDS Proxy — reject any startup
// parameter not on their allowlist with SQLSTATE 08P01:
//   "unsupported startup parameter in options: search_path"
// A first attempt moved the pin to a one-shot `SET search_path` issued in
// a `pool.on('connect', ...)` handler. That works on direct/session-pooled
// endpoints but is unsafe on transaction-pooled endpoints: the pooler
// only holds the backend for one transaction, so subsequent transactions
// can rebind to different backends still running with default search_path.
//
// What this file guards against:
//   1. The libpq `options=` startup parameter never reappears on the pool
//      config (08P01 regression).
//   2. Every execute() runs `SET LOCAL search_path = ...` inside an
//      explicit BEGIN/COMMIT, so the pin holds even on transaction-pooled
//      endpoints (the pooler can't rebind mid-transaction). SET LOCAL
//      expires at COMMIT so no state leaks back into the shared pool.
//   3. The SET SQL is identifier-quoted, so any future surface that lets
//      operators configure the schema name stays injection-safe.

import { describe, expect, test } from "bun:test";
import {
  PgPoolExecutor,
  SET_LOCAL_SEARCH_PATH_SQL,
  quoteSchemaIdentifier,
} from "../../src/executor/pg-pool.ts";
import type { ExecuteContext } from "@midplane/engine";

const ctx: ExecuteContext = {
  tenant_id: "t",
  agent_name: null,
  agent_version: null,
};

// Minimal pg-shaped fake. PgPoolExecutor.execute() calls pool.connect(),
// then client.query() multiple times, then client.release(). The fake
// records the query strings in order so tests can assert the wrapping.
function makeFakeClient() {
  const queries: string[] = [];
  let released = false;
  const client = {
    queries,
    released: () => released,
    query: async (sql: string) => {
      queries.push(sql);
      // Match pg.QueryResult for the user-SQL slot (last non-COMMIT call).
      return { rows: [{ ok: 1 }], rowCount: 1 };
    },
    release: () => {
      released = true;
    },
  };
  return client;
}

function makeFakePool(client: ReturnType<typeof makeFakeClient>) {
  return {
    connect: async () => client,
    options: {} as Record<string, unknown>,
  };
}

function withFakePool(
  exec: PgPoolExecutor,
  fakePool: ReturnType<typeof makeFakePool>,
): void {
  (exec as unknown as { pool: unknown }).pool = fakePool;
}

describe("PgPoolExecutor — search_path pin shape", () => {
  test("pool config does NOT carry libpq `options` startup parameter", async () => {
    // Neon's pooler, Supavisor (txn mode), and RDS Proxy all reject
    // startup params outside their allowlist with 08P01. The only safe
    // value here is "not set".
    const exec = new PgPoolExecutor({ databaseUrl: "postgres://stub/db" });
    try {
      const pool = (exec as unknown as { pool: { options: Record<string, unknown> } }).pool;
      expect(pool.options.options).toBeUndefined();
    } finally {
      await exec.close();
    }
  });

  test("SET LOCAL search_path SQL identifier-quotes every schema", () => {
    // Today the pinned schemas are a static allowlist of known-safe names
    // (`public`, `pg_catalog`). Quoting is still mandatory: the helper is
    // the single chokepoint for any future surface that lets operators
    // supply a schema name (env var, table_access YAML, per-tenant
    // override). If quoting silently regresses, untrusted schema input
    // would inject SQL into the very SET that was meant to lock the
    // session down.
    expect(SET_LOCAL_SEARCH_PATH_SQL).toBe(
      'SET LOCAL search_path = "public", "pg_catalog"',
    );
  });
});

describe("PgPoolExecutor — per-query transaction wrapping", () => {
  test("execute() runs BEGIN, SET LOCAL search_path, user SQL, COMMIT in order", async () => {
    // The whole point of SET LOCAL inside a transaction is that
    // PgBouncer-style transaction pooling cannot rebind to a different
    // backend until COMMIT, so the search_path pin is in force for the
    // user's query. If anyone ever moves the SET back outside the
    // transaction (or drops the BEGIN/COMMIT), this assertion catches it.
    const client = makeFakeClient();
    const exec = new PgPoolExecutor({ databaseUrl: "postgres://stub/db" });
    withFakePool(exec, makeFakePool(client));

    const result = await exec.execute("SELECT 1", ctx);

    expect(client.queries).toEqual([
      "BEGIN",
      'SET LOCAL search_path = "public", "pg_catalog"',
      "SELECT 1",
      "COMMIT",
    ]);
    expect(client.released()).toBe(true);
    expect(result).toEqual({ rows: [{ ok: 1 }], rowCount: 1 });
  });

  test("execute() ROLLBACKs and releases the client when the user SQL throws", async () => {
    // On user SQL failure the client must go back to the pool in a clean
    // state. Skipping ROLLBACK leaves the backend in an aborted-tx state
    // and the next caller's BEGIN errors out (`current transaction is
    // aborted`). Skipping release() leaks the client. Both have to happen.
    const calls: string[] = [];
    let released = false;
    const failingClient = {
      query: async (sql: string) => {
        calls.push(sql);
        if (sql === "SELECT bad") {
          const err = new Error("bad sql") as Error & { code?: string };
          err.code = "42703";
          throw err;
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {
        released = true;
      },
    };
    const exec = new PgPoolExecutor({ databaseUrl: "postgres://stub/db" });
    withFakePool(exec, {
      connect: async () => failingClient,
      options: {},
    } as ReturnType<typeof makeFakePool>);

    await expect(exec.execute("SELECT bad", ctx)).rejects.toMatchObject({
      code: "42703",
    });

    expect(calls).toEqual([
      "BEGIN",
      'SET LOCAL search_path = "public", "pg_catalog"',
      "SELECT bad",
      "ROLLBACK",
    ]);
    expect(released).toBe(true);
  });

  test("execute() does NOT ROLLBACK if BEGIN itself failed (no open tx to roll back)", async () => {
    // Defensive: if BEGIN fails we never entered a transaction, so
    // sending ROLLBACK is wrong (it'd error with "no transaction in
    // progress" and clutter logs). The release() still has to run.
    const calls: string[] = [];
    let released = false;
    const failingClient = {
      query: async (sql: string) => {
        calls.push(sql);
        if (sql === "BEGIN") throw Object.assign(new Error("conn lost"), { code: "08006" });
        return { rows: [], rowCount: 0 };
      },
      release: () => {
        released = true;
      },
    };
    const exec = new PgPoolExecutor({ databaseUrl: "postgres://stub/db" });
    withFakePool(exec, {
      connect: async () => failingClient,
      options: {},
    } as ReturnType<typeof makeFakePool>);

    await expect(exec.execute("SELECT 1", ctx)).rejects.toMatchObject({
      code: "08006",
    });

    expect(calls).toEqual(["BEGIN"]);
    expect(released).toBe(true);
  });

  test("execute() surfaces SQLSTATE-less errors with code='UNKNOWN' (audit contract)", async () => {
    // The engine's FAILED audit reads .code off the thrown error to
    // populate error_class. A pg.Pool.connect() throw (e.g. ECONNREFUSED)
    // arrives without .code; without this fallback the audit record's
    // error_class field is undefined and downstream diagnostics break.
    const exec = new PgPoolExecutor({ databaseUrl: "postgres://stub/db" });
    withFakePool(exec, {
      connect: async () => {
        throw new Error("connect refused");
      },
      options: {},
    } as ReturnType<typeof makeFakePool>);

    await expect(exec.execute("SELECT 1", ctx)).rejects.toMatchObject({
      code: "UNKNOWN",
    });
  });
});

describe("quoteSchemaIdentifier", () => {
  test("wraps in double quotes", () => {
    expect(quoteSchemaIdentifier("public")).toBe('"public"');
  });

  test("doubles internal double-quotes (Postgres identifier-escape rule)", () => {
    // A schema literally named  weird"name  must serialize to "weird""name"
    // — anything else lets a caller break out of the identifier and append
    // arbitrary SQL to the SET.
    expect(quoteSchemaIdentifier('weird"name')).toBe('"weird""name"');
  });

  test("preserves embedded characters that would be SQL-significant unquoted", () => {
    // Quoting also turns reserved words and case-sensitive names into
    // valid identifiers — verify they survive untouched inside the quotes.
    expect(quoteSchemaIdentifier("Mixed-Case")).toBe('"Mixed-Case"');
    expect(quoteSchemaIdentifier("select")).toBe('"select"');
  });
});
