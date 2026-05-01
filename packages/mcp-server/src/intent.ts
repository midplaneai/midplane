// Per-call agent-intent resolution.
//
// There is no standards-aligned "what is this agent trying to do?" field
// that every MCP/HTTP client populates today. Rather than pretending one
// channel is canonical, we read three in priority order and stamp the
// channel that won onto the audit row so the cloud UI can nudge customers
// toward the standards-aligned slot.
//
// Priority (first non-empty wins):
//   1. MCP `_meta.intent` — MCP reserves `_meta` on requests for
//      implementation-specific data; this is the standards-aligned slot.
//   2. SQL comment hint — `/* midplane:intent="..." */` or
//      `-- midplane:intent: ...` at the head of the query. Trivial for any
//      client to emit, survives proxies. Stripped from the SQL before it
//      reaches the database (don't change query semantics — just don't
//      send the hint downstream).
//   3. HTTP header `X-Midplane-Intent` — for non-MCP HTTP callers. Lowest
//      priority because intermediaries can strip headers.
//
// Validation: trim, drop control chars, cap at 500 chars (truncate — don't
// reject the query). Empty after sanitization is treated as absent so a
// blank `_meta.intent: ""` falls through to the SQL comment / header
// channels rather than masking them.

import { IntentSource, type IntentSource as IntentSourceType } from "@midplane/engine";

export const INTENT_HEADER = "x-midplane-intent";
export const INTENT_MAX_LENGTH = 500;

// Header maps from node:http have lowercase keys (per the spec). The MCP
// SDK exposes incoming headers via `RequestInfo.headers` as a value of
// `string | string[] | undefined`. Accept either by normalizing to the
// first non-empty string.
type IsomorphicHeaders = Record<string, string | string[] | undefined>;

export interface IntentResolutionInput {
  // Raw `_meta` object from `RequestHandlerExtra._meta`. Only the `intent`
  // key is read; other keys are ignored so future MCP `_meta` extensions
  // don't accidentally collide.
  meta?: Record<string, unknown> | undefined;
  // SQL the agent supplied. If a recognized comment hint is at the head,
  // the resolver strips it and returns the cleaned SQL via `cleanSql`.
  // For server-generated SQL (list_tables, describe_table) the comment
  // channel never matches so the original string flows through unchanged.
  sql: string;
  // Incoming HTTP headers, when the call arrived over the HTTP transport.
  // Stdio callers leave this undefined — header channel simply doesn't
  // fire.
  headers?: IsomorphicHeaders | undefined;
}

export interface IntentResolution {
  // The SQL that should be forwarded to the engine. Identical to the
  // input `sql` unless an SQL-comment hint was stripped.
  cleanSql: string;
  // Resolved intent + the channel that won. Null when no channel
  // populated a non-empty value.
  intent:
    | { value: string; source: IntentSourceType }
    | null;
}

export function resolveAgentIntent(input: IntentResolutionInput): IntentResolution {
  // Channel 1: MCP `_meta.intent`. The MCP spec reserves `_meta` on
  // requests for implementation-specific data; first-class slot.
  const metaIntent = sanitizeIntent(readMetaIntent(input.meta));
  if (metaIntent !== null) {
    // We don't strip the SQL comment in this branch even if one was
    // present — a meta-supplied intent is the agent's authoritative
    // declaration, and downstream the comment is harmless to forward.
    // Only strip when the SQL comment is what populated `agent_intent`.
    return {
      cleanSql: input.sql,
      intent: { value: metaIntent, source: IntentSource.MCP_META },
    };
  }

  // Channel 2: SQL comment hint at the head of the query. We always
  // attempt extraction so the comment is stripped from the forwarded SQL
  // even when there's no other channel — agents that fall back to this
  // shape expect the hint to not survive into the database.
  const sqlExtract = extractSqlCommentIntent(input.sql);
  if (sqlExtract.intent !== null) {
    return {
      cleanSql: sqlExtract.cleanSql,
      intent: {
        value: sqlExtract.intent,
        source: IntentSource.SQL_COMMENT,
      },
    };
  }

  // Channel 3: HTTP header.
  const headerIntent = sanitizeIntent(readHeaderIntent(input.headers));
  if (headerIntent !== null) {
    return {
      cleanSql: input.sql,
      intent: { value: headerIntent, source: IntentSource.HTTP_HEADER },
    };
  }

  return { cleanSql: input.sql, intent: null };
}

function readMetaIntent(meta: Record<string, unknown> | undefined): string | null {
  if (!meta) return null;
  const v = meta.intent;
  if (typeof v !== "string") return null;
  return v;
}

function readHeaderIntent(
  headers: IsomorphicHeaders | undefined,
): string | null {
  if (!headers) return null;
  // Header maps may be case-insensitive (node:http lowercases on receive)
  // but we don't depend on that — scan keys explicitly so future SDK
  // changes that pass through a case-preserving Headers shape don't lose
  // the value.
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== INTENT_HEADER) continue;
    const raw = headers[key];
    if (Array.isArray(raw)) {
      // Per RFC 7230 a multi-valued header may be comma-joined or sent
      // as repeated lines. Either way, take the first non-empty entry —
      // intent is a single statement, not a list.
      for (const v of raw) {
        if (typeof v === "string" && v.trim().length > 0) return v;
      }
      return null;
    }
    if (typeof raw === "string") return raw;
  }
  return null;
}

// Trim, strip control chars (0x00-0x1F + 0x7F including tab/LF/CR — agent
// intent is meant to render as a single audit-log cell, not a multi-line
// block), truncate to INTENT_MAX_LENGTH. Returns null if the result is
// empty after sanitization.
function sanitizeIntent(raw: string | null): string | null {
  if (raw === null) return null;
  const stripped = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (stripped.length === 0) return null;
  return stripped.length > INTENT_MAX_LENGTH
    ? stripped.slice(0, INTENT_MAX_LENGTH)
    : stripped;
}

// Recognized SQL-comment hint shapes:
//   /* midplane:intent="..." */
//   /* midplane:intent='...' */
//   -- midplane:intent: ...
//
// Must appear at the *head* of the query — i.e. before the first
// non-comment token. We walk leading whitespace and comments, looking for
// a midplane hint among them. Only the matched hint comment is stripped
// from the returned `cleanSql`; any other head comments (optimizer hints
// like `/*+ IndexScan(users) */`, proxy directives, custom planner
// pragmas) are preserved verbatim because they can affect execution
// behavior. Comments mid-query are also left untouched — they're part of
// the agent's SQL.
export function extractSqlCommentIntent(sql: string): {
  cleanSql: string;
  intent: string | null;
} {
  let i = 0;
  let intent: string | null = null;
  // Byte range of the matched midplane hint comment (and the line
  // terminator immediately after a `--` line comment) — only this slice
  // is removed from cleanSql.
  let hintStart = -1;
  let hintEnd = -1;

  while (i < sql.length) {
    // Skip whitespace.
    if (/\s/.test(sql[i]!)) {
      i++;
      continue;
    }

    // Block comment.
    if (sql[i] === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) break; // unterminated — leave for the parser to reject
      const body = sql.slice(i + 2, end);
      const match = body.match(
        /^\s*midplane\s*:\s*intent\s*=\s*(?:"([^"]*)"|'([^']*)')\s*$/i,
      );
      if (match && intent === null) {
        intent = sanitizeIntent(match[1] ?? match[2] ?? "");
        hintStart = i;
        hintEnd = end + 2;
      }
      i = end + 2;
      continue;
    }

    // Line comment.
    if (sql[i] === "-" && sql[i + 1] === "-") {
      const eol = findLineEnd(sql, i + 2);
      const body = sql.slice(i + 2, eol);
      const match = body.match(/^\s*midplane\s*:\s*intent\s*:\s*(.*)$/i);
      if (match && intent === null) {
        intent = sanitizeIntent(match[1] ?? "");
        hintStart = i;
        // Include the trailing line terminator(s) in the strip range so
        // the first remaining statement isn't preceded by a phantom
        // blank line.
        let after = eol;
        while (after < sql.length && (sql[after] === "\n" || sql[after] === "\r")) after++;
        hintEnd = after;
      }
      i = eol;
      while (i < sql.length && (sql[i] === "\n" || sql[i] === "\r")) i++;
      continue;
    }

    break;
  }

  if (intent === null) {
    return { cleanSql: sql, intent: null };
  }

  // Splice out only the recognized hint, plus any whitespace immediately
  // following it (so we don't leave a double-space where the comment
  // used to sit between two other tokens). Preserves leading content and
  // any non-midplane comments at the head verbatim.
  let trailingWsEnd = hintEnd;
  while (
    trailingWsEnd < sql.length &&
    /\s/.test(sql[trailingWsEnd]!)
  ) {
    trailingWsEnd++;
  }
  return {
    cleanSql: sql.slice(0, hintStart) + sql.slice(trailingWsEnd),
    intent,
  };
}

function findLineEnd(sql: string, start: number): number {
  for (let i = start; i < sql.length; i++) {
    if (sql[i] === "\n" || sql[i] === "\r") return i;
  }
  return sql.length;
}
