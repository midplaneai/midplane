// MySQL dialect — Phase 1 PR2 of the multi-DB roadmap.
//
// Wraps node-sql-parser (MySQL mode) and projects its AST into the same
// NormalizedProgram the Postgres adapter emits, so the unchanged, dialect-blind
// policy rules produce the same verdicts for MySQL.
//
// Unlike the Postgres dialect (a singleton), the MySQL dialect is parameterized
// by the connected database name: the cross-DB guard in normalize() needs it to
// distinguish an own-database qualifier (allowed, normalized to bare) from a
// foreign one (denied — a tenant bypass). The mcp-server's engine-factory builds
// one per DB with the database parsed from the DSN. The registry default
// singleton (`mysqlDialect`, database unknown) is the strict fallback used by
// getDialect()/tests: it rejects every explicit non-information_schema db
// qualifier.

import { parse, warmup } from "./parse.ts";
import { createNormalize } from "./normalize.ts";
import { listTablesSql, describeTableSql } from "./metadata.ts";
import type { Dialect } from "../types.ts";

export interface MysqlDialectOptions {
  // The database the engine's DSN connects to. Bare and own-database-qualified
  // table refs resolve against it; foreign-database refs are denied. Null when
  // unknown (registry default singleton / tests) → strict fallback.
  database?: string | null;
}

export function createMysqlDialect(opts: MysqlDialectOptions = {}): Dialect {
  const database = opts.database ?? null;
  return {
    name: "mysql",
    parse,
    warmup,
    normalize: createNormalize(database),
    listTablesSql,
    describeTableSql,
    // information_schema.table_schema is the database name in MySQL, so an
    // omitted `schema` defaults to the connected database (not `public`, which
    // would match nothing). null in the strict fallback (DSN named no database).
    defaultMetadataSchema: database,
  };
}

// Default singleton (database unknown). Registered in DIALECTS for getDialect()
// + used by tests; production engines get a DSN-bound dialect from the factory.
export const mysqlDialect: Dialect = createMysqlDialect();

export { parse, warmup } from "./parse.ts";
export type { MysqlParseResult } from "./parse.ts";
