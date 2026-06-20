// Cloud-side read-only floor + row bound for the masked preview.
//
// The engine's table_access (read), multi_statement, and guardrails rules are
// the REAL enforcement — this is defense-in-depth so a preview can never be the
// path that runs a write or ships an unbounded result set to the web process.
//
// We deliberately do NOT wrap the statement in a subquery to enforce these:
// `SELECT * FROM (<user sql>) LIMIT n` would strip the base-table
// RowDescription provenance (tableOid/attnum) the masker relies on, forcing
// every masked preview to fail closed. So we validate the statement in place
// and only ever append a TOP-LEVEL `LIMIT`, which preserves provenance.

// ── read-only floor ─────────────────────────────────────────────────────────

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

// Strip single-quoted string literals (with '' escapes), dollar-quoted strings,
// and comments so a keyword scan can't be fooled by `where note = 'select into'`
// or `/* into */`. Conservative — it can over-blank, which only ever makes the
// read-only check STRICTER (a false reject), never looser.
function blankStringsAndComments(sql: string): string {
  return sql
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, " ") // dollar-quoted
    .replace(/'(?:[^']|'')*'/g, " ") // single-quoted (handles '')
    .replace(/--[^\n]*/g, " ") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, " "); // block comments
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
  // `SELECT ... INTO new_table` is a top-level SelectStmt that CREATES a table —
  // it leads with SELECT but writes. The engine classifies it as a SELECT, so
  // it is not caught downstream; reject it here. In a SELECT, the INTO keyword
  // has no other meaning, so (after blanking strings/comments) a bare `into`
  // token means SELECT INTO.
  if (/\binto\b/i.test(blankStringsAndComments(head))) {
    return {
      ok: false,
      reason:
        "Preview can't run `SELECT … INTO` — that creates a table. Remove the INTO clause.",
    };
  }
  return { ok: true };
}

// ── row bound ───────────────────────────────────────────────────────────────

// Trailing top-level LIMIT / OFFSET / FETCH clause. A *trailing* limit is
// necessarily top-level (a subquery's limit lives inside parens, not at the end
// of the statement), so this is enough to know the result is already bounded.
const TRAILING_BOUND =
  /\blimit\s+(\d+|all)\b(\s+offset\s+\d+)?\s*$|\boffset\s+\d+\s*(rows?\s*)?$|\bfetch\s+(first|next)\b[\s\S]*\bonly\s*$/i;

/** Append a top-level `LIMIT <cap>` unless the statement already ends in a
 *  LIMIT/OFFSET/FETCH clause — so a `SELECT * FROM huge_table` preview can't
 *  execute unbounded and ship the whole result across the engine→web boundary.
 *
 *  A top-level LIMIT does not change the projection's column provenance, so
 *  masking still fires (unlike a subquery wrap). If the caller's statement DOES
 *  have a trailing bound we trust it; if our detection misses an exotic bound
 *  and we append anyway, the doubled clause is a parse error — the query never
 *  runs, so the failure mode is safe (a rejected preview), never unbounded. */
export function withRowLimit(sql: string, cap: number): string {
  // Strip a trailing `;` and trailing comments/whitespace so the bound check
  // and the appended clause land on the real end of the statement.
  let core = sql.trimEnd();
  for (;;) {
    const before = core;
    core = core
      .replace(/;\s*$/, "")
      .replace(/--[^\n]*$/, "")
      .replace(/\/\*[\s\S]*?\*\/\s*$/, "")
      .trimEnd();
    if (core === before) break;
  }
  if (TRAILING_BOUND.test(blankStringsAndComments(core))) return core;
  return `${core}\nLIMIT ${cap}`;
}
