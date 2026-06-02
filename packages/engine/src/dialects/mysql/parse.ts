// node-sql-parser wrapper (MySQL mode).
//
// The MySQL analog of dialects/postgres/parse.ts. node-sql-parser is a pure-JS
// PEG parser (one transitive dep, big-integer), pinned to an EXACT version in
// package.json: a parser-fidelity regression on a minor bump is a silent-bypass
// vector for a security tool, so no `^`.
//
// Fidelity contract (multi-db-phase1-plan §3): node-sql-parser is a good-enough
// in-process parser, NOT a security oracle. The guarantee is fail-closed —
// anything it cannot faithfully model becomes `unsupported` in normalize() and
// is DENIED. We accept false denials (exotic-but-safe queries blocked) to never
// accept a false allow. A construct it parses *wrong* (benign-looking but
// malicious) is caught only by the adversarial corpus; the Phase-2 sqlglot
// sidecar is the escape hatch (a pure parse/normalize swap — rules never change).
//
// Like the PG wrapper, this NEVER throws on bad SQL: a parse failure becomes
// `{ ok: false, error }`, which the engine treats as a parse_error DENY. A
// genuine parser crash is surfaced as ParserCrashedError by the engine's
// try/catch around dialect.parse.

import { Parser } from "node-sql-parser";
import type { ParseResult } from "../postgres/parse.ts";

// node-sql-parser's astify() returns a single AST object for one statement, or
// an array for multiple (and for a single statement with a trailing semicolon).
// We keep whichever shape it returns as the opaque `ast`; normalize() handles
// both (statementCount = Array.isArray(ast) ? ast.length : 1). The native shape
// is private to dialects/mysql/normalize.ts — the only MySQL file that reads it.
export type MysqlAst = unknown;

export type MysqlParseResult =
  | { ok: true; ast: MysqlAst }
  | { ok: false; error: string };

const OPT = { database: "MySQL" } as const;
const MAX_SQL_BYTES = 1_048_576; // 1 MiB cap — matches the PG wrapper + audit cap.

// One reusable parser instance. astify() holds no cross-call state, so a single
// instance is safe and skips per-query allocation.
const parser = new Parser();

// Memoized warmup. node-sql-parser is synchronous JS (no WASM module to load),
// so this just pays the one-time PEG JIT cost up front to match the PG dialect's
// warmup contract (the engine calls warmup() implicitly via parse()).
let warmupPromise: Promise<void> | null = null;

export function warmup(): Promise<void> {
  if (!warmupPromise) {
    warmupPromise = (async () => {
      try {
        parser.astify("SELECT 1", OPT);
      } catch {
        // Warmup is best-effort; a failure here never blocks parsing.
      }
    })();
  }
  return warmupPromise;
}

export async function parse(sql: string): Promise<ParseResult> {
  await warmup();

  if (sql.length > MAX_SQL_BYTES) {
    return { ok: false, error: `sql exceeds ${MAX_SQL_BYTES} bytes` };
  }
  if (sql.trim().length === 0) {
    return { ok: false, error: "empty input" };
  }

  try {
    const ast = parser.astify(sql, OPT) as MysqlAst;
    // astify throws on truly empty/comment-only input, so a returned AST is
    // always at least one statement. An empty array would still be a coherent
    // "no statements" — treat it as a parse failure so the pipeline never sees
    // a no-op query (mirrors the PG wrapper's stmts.length === 0 guard).
    if (Array.isArray(ast) && ast.length === 0) {
      return { ok: false, error: "no statements" };
    }
    return { ok: true, ast };
  } catch (err) {
    // node-sql-parser throws a PEG SyntaxError (or similar) on bad SQL. Surface
    // it as a parse failure, never a thrown exception — the engine's parse_error
    // rule denies it. (This is also the fail-closed path for any MySQL construct
    // node-sql-parser can't parse at all.)
    const msg = (err as { message?: string })?.message ?? String(err);
    return { ok: false, error: msg };
  }
}
