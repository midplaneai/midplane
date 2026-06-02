// Dialect registry — config (`dialect: postgres | mysql`) maps to a concrete
// `Dialect` here. Adding a dialect = adding a `dialects/<name>/` directory + an
// entry to `DIALECTS` below.
//
// `DIALECTS`/`getDialect` return the default singletons. The MySQL singleton has
// no DSN context (database unknown → strict cross-DB rejection); production
// engines instead get a DSN-bound MySQL dialect via `createMysqlDialect` (the
// mcp-server factory parses the database from the DSN). Postgres is stateless,
// so its singleton is what every PG engine uses.

import { postgresDialect } from "./postgres/index.ts";
import { mysqlDialect } from "./mysql/index.ts";
import type { Dialect, DialectName } from "./types.ts";

export const DIALECTS: Record<DialectName, Dialect> = {
  postgres: postgresDialect,
  mysql: mysqlDialect,
};

export function getDialect(name: DialectName): Dialect {
  const d = DIALECTS[name];
  if (!d) {
    throw new Error(
      `Unknown dialect: "${name}". Supported: ${Object.keys(DIALECTS).join(", ")}.`,
    );
  }
  return d;
}

export { postgresDialect } from "./postgres/index.ts";
export { mysqlDialect, createMysqlDialect } from "./mysql/index.ts";
export type { MysqlDialectOptions } from "./mysql/index.ts";
export type { Dialect, DialectName } from "./types.ts";
