// Normalized IR — the dialect-agnostic shape the policy rules consume.
//
// Introduced in Phase 1 of the multi-DB roadmap. Before this, each rule
// walked raw libpg_query AST nodes (RangeVar, A_Expr, …) inside its own
// finalize(). Now each dialect produces a `NormalizedProgram` via
// `Dialect.normalize(ast)` and the rules read ONLY this IR — no dialect ever
// leaks an AST node name into the policy layer. Adding a dialect = one adapter
// that emits this shape; the rules never change.
//
// Shape rationale (refined during the PR1 port against the verdict-equivalence
// harness): the IR is a flat CHECK SEQUENCE, not a per-statement summary. Two
// fidelity facts forced this:
//   • The rules check EVERY relevant node anywhere in the tree, not just the
//     top-level statement. table_access checks every write-target node and
//     every read RangeVar (incl. those nested in CTEs/subqueries); tenant_scope
//     checks every SELECT/UPDATE/DELETE/INSERT/MERGE node (incl. a write hidden
//     in a CTE under a top-level SELECT). A per-top-level-statement summary
//     can't represent those nested checks.
//   • The deny MESSAGE is the FIRST failing check in the dialect's walk order.
//     Emitting checks as an ordered sequence lets the rule return on the first
//     failure and reproduce that cause byte-for-byte.
// So the adapter externalizes its walk as ordered check lists; the rules are
// thin replayers. This is maximally faithful AND dialect-agnostic — a MySQL
// adapter emits the same TableRef/EqualityPredicate/InsertShape checks from its
// own AST.
//
// Fail-closed: anything a dialect parser can't faithfully model becomes an
// `unsupported` entry, which every rule DENIES — never a silent allow. The
// Postgres adapter (libpg_query is the real PG parser) emits none.

export interface TableRef {
  // The schema/database qualifier as written in source; null = no explicit
  // qualifier. Each dialect resolves null per its own rules (Postgres: implicit
  // `public`; MySQL: the connected database). resolvePermission / toScopedRef
  // operate on this field uniformly across dialects.
  schema: string | null;
  relname: string;
  effectiveName: string; // alias if present, else relname (predicate-qualifier match)
  alias: string | null;
}

// An equality predicate reachable through AND-only conjunctions (OR/NOT do not
// strengthen the constraint and are excluded by the adapter). `literal` is the
// stringified constant: integer→String(n), string→sval, float→fval — mirroring
// the legacy extractConstLiteral so comparisons are identical.
export interface EqualityPredicate {
  qualifier: string | null; // table alias / immediate qualifier, or null if unqualified
  column: string;
  literal: string;
}

// One table_access check, in the adapter's depth-first walk order. The rule
// replays the sequence and denies on the first failure, so the surfaced cause
// (and its message) matches the legacy single-walk first-cause exactly.
//   • "write"     — a write-target table; requires read_write.
//   • "read"      — a read-position table; requires read or read_write.
//                   CTE-shadowed references are already EXCLUDED by the adapter.
//   • "no_target" — a state-mutating statement node with no per-table target
//                   the policy can grant (SET, CALL, DO, COPY, LOCK, NOTIFY,
//                   GRANT-on-non-table, …); always denies. `keyword` is the
//                   human statement keyword for the message (legacy humanStatement).
export type AccessCheck =
  | { kind: "write"; ref: TableRef }
  | { kind: "read"; ref: TableRef }
  | { kind: "no_target"; keyword: string };

// Shape needed to verify tenant-scope on INSERT. `valuesRows` is the per-VALUES
// -row literal at each column position (null where not a constant); the whole
// field is null for forms we can't verify statically (INSERT … SELECT) and the
// rule denies. `onConflictDoUpdate` is the only ON CONFLICT variant the rule
// branches on (DO UPDATE re-opens the row to writes); DO NOTHING / none are
// indistinguishable to the rule, so a boolean suffices.
export interface InsertShape {
  target: TableRef;
  hasExplicitColumns: boolean;
  columns: string[];
  valuesRows: (string | null)[][] | null;
  onConflictDoUpdate: boolean;
}

// One tenant_scope check unit, in the adapter's recursion order. Each is
// checked independently (matching the legacy per-node checks); the rule denies
// on the first failure.
//   • "scope"  — a SELECT/UPDATE/DELETE scope: the base tables visible AT THIS
//                scope (UNFILTERED by config — the rule applies requiredColumnFor)
//                plus the AND-only equality predicates at this scope. Subquery /
//                UNION-arm / CTE-body scopes appear as their own separate units.
//   • "insert" — an INSERT whose tenant-correctness is verified from InsertShape.
//   • "merge"  — a MERGE; blanket-denied when its target is tenant-scoped.
export type ScopeUnit =
  | { kind: "scope"; tables: TableRef[]; predicates: EqualityPredicate[] }
  | { kind: "insert"; shape: InsertShape }
  | { kind: "merge"; target: TableRef };

// A statement a dialect parser could not faithfully model. `touchedTables`
// carries the tables it could identify so tenant_scope fails closed when one is
// scoped (tenantScope.evaluateIR iterates `unsupported`); table_access denies it
// via a synthetic no_target AccessCheck the adapter ALSO emits. Adapters that
// emit an UnsupportedStatement MUST also emit that no_target so both rules deny.
export interface UnsupportedStatement {
  keyword: string;
  touchedTables: TableRef[];
}

export interface NormalizedProgram {
  statementCount: number; // top-level statements; >1 ⇒ multi_statement deny
  // Audit statement_type: a canonical uppercase SQL statement keyword
  // (SELECT / INSERT / UPDATE / DELETE / CREATE / DROP / ALTER / MERGE / CALL / …)
  // that each dialect maps deterministically and consistently across equivalent
  // inputs. (The Postgres adapter derives it as the first /Stmt$/ node in the
  // libpg visitor walk, stripped + uppercased — an implementation detail of that
  // adapter, not part of the contract.) null only when there are no statements.
  auditStatementType: string | null;
  // Audit tables_touched: every relname the shared visitor surfaces (incl. CTE
  // names and synthesized DML targets), Set-deduped in first-encounter order.
  // The accumulator reads this verbatim so the field does not move.
  allRelnames: string[];
  accessChecks: AccessCheck[]; // for table_access
  scopeUnits: ScopeUnit[]; // for tenant_scope
  unsupported: UnsupportedStatement[]; // fail-closed (empty for the Postgres adapter)
}
