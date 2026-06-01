// Dialect registry — config (`dialect: postgres`) maps to a concrete
// `Dialect` here. Currently only postgres; adding a dialect = adding a
// `dialects/<name>/` directory + an entry to `DIALECTS` below.

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
