// The guarded Postgres client. Each plan runs in its own transaction on one
// pooled connection:
//
//   BEGIN [READ ONLY];
//   SET LOCAL ROLE <plan.role>;                       -- when the policy names one
//   set_config: statement_timeout, lock_timeout,
//               search_path = pg_catalog, public, pg_temp
//   set_config('midplane.mask_salt', $salt, true)     -- read back before use
//   <plan.statement>                                  -- extended protocol, one statement
//   COMMIT;
//
// The statement goes through the extended query protocol, where Postgres
// refuses a second statement in the same message: a second layer behind the
// parser. Rows and bytes returned are capped. A claimed write carries the
// count its approver saw, and rolls back unless the rows it changed match.
//
// Every attempt to reach the database (a statement, a catalog read, a probe)
// is reported to an observer once it completes, for the database's health.

import type { ExecutionPlan } from "@midplane/core";
import { SEARCH_PATH } from "@midplane/core";
import pg from "pg";
import Cursor from "pg-cursor";

/** The session search path: the core's resolution order, with pg_temp last. */
export const SESSION_SEARCH_PATH = [...SEARCH_PATH, "pg_temp"].join(", ");

export interface Limits {
  maxRows: number;
  maxBytes: number;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  /** Rows the statement returned or changed; null when Postgres reports none. */
  rowCount: number | null;
  /** True when rows were withheld by the row or byte cap. */
  truncated: boolean;
  durationMs: number;
}

/** A failed statement: SQLSTATE and a message, details dropped when asked. */
export class ExecutionError extends Error {
  readonly sqlstate: string | null;
  readonly detail: string | null;

  constructor(sqlstate: string | null, message: string, detail: string | null) {
    super(message);
    this.name = "ExecutionError";
    this.sqlstate = sqlstate;
    this.detail = detail;
  }
}

/** The caller's guard stopped a statement after its connection came, before it began. */
export class StoppedError extends ExecutionError {
  constructor(reason: string) {
    super(null, reason, null);
    this.name = "StoppedError";
  }
}

/** A claimed write changed a different number of rows than was approved; rolled back. */
export class RowCountError extends ExecutionError {
  readonly rowCount: number | null;
  readonly approved: { count: number; exact: boolean };

  constructor(
    rowCount: number | null,
    approved: { count: number; exact: boolean },
  ) {
    super(
      null,
      `this write changed ${rowCount ?? "an unknown number of"} rows, but ${approved.exact ? "" : "at most "}${approved.count} were approved, so it was rolled back`,
      null,
    );
    this.name = "RowCountError";
    this.rowCount = rowCount;
    this.approved = approved;
  }
}

const BATCH = 200;

/** The longest a statement waits for a pooled connection. */
const CONNECT_TIMEOUT_MS = 10_000;

/** The longest a catalog read may run. */
const CATALOG_TIMEOUT_MS = 30_000;

/** An error's SQLSTATE, if Postgres sent one; Node's socket codes (EPIPE) aren't. */
function sqlstateOf(err: unknown): string | null {
  return err instanceof pg.DatabaseError &&
    typeof err.code === "string" &&
    /^[0-9A-Z]{5}$/.test(err.code)
    ? err.code
    : null;
}

/** pg's own connect timeouts (the client's and the pool's), which carry no code. */
const CONNECT_TIMEOUTS = new Set([
  "Connection terminated due to connection timeout",
  "timeout exceeded when trying to connect",
]);

/**
 * An error's SQLSTATE, or Node's code for a socket error (ECONNREFUSED), or
 * TIMEOUT when nothing answered a connection in time; else null.
 */
export function errorCode(err: unknown): string | null {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (typeof e?.code === "string") return e.code.slice(0, 32);
  return typeof e?.message === "string" && CONNECT_TIMEOUTS.has(e.message)
    ? "TIMEOUT"
    : null;
}

/** How a completed attempt to reach a database went; the message is for the local log only. */
export type Attempt =
  | { ok: true }
  | { ok: false; code: string | null; message: string };

/** What reached for the database: a statement, a catalog read, or a probe (`SELECT 1`). */
export type AttemptKind = "statement" | "catalog" | "probe";

function failure(err: unknown): Attempt {
  return {
    ok: false,
    code: errorCode(err),
    message: (err as Error)?.message ?? String(err),
  };
}

/**
 * What a failed statement says of its database: down when it got no answer
 * (a socket error, a dropped connection) or one that ends the connection
 * (SQLSTATE class 08, or the server shutting down); up on any other answer,
 * even an error or a cancellation by `statement_timeout`.
 */
export function statementAttempt(err: unknown): Attempt {
  if (err instanceof pg.DatabaseError)
    return /^(08...|57P0[1-3])$/.test(err.code ?? "")
      ? failure(err)
      : { ok: true };
  // Midplane's own checks (the salt, an approved row count) ran on its answer.
  return err instanceof ExecutionError ? { ok: true } : failure(err);
}

// Dates, times and intervals pass through as Postgres prints them. Parsing
// them into JavaScript Dates would shift a `timestamp without time zone` by
// the gateway's own time zone.
const TEXT_TYPES = new Set([
  1082, // date
  1083, // time
  1114, // timestamp
  1184, // timestamptz
  1186, // interval
  1266, // timetz
]);

export const types: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    TEXT_TYPES.has(oid)
      ? (value: string) => value
      : pg.types.getTypeParser(
          oid,
          format,
        )) as pg.CustomTypesConfig["getTypeParser"],
};

function approxBytes(row: unknown[]): number {
  let n = 0;
  for (const v of row) {
    if (v === null || v === undefined) n += 4;
    else if (typeof v === "string") n += v.length;
    else if (Buffer.isBuffer(v)) n += v.length * 2;
    else n += JSON.stringify(v)?.length ?? 8;
  }
  return n;
}

function read(
  cursor: Cursor,
  n: number,
): Promise<{ rows: unknown[][]; result: pg.QueryResult | undefined }> {
  return new Promise((resolve, reject) => {
    // Once the portal is done, pg-cursor answers without a result object.
    cursor.read(n, (err, rows, result) => {
      if (err) reject(err);
      else
        resolve({
          rows: rows as unknown[][],
          result: result as pg.QueryResult | undefined,
        });
    });
  });
}

export class DatabaseExecutor {
  private readonly pool: pg.Pool;
  private readonly observe: (attempt: Attempt, kind: AttemptKind) => void;

  /** `observe` hears how each attempt to reach the database ended. */
  constructor(
    dsn: string,
    observe: (attempt: Attempt, kind: AttemptKind) => void = () => {},
  ) {
    this.observe = observe;
    this.pool = new pg.Pool({
      connectionString: dsn,
      max: 10,
      application_name: "midplane-gateway",
      types,
      idleTimeoutMillis: 30_000,
      // A statement waits this long for a connection, never indefinitely.
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    });
    // An idle client's error (server restart) must not crash the process.
    this.pool.on("error", () => {});
  }

  /**
   * Run a plan. `salt` is set and read back when given; `stripDetail` drops
   * Postgres' DETAIL, HINT and CONTEXT, which can quote a failing row.
   * `expectRows` is an approved count: the rows changed must equal it
   * (exact) or not exceed it, or the transaction rolls back. `stop` is asked
   * once the connection comes, right before BEGIN: a reason stops the
   * statement there (StoppedError), after any wait for the pool.
   */
  async run(
    plan: ExecutionPlan,
    options: {
      salt: string | null;
      limits: Limits;
      stripDetail: boolean;
      expectRows?: { count: number; exact: boolean };
      stop?: () => string | null;
    },
  ): Promise<QueryResult> {
    const started = performance.now();
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (err) {
      this.observe(failure(err), "statement");
      // A refused login carries a SQLSTATE; a timeout or a refused socket doesn't.
      throw new ExecutionError(
        sqlstateOf(err),
        (err as Error)?.message ?? String(err),
        null,
      );
    }
    // Stopped here, nothing reached the database: its health stays as it was.
    const stopped = options.stop?.();
    if (stopped) {
      client.release();
      throw new StoppedError(stopped);
    }
    let broken = false;
    try {
      await client.query(plan.readOnly ? "BEGIN READ ONLY" : "BEGIN");
      if (plan.role)
        await client.query(
          `SET LOCAL ROLE ${client.escapeIdentifier(plan.role)}`,
        );
      await client.query({
        text: "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true), set_config('search_path', $3, true)",
        values: [
          `${plan.statementTimeoutMs}ms`,
          `${plan.lockTimeoutMs}ms`,
          SESSION_SEARCH_PATH,
        ],
      });
      if (options.salt !== null) {
        const r = await client.query<{ v: string }>({
          text: "SELECT set_config('midplane.mask_salt', $1, true) AS v",
          values: [options.salt],
        });
        // A pooled session can report '' for a custom setting; never run unsalted.
        if (r.rows[0]?.v !== options.salt) {
          throw new ExecutionError(
            null,
            "the mask salt did not apply; refusing to run",
            null,
          );
        }
      }

      const cursor = client.query(
        new Cursor(plan.statement, [], { rowMode: "array", types }),
      );
      const kept: unknown[][] = [];
      let bytes = 0;
      let truncated = false;
      let result: pg.QueryResult | undefined;
      for (;;) {
        const batch = await read(cursor, BATCH);
        if (batch.result) result = batch.result;
        if (batch.rows.length === 0) break;
        for (const row of batch.rows) {
          if (truncated) continue;
          const size = approxBytes(row);
          if (
            kept.length >= options.limits.maxRows ||
            bytes + size > options.limits.maxBytes
          ) {
            truncated = true;
            continue;
          }
          kept.push(row);
          bytes += size;
        }
        // A read stops at the cap; a write drains so its row count is exact.
        if (truncated && plan.readOnly) break;
      }
      await new Promise<void>((resolve, reject) =>
        cursor.close((err) => (err ? reject(err) : resolve())),
      );
      const want = options.expectRows;
      if (want) {
        const n = result?.rowCount ?? null;
        if (n === null || (want.exact ? n !== want.count : n > want.count)) {
          throw new RowCountError(n, want);
        }
      }
      await client.query("COMMIT");
      this.observe({ ok: true }, "statement");
      return {
        columns: (result?.fields ?? []).map((f) => f.name),
        rows: kept,
        rowCount:
          truncated && plan.readOnly ? null : (result?.rowCount ?? null),
        truncated,
        durationMs: performance.now() - started,
      };
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      this.observe(statementAttempt(err), "statement");
      if (err instanceof ExecutionError) throw err;
      const e = err as pg.DatabaseError;
      const detail = options.stripDetail
        ? null
        : [e.detail, e.hint].filter(Boolean).join(" ") || null;
      throw new ExecutionError(
        sqlstateOf(err),
        e.message ?? String(err),
        detail,
      );
    } finally {
      client.release(broken);
    }
  }

  /**
   * A read-only session pinned like `run`'s, for catalog queries, which may
   * run for CATALOG_TIMEOUT_MS. Any failure counts against the database's
   * health, even one after connecting: its catalog couldn't be read.
   */
  async withReadOnly<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (err) {
      this.observe(failure(err), "catalog");
      throw err;
    }
    try {
      await client.query("BEGIN READ ONLY");
      await client.query({
        text: "SELECT set_config('search_path', $1, true), set_config('statement_timeout', $2, true)",
        values: [SESSION_SEARCH_PATH, `${CATALOG_TIMEOUT_MS}ms`],
      });
      const out = await fn(client);
      await client.query("COMMIT");
      this.observe({ ok: true }, "catalog");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      this.observe(failure(err), "catalog");
      throw err;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    return (await this.probe()).ok;
  }

  /** A round trip, timed; on failure, only the SQLSTATE or Node error code. */
  async probe(
    timeoutMs = 5_000,
  ): Promise<{ ok: boolean; latencyMs: number; code: string | null }> {
    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.pool.query("SELECT 1"),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })),
            timeoutMs,
          );
        }),
      ]);
      this.observe({ ok: true }, "probe");
      return { ok: true, latencyMs: performance.now() - started, code: null };
    } catch (err) {
      this.observe(failure(err), "probe");
      return {
        ok: false,
        latencyMs: performance.now() - started,
        code: errorCode(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
