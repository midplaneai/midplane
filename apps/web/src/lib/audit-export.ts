// Flatten + serialize audit list rows for download (CSV / JSON). Pure: no
// DB, no React — the route handler fetches AuditQueryListRow[] and a summary
// fn (so this module doesn't pull in the renderer) and hands them here.
//
// One output row per logical query/event, mirroring the table. Query rows
// carry SQL + decision; non-query event rows (token/policy) carry an event
// summary in the `event` column and leave SQL empty.

import type { AuditQueryListRow } from "./audit";
import { classifySql } from "./sql-kind";

export type ExportFormat = "csv" | "json";

// Stable column order — also the CSV header. Auditors diff these across
// pulls, so order is part of the contract; append, don't reorder.
const COLUMNS = [
  "time",
  "status",
  "kind",
  "agent",
  "agent_version",
  "intent",
  "intent_source",
  "database",
  "tenant_id",
  "decision",
  "decision_reason",
  "duration_ms",
  "query_id",
  "sql",
  "sql_fingerprint",
  "event",
] as const;

type Column = (typeof COLUMNS)[number];
export type ExportRecord = Record<Column, string>;

export function toExportRecords(
  rows: readonly AuditQueryListRow[],
  summarize: (row: AuditQueryListRow) => string,
): ExportRecord[] {
  return rows.map((r) => {
    // Event rows (token/policy) carry a null query_id and no SQL.
    const isEvent = r.queryId === null;
    return {
      time: r.startedAt.toISOString(),
      status: r.status,
      kind: isEvent ? "" : (classifySql(r.sqlRaw) ?? ""),
      agent: r.agentName ?? "",
      agent_version: r.agentVersion ?? "",
      intent: r.agentIntent ?? "",
      intent_source: r.intentSource ?? "",
      database: r.database,
      tenant_id: r.tenantId,
      decision: r.decision ?? "",
      decision_reason: r.decisionReason ?? "",
      duration_ms: r.execMs == null ? "" : String(r.execMs),
      query_id: r.queryId ?? "",
      sql: isEvent ? "" : (r.sqlRaw ?? ""),
      sql_fingerprint: r.sqlFingerprint ?? "",
      event: isEvent ? summarize(r) : "",
    };
  });
}

export function recordsToCsv(records: readonly ExportRecord[]): string {
  const lines = [COLUMNS.join(",")];
  for (const rec of records) {
    lines.push(COLUMNS.map((c) => csvCell(rec[c])).join(","));
  }
  // CRLF line endings — RFC 4180, and what Excel expects.
  return lines.join("\r\n") + "\r\n";
}

export function recordsToJson(records: readonly ExportRecord[]): string {
  return JSON.stringify(records, null, 2);
}

// Quote when the value contains a delimiter, quote, or newline; escape
// embedded quotes by doubling (RFC 4180). Also guard against CSV-injection:
// a leading =/+/-/@ can be interpreted as a formula by spreadsheet apps, so
// prefix those with a single quote.
function csvCell(value: string): string {
  let v = value;
  if (/^[=+\-@]/.test(v)) v = `'${v}`;
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}
