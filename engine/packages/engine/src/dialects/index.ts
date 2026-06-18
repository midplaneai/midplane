// Dialect registry — config (`dialect: postgres`) maps to a concrete `Dialect`
// here. The seam exists so a future dialect is one `dialects/<name>/` directory
// + an entry in `DIALECTS` below, with zero policy-rule changes. Ships
// Postgres-only today; Postgres is stateless, so its singleton is what every PG
// engine uses.

import { postgresDialect } from "./postgres/index.ts";
import type { Dialect, DialectName } from "./types.ts";

export const DIALECTS: Record<DialectName, Dialect> = {
  postgres: postgresDialect,
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
export type { Dialect, DialectName } from "./types.ts";
