// One-shot Postgres introspection used by the table-permissions UI to
// power its autocomplete suggestions.
//
// Opens a fresh connection per call, runs information_schema with strict
// statement + connect timeouts, returns at most LIMIT names. No pool — the
// dashboard touches this once per keystroke (debounced), and we don't want
// a long-lived client holding the customer's DSN open just for the UI.
//
// Search shape: ILIKE substring match on `<schema>.<name>`, parameterized
// to keep the query injection-safe and ESCAPEd so the customer's literal
// underscore doesn't get treated as a single-char wildcard. Empty q
// returns the alphabetical first batch — i.e., focusing an empty input
// gives the user something to browse.
//
// Output format matches the policy's TABLE_NAME_RE: `schema.table` for
// every row. Names that wouldn't pass validatePolicy (e.g. quoted/non-ASCII
// table names) are filtered out — no point suggesting something the form
// would refuse on save.

import postgres from "postgres";

const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/;
const DEFAULT_LIMIT = 50;
const MAX_QUERY_LENGTH = 64;

export interface ListTablesResult {
  tables: string[];
}

export async function listTables(
  dsn: string,
  { q = "", limit = DEFAULT_LIMIT }: { q?: string; limit?: number } = {},
): Promise<ListTablesResult> {
  const sql = postgres(dsn, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 5,
    prepare: false,
    onnotice: () => undefined,
  });
  try {
    // Cap the introspection query so a giant catalog can't tie up the
    // connection past the connect_timeout window.
    await sql.unsafe("SET statement_timeout = '5s'");

    // Postgres treats `_` and `%` as LIKE wildcards. Customers can put
    // either in real table names (rare) or in their typed query (more
    // likely the underscore). Escape both so the search is "literal
    // substring" instead of "single-char glob".
    const trimmed = q.trim().slice(0, MAX_QUERY_LENGTH);
    const pattern = `%${escapeLikeMetachars(trimmed)}%`;
    const hasQuery = trimmed.length > 0;

    // information_schema.tables filtered to user-visible objects. ORDER
    // BY before LIMIT means we always return a stable prefix of the
    // catalog rather than whatever the planner picked.
    const rows = hasQuery
      ? await sql<{ schema_name: string; table_name: string }[]>`
          SELECT
            table_schema AS schema_name,
            table_name   AS table_name
          FROM information_schema.tables
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            AND table_schema NOT LIKE 'pg_temp_%'
            AND table_schema NOT LIKE 'pg_toast%'
            AND table_type IN ('BASE TABLE', 'VIEW')
            AND (table_schema || '.' || table_name) ILIKE ${pattern} ESCAPE '\\'
          ORDER BY table_schema, table_name
          LIMIT ${limit}
        `
      : await sql<{ schema_name: string; table_name: string }[]>`
          SELECT
            table_schema AS schema_name,
            table_name   AS table_name
          FROM information_schema.tables
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            AND table_schema NOT LIKE 'pg_temp_%'
            AND table_schema NOT LIKE 'pg_toast%'
            AND table_type IN ('BASE TABLE', 'VIEW')
          ORDER BY table_schema, table_name
          LIMIT ${limit}
        `;

    const tables = rows
      .map((r) => `${r.schema_name}.${r.table_name}`)
      .filter((n) => TABLE_NAME_RE.test(n));

    return { tables };
  } finally {
    await sql.end({ timeout: 1 });
  }
}

function escapeLikeMetachars(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}
