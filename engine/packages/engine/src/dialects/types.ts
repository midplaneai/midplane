// Dialect — abstraction seam introduced in 0.6.0 (Phase 0 of the multi-DB
// roadmap). Ships Postgres-only: the one implementation is `postgres`
// (libpg_query). The seam owns parsing native SQL, warming its parser, and
// projecting its native AST into the dialect-agnostic IR the policy rules
// consume. The rules never see an AST — a future dialect is one adapter, not a
// rule change. (A MySQL adapter is implemented + tested on a branch but held
// off the public build until demand pulls it; see the wedge decision.)
//
// `name` is the wire-level identifier matched by config (`dialect: postgres` in
// YAML). It's also stamped on DECIDED audit rows so the audit log carries which
// dialect a given query was parsed under (additive, forward-compatible).
//
// `ParseResult.ast` is `unknown` — each dialect's native AST is private to its
// own normalize(). The engine routes parsing through `this.dialect.parse` and
// hands the AST straight to `this.dialect.normalize`, never reading it itself.

import type { ParseResult } from "./postgres/parse.ts";
import type { NormalizedProgram } from "../ir/types.ts";

export type DialectName = "postgres";

export interface Dialect {
  readonly name: DialectName;
  parse(sql: string): Promise<ParseResult>;
  warmup(): Promise<void>;
  // Project a successfully-parsed native AST into the dialect-agnostic IR the
  // policy rules consume. Kept separate from parse() so the engine can still
  // fingerprint the native AST (computeFingerprint) unchanged. Must NEVER throw
  // on parsed-but-weird input — classify anything it can't model as
  // `unsupported` (fail-closed) instead.
  normalize(ast: unknown): NormalizedProgram;
  // SQL the metadata tools (list_tables / describe_table) run for schema
  // discovery, per dialect. The mcp-server reaches these through the registry's
  // EngineEntry (Engine.dialect is private), since `Engine` itself never builds
  // metadata SQL. Postgres emits the SQL-standard information_schema queries; a
  // future dialect that lacks information_schema (e.g. SQLite) emits its own
  // (sqlite_master / PRAGMA). Optional so a dialect can land its parser before
  // its metadata SQL. The built strings embed `schema`/`table` directly; callers
  // MUST pass identifier-validated values (the tool handlers enforce a strict
  // identifier regex before calling).
  listTablesSql?(schema: string): string;
  describeTableSql?(schema: string, table: string): string;
  // The schema the metadata tools query when the caller omits `schema`. Postgres
  // resolves it to `public` (its default search-path schema). A dialect whose
  // notion of "default schema" differs (e.g. one that conflates schema and
  // database) supplies its own here; null when unknown, and callers fall back to
  // `public`.
  defaultMetadataSchema?: string | null;
}
