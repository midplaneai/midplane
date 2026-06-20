// Cloud-side read-only floor for the masked preview.
//
// The engine's table_access (read), multi_statement, and guardrails rules are
// the REAL enforcement — this is defense-in-depth so a preview can never be the
// path that runs a write against the customer DB. A plain top-level SELECT
// cannot perform DML in Postgres, so requiring a leading SELECT (after
// stripping leading comments) rejects INSERT/UPDATE/DELETE/DDL and
// data-modifying CTEs (which lead with WITH) before we ever spawn a container.
//
// We deliberately do NOT try to be a SQL parser here. Anything that slips past
// this floor still hits the engine's own deny rules; the point is to keep the
// obviously-destructive shapes from executing at all.

const LEADING_LINE_COMMENT = /^\s*--[^\n]*\n/;
const LEADING_BLOCK_COMMENT = /^\s*\/\*[\s\S]*?\*\//;

/** Strip leading SQL comments + whitespace so the keyword check sees the first
 *  real token (a query can be prefixed with a line or block comment). */
export function stripLeadingComments(sql: string): string {
  let s = sql;
  for (;;) {
    const before = s;
    s = s.replace(LEADING_LINE_COMMENT, "");
    s = s.replace(LEADING_BLOCK_COMMENT, "");
    if (s === before) break;
  }
  return s.trimStart();
}

export type ReadOnlyCheck = { ok: true } | { ok: false; reason: string };

export function isReadOnlySelect(sql: string): ReadOnlyCheck {
  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "Enter a SELECT statement to preview." };
  }
  const head = stripLeadingComments(trimmed);
  if (!/^select\b/i.test(head)) {
    return {
      ok: false,
      reason:
        "Preview runs read-only SELECT statements only — select the masked columns directly from their table.",
    };
  }
  return { ok: true };
}
