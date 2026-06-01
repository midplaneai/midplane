// Postgres dialect — the original (and currently only) Midplane dialect.
//
// Wraps `libpg-query` (the actual Postgres C parser, WASM-compiled). The
// `Dialect` interface here is what `Engine` consumes; everything else in
// this directory (parse, visitor, statement classification) is the PG-
// specific machinery the rules walk against.
//
// Re-exports the underlying parse/warmup/types so the public engine API
// (`@midplane/engine`) can surface them unchanged from 0.5.x.

import { parse, warmup } from "./parse.ts";
import type { Dialect } from "../types.ts";

export const postgresDialect: Dialect = {
  name: "postgres",
  parse,
  warmup,
};

export { parse, warmup } from "./parse.ts";
export type { ParseResult, PgParseTree } from "./parse.ts";
export { walk, isStatementKind } from "./visitor.ts";
export type { VisitorRule, VisitorScope } from "./visitor.ts";
