// libpg-query wrapper.
//
// Day 0 spike findings:
//   - API is `parseSync` after `await loadModule()`. Not `parseQuery`.
//   - `loadModule()` warms the WASM module (~50-100ms one-time).
//   - Empty input throws "Query cannot be empty"; bad SQL throws SqlError.

import { loadModule, parseSync } from "libpg-query";
import { ParserCrashedError } from "../errors.ts";

let warmupPromise: Promise<void> | null = null;

export function warmup(): Promise<void> {
  if (!warmupPromise) {
    warmupPromise = (async () => {
      await loadModule();
      // Pay the WASM compilation cost up front.
      parseSync("SELECT 1");
    })();
  }
  return warmupPromise;
}

// Parse-result discriminated union. Engine treats `ok: false` as a
// policy_rule=parse_error denial (not an exception).
export type ParseResult =
  | { ok: true;  ast: PgParseTree }
  | { ok: false; error: string };

// PgParseTree shape mirrors libpg-query's WASM output. We don't import the
// generated @pgsql/types because the shape we care about is dictated by
// what the visitor walks, not by the generated TS bindings.
export interface PgParseTree {
  version: number;
  stmts: Array<{ stmt: Record<string, unknown> }>;
}

const MAX_SQL_BYTES = 1_048_576; // 1 MiB cap — matches AttemptedPayload.sql_raw schema cap

export async function parse(sql: string): Promise<ParseResult> {
  await warmup();

  if (sql.length > MAX_SQL_BYTES) {
    return { ok: false, error: `sql exceeds ${MAX_SQL_BYTES} bytes` };
  }
  if (sql.trim().length === 0) {
    return { ok: false, error: "empty input" };
  }

  try {
    const ast = parseSync(sql) as PgParseTree;
    if (!ast || !Array.isArray(ast.stmts)) {
      return { ok: false, error: "parser returned no statements" };
    }
    return { ok: true, ast };
  } catch (err) {
    // libpg-query's SqlError class is the expected case (bad SQL).
    // Anything else (WASM panic, OOM) is a real crash — surface as ParserCrashedError.
    const name = (err as { name?: string })?.name ?? "";
    const msg = (err as { message?: string })?.message ?? String(err);
    if (name === "SqlError" || /syntax error|parse error|query cannot be empty/i.test(msg)) {
      return { ok: false, error: msg };
    }
    throw new ParserCrashedError(msg, err);
  }
}
