// Opaque-error boundary for database / engine / network failures.
//
// Raw driver errors are a leak surface: a Postgres server error carries the
// table/column names and SQLSTATE that name the failure (`relation "salaries"
// does not exist`), and a connection error carries the DB host/user/name. None
// of that may cross out of the query path into a log line or a third-party
// error tracker — the same bright line the engine holds in engine/TELEMETRY.md
// ("What we never send": SQL text, table/column/schema names, DB URL components,
// full SQLSTATE).
//
// `safeErrorDetail` collapses a driver error to a non-identifying classifier
// while LETTING THROUGH our own curated, safe messages. The discriminator is a
// driver `.code`: Postgres and postgres-js set one; an `Error` we threw on
// purpose ("project disappeared during dry-run") does not. So control-plane
// status strings stay legible and only the driver's text gets masked.

function extractCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    if (typeof code === "number") return String(code);
  }
  return undefined;
}

// Map a driver `.code` to a safe class, or null if it isn't a recognizable
// driver/network code (caller then treats the error as app-level).
function classifyCode(code: string): string | null {
  // Postgres SQLSTATE: exactly 5 chars from [0-9A-Z], always carrying a digit
  // in practice. Keep the 2-char CLASS only (`42`, not `42P01` =
  // undefined_table — the full code pairs with the table name elsewhere).
  if (/^[0-9A-Z]{5}$/.test(code) && /[0-9]/.test(code)) {
    return `pg_${code.slice(0, 2)}`;
  }
  // Node / libpq / postgres-js codes: all-caps identifiers (ECONNREFUSED,
  // ETIMEDOUT, CONNECT_TIMEOUT, EPIPE). Safe to surface verbatim — they name a
  // failure mode, not a target.
  if (/^[A-Z][A-Z0-9_]*$/.test(code)) return `net_${code}`;
  return null;
}

/**
 * Reduce any error to a string safe to log, return as an error `detail`, or
 * hand to an error tracker. Driver/network errors become an opaque class
 * (`pg_42`, `net_ECONNREFUSED`, or `db_error`); errors without a driver code
 * are assumed to be app-level and their message is passed through unchanged.
 */
export function safeErrorDetail(err: unknown): string {
  const code = extractCode(err);
  if (code !== undefined) return classifyCode(code) ?? "db_error";
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wrap an error as a new `Error` whose message is `safeErrorDetail(err)` — use
 * at a boundary that rethrows, so nothing downstream (autocapture, a future
 * captureException, a logger) ever sees the raw driver text.
 */
export function sanitizeDbError(err: unknown): Error {
  const safe = new Error(safeErrorDetail(err));
  safe.name = "SanitizedDbError";
  return safe;
}
