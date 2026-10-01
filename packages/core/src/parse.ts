// The parse stage: the real Postgres parser, compiled to WebAssembly.

import { APPROVAL_SQL_MAX } from "@midplane/protocol";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import type { Node, SelectStmt } from "@pgsql/types";
import { fingerprintSync, loadModule, parseSync, scanSync } from "libpg-query";
import { Deny } from "./deny.ts";

let loaded = false;

/** Load the parser. Call once before `evaluate`; later calls are free. */
export async function loadParser(): Promise<void> {
  if (loaded) return;
  await loadModule();
  loaded = true;
}

function requireLoaded(): void {
  if (!loaded) throw new Error("call loadParser() before evaluate()");
}

/** Statements over 1 MiB are refused before parsing. */
export const MAX_SQL_BYTES = APPROVAL_SQL_MAX;

function parseError(detail: string): Deny {
  return new Deny(
    "parse_error",
    `Midplane denied this query because it could not be parsed as Postgres SQL (${detail}). Anything Midplane can't parse is denied.`,
  );
}

/** Parse exactly one statement, or deny. */
/** True when the statement's UTF-8 encoding exceeds MAX_SQL_BYTES. */
function tooLong(sql: string): boolean {
  // Every character is at least one byte, so only a short enough string needs encoding.
  return sql.length > MAX_SQL_BYTES || utf8ToBytes(sql).length > MAX_SQL_BYTES;
}

export function parseOne(sql: string): Node {
  requireLoaded();
  if (tooLong(sql)) throw parseError("longer than 1 MiB");
  if (sql.trim().length === 0) throw parseError("empty input");
  let stmts: { stmt?: Node }[];
  try {
    stmts = parseSync(sql).stmts ?? [];
  } catch (err) {
    throw parseError((err as { message?: string }).message ?? "syntax error");
  }
  if (stmts.length === 0) throw parseError("no statements");
  if (stmts.length > 1) {
    throw new Deny(
      "multi_statement",
      `Midplane denied this query because it contains ${stmts.length} statements. Send each statement as its own query; stacked statements are the classic SQL-injection vector and are always denied.`,
    );
  }
  const stmt = stmts[0]?.stmt;
  if (!stmt) throw parseError("no statements");
  return stmt;
}

/** Every statement of the text, or null when it doesn't parse or is too long. */
export function parseAll(sql: string): Node[] | null {
  requireLoaded();
  if (tooLong(sql)) return null;
  try {
    const stmts = (parseSync(sql).stmts ?? []).map((s) => s.stmt);
    if (stmts.length === 0 || stmts.some((s) => !s)) return null;
    return stmts as Node[];
  } catch {
    return null;
  }
}

/** A view definition as one SELECT, or null. */
export function parseSelect(sql: string): SelectStmt | null {
  requireLoaded();
  try {
    const stmts = parseSync(sql).stmts ?? [];
    const stmt = stmts[0]?.stmt;
    return stmts.length === 1 && stmt && "SelectStmt" in stmt
      ? stmt.SelectStmt
      : null;
  } catch {
    return null;
  }
}

/** The statement's libpg_query fingerprint, or null if it doesn't parse. */
export function fingerprint(sql: string): string | null {
  requireLoaded();
  if (tooLong(sql)) return null;
  try {
    return fingerprintSync(sql);
  } catch {
    return null;
  }
}

/** Each token's name (`SCONST`, `IDENT`, …) and text, or null when the text doesn't scan. */
export function scanTokens(
  sql: string,
): { tokenName: string; text: string; keyword: boolean }[] | null {
  requireLoaded();
  if (tooLong(sql)) return null;
  try {
    return scanSync(sql).tokens.map(
      (t: { tokenName: string; text: string; keywordName: string }) => ({
        tokenName: t.tokenName,
        text: t.text,
        keyword: t.keywordName !== "NO_KEYWORD",
      }),
    );
  } catch {
    return null;
  }
}
