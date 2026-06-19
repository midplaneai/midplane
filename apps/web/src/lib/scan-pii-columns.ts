// PII exposure scan (design D1): introspect a project database's columns and
// flag the ones that look like personal data, so the dashboard can show "these
// columns your agent can read look like PII" and offer one-click masking.
//
// Same posture as list-tables.ts: a fresh single connection per call, strict
// connect + statement timeouts, information_schema only (NO customer row data
// is ever read — the classification is name + type heuristics, see
// pii-heuristics.ts). Returns the flagged columns plus a suggested transform;
// already-masked columns are merged in by the caller (it holds the policy).

import postgres from "postgres";

import { classifyColumn, type PiiMatch } from "./pii-heuristics.ts";

const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Defensive cap: a pathological catalog shouldn't stream unbounded rows.
const MAX_COLUMNS = 5000;

export interface ScannedColumn {
  /** "schema.table" — matches the column_masks policy key shape. */
  table: string;
  column: string;
  /** Postgres data type (information_schema.columns.data_type). */
  dataType: string;
  match: PiiMatch;
}

export interface ScanResult {
  /** Flagged (likely-PII) columns, sorted by table then column. */
  columns: ScannedColumn[];
  /** Total columns inspected — lets the UI say "7 of 142 look like PII". */
  scannedColumns: number;
}

export async function scanPiiColumns(dsn: string): Promise<ScanResult> {
  const sql = postgres(dsn, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 5,
    prepare: false,
    onnotice: () => undefined,
  });
  try {
    await sql.unsafe("SET statement_timeout = '5s'");

    // User-schema base tables + views, every column. System schemas are
    // excluded (no maskable customer values; the engine exempts them too).
    const rows = await sql<
      { schema_name: string; table_name: string; column_name: string; data_type: string }[]
    >`
      SELECT
        c.table_schema AS schema_name,
        c.table_name   AS table_name,
        c.column_name  AS column_name,
        c.data_type    AS data_type
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
        AND c.table_schema NOT LIKE 'pg_temp_%'
        AND c.table_schema NOT LIKE 'pg_toast%'
        AND t.table_type IN ('BASE TABLE', 'VIEW')
      ORDER BY c.table_schema, c.table_name, c.ordinal_position
      LIMIT ${MAX_COLUMNS}
    `;

    const columns: ScannedColumn[] = [];
    for (const r of rows) {
      const table = `${r.schema_name}.${r.table_name}`;
      // Only suggest columns the policy could actually store/serialize.
      if (!TABLE_NAME_RE.test(table) || !IDENT_RE.test(r.column_name)) continue;
      const match = classifyColumn(r.column_name, r.data_type);
      if (!match) continue;
      columns.push({ table, column: r.column_name, dataType: r.data_type, match });
    }

    columns.sort((a, b) =>
      a.table === b.table
        ? a.column < b.column
          ? -1
          : a.column > b.column
            ? 1
            : 0
        : a.table < b.table
          ? -1
          : 1,
    );

    return { columns, scannedColumns: rows.length };
  } finally {
    await sql.end({ timeout: 1 });
  }
}
