// Dialect — abstraction seam introduced in 0.6.0 (Phase 0 of the multi-DB
// roadmap). As of 0.7.0 (Phase 1 PR2) there are two implementations: postgres
// (libpg_query) and mysql (node-sql-parser). Each owns parsing its native SQL,
// warming its parser, and projecting its native AST into the dialect-agnostic
// IR the policy rules consume. The rules never see an AST — adding a dialect
// is one adapter, not a rule change.
//
// `name` is the wire-level identifier matched by config (`dialect: postgres |
// mysql` in YAML). It's also stamped on DECIDED audit rows (0.7.0) so the
// audit log carries which dialect a given query was parsed under.
//
// `ParseResult.ast` is `unknown` — each dialect's native AST is private to its
// own normalize(). The engine routes parsing through `this.dialect.parse` and
// hands the AST straight to `this.dialect.normalize`, never reading it itself.

import type { ParseResult } from "./postgres/parse.ts";
import type { NormalizedProgram } from "../ir/types.ts";

export type DialectName = "postgres" | "mysql";

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
  // metadata SQL. Postgres + MySQL both emit the SQL-standard information_schema
  // queries; a future dialect that lacks information_schema (e.g. SQLite) emits
  // its own (sqlite_master / PRAGMA). Optional so a dialect can land its parser
  // before its metadata SQL. The built strings embed `schema`/`table` directly;
  // callers MUST pass identifier-validated values (the tool handlers enforce a
  // strict identifier regex before calling).
  listTablesSql?(schema: string): string;
  describeTableSql?(schema: string, table: string): string;
  // The schema the metadata tools query when the caller omits `schema`. Postgres
  // resolves it to `public` (its default search-path schema). MySQL conflates
  // schema and database, so `information_schema.table_schema` is the DATABASE
  // name — the default is the connected database (the MySQL dialect carries it),
  // NOT `public` (which would return zero rows). null when unknown (the strict
  // MySQL fallback with no DSN database); callers then fall back to `public`.
  defaultMetadataSchema?: string | null;
}
