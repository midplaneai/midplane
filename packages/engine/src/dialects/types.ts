// Dialect — abstraction seam introduced in 0.6.0 (Phase 0 of the multi-DB
// roadmap). For now there is only one implementation (postgres), so the
// interface stays minimal: parse + warmup + name. Subsequent phases will
// add normalized walker primitives once a second dialect (MySQL) exists to
// shape them against — abstracting earlier risks designing against a single
// concrete example.
//
// `name` is the wire-level identifier matched by config (`dialect: postgres`
// in YAML). It's also stamped on audit rows when multi-dialect ships, so
// the audit log carries which dialect a given query was parsed under.
//
// `ParseResult` is currently the Postgres-specific shape. When MySQL lands
// this will be genericized; for Phase 0 the rules consume PG ASTs directly
// and the type stays concrete. The seam in the Engine layer (`Engine.parse`
// routes through `this.dialect.parse`) is what Phase 1 will exploit.

import type { ParseResult } from "./postgres/parse.ts";

export type DialectName = "postgres";

export interface Dialect {
  readonly name: DialectName;
  parse(sql: string): Promise<ParseResult>;
  warmup(): Promise<void>;
}
