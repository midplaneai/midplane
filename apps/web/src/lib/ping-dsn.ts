// One-shot connectivity probe used by the add-database inline form's
// [Test connection] button. Opens a single Postgres connection with
// strict timeouts, runs SELECT 1, and returns ok/err. Never persists
// anything — this is purely "does the DSN you pasted reach a live
// Postgres?" before the user commits to encrypting + storing it.
//
// Failure surface: anything that isn't a clean SELECT 1 round-trips as
// {ok: false, error: <message>}. We don't try to classify (auth vs.
// network vs. SSL) — postgres-js already gives a useful message and
// any classification we layer on top would lag the driver.

import postgres from "postgres";

const CONNECT_TIMEOUT_S = 5;
const STATEMENT_TIMEOUT_MS = 5_000;

export interface PingDsnResult {
  ok: boolean;
  error?: string;
}

export async function pingDsn(dsn: string): Promise<PingDsnResult> {
  const sql = postgres(dsn, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: CONNECT_TIMEOUT_S,
    prepare: false,
    onnotice: () => undefined,
  });
  try {
    await sql.unsafe(`SET statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    const rows = await sql<{ ok: number }[]>`SELECT 1 AS ok`;
    if (rows.length === 1 && rows[0]?.ok === 1) return { ok: true };
    return { ok: false, error: "unexpected response from SELECT 1" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "connection failed",
    };
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}
