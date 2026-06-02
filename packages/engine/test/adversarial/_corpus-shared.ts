// Parameterized cross-dialect adversarial corpus (Phase 1 PR2).
//
// The compounding moat of multi-dialect Midplane: ONE corpus, run through every
// dialect, asserting the SAME policy verdict from the SAME (unchanged) rules.
// Each case carries its SQL per dialect (`null` = skip on that dialect, for
// dialect-specific syntax) plus the single expected verdict that must hold on
// every dialect that runs it. cross-dialect.test.ts builds a Postgres engine and
// a MySQL engine over the SHARED policy below and asserts each case's verdict on
// both — proving the IR seam makes the rules genuinely dialect-blind.
//
// We assert decision + rule name (not the human message): the parse_error
// message embeds the dialect's parser error text, which legitimately differs.
// Everything else (table_access / tenant_scope / multi_statement verdicts) is
// identical across dialects by construction.

import type { DialectName } from "../../src/dialects/types.ts";
import type { TableAccessConfig } from "../../src/policy/rules/table-access.ts";
import type { TenantScopeConfig } from "../../src/policy/rules/tenant-scope.ts";

// Shared policy the whole corpus runs against.
//   users     read_write + tenant-scoped on org_id
//   posts     read       + tenant-scoped on org_id
//   webhooks  read_write + NOT scoped
//   audit_log deny        + NOT scoped
//   (default) read        + NOT scoped
export const CORPUS_TABLE_ACCESS: TableAccessConfig = {
  default: "read",
  tables: {
    users: "read_write",
    posts: "read",
    webhooks: "read_write",
    audit_log: "deny",
  },
};

export const CORPUS_TENANT_SCOPE: TenantScopeConfig = {
  defaultColumn: null,
  overrides: { users: "org_id", posts: "org_id" },
  exempt: [],
};

export const CORPUS_TENANT_ID = "42";

// The connected database name for the MySQL dialect's cross-DB guard. Own-db
// qualifiers (`appdb.users`) are allowed; foreign (`otherdb.users`) denied.
export const CORPUS_MYSQL_DATABASE = "appdb";

export type ExpectedVerdict =
  | { decision: "ALLOW" }
  | { decision: "DENY"; reason: string };

export interface CorpusCase {
  name: string;
  sql: Record<DialectName, string | null>;
  expect: ExpectedVerdict;
}

const ALLOW: ExpectedVerdict = { decision: "ALLOW" };
const deny = (reason: string): ExpectedVerdict => ({ decision: "DENY", reason });

// Same SQL text on both dialects (the common case).
const both = (sql: string): Record<DialectName, string> => ({ postgres: sql, mysql: sql });

const TABLE_ACCESS = "table_access";
const TENANT_SCOPE = "tenant_scope_missing";
const MULTI_STATEMENT = "multi_statement";
const PARSE_ERROR = "parse_error";

export const SHARED_CORPUS: CorpusCase[] = [
  // ── tenant_scope on SELECT ───────────────────────────────────────────────
  { name: "select scoped table with correct predicate", sql: both("SELECT id FROM users WHERE org_id = 42"), expect: ALLOW },
  { name: "select scoped table, string-literal tenant", sql: both("SELECT id FROM users WHERE org_id = '42'"), expect: ALLOW },
  { name: "select scoped table missing predicate", sql: both("SELECT id FROM users"), expect: deny(TENANT_SCOPE) },
  { name: "select scoped table wrong tenant literal", sql: both("SELECT id FROM users WHERE org_id = 99"), expect: deny(TENANT_SCOPE) },
  { name: "select scoped table, OR does not strengthen", sql: both("SELECT id FROM users WHERE org_id = 42 OR 1 = 1"), expect: deny(TENANT_SCOPE) },
  { name: "select scoped table, AND of predicates", sql: both("SELECT id FROM users WHERE org_id = 42 AND id = 7"), expect: ALLOW },
  { name: "select aliased scoped table qualified predicate", sql: both("SELECT u.id FROM users u WHERE u.org_id = 42"), expect: ALLOW },
  { name: "select second scoped table (read) missing predicate", sql: both("SELECT id FROM posts"), expect: deny(TENANT_SCOPE) },
  { name: "select unscoped table allowed", sql: both("SELECT id FROM webhooks"), expect: ALLOW },
  { name: "select default-policy table (read, unscoped)", sql: both("SELECT id FROM widgets"), expect: ALLOW },

  // ── table_access reads/writes ────────────────────────────────────────────
  { name: "select deny-listed table", sql: both("SELECT id FROM audit_log"), expect: deny(TABLE_ACCESS) },
  { name: "write to read-only scoped table denied (write beats scope)", sql: both("UPDATE posts SET body = 'x' WHERE org_id = 42"), expect: deny(TABLE_ACCESS) },
  { name: "delete deny-listed table", sql: both("DELETE FROM audit_log WHERE id = 1"), expect: deny(TABLE_ACCESS) },

  // ── DML on scoped read_write table (tenant_scope still applies) ───────────
  { name: "update scoped rw table with predicate", sql: both("UPDATE users SET name = 'x' WHERE org_id = 42"), expect: ALLOW },
  { name: "update scoped rw table missing predicate", sql: both("UPDATE users SET name = 'x'"), expect: deny(TENANT_SCOPE) },
  { name: "delete scoped rw table with predicate", sql: both("DELETE FROM users WHERE org_id = 42"), expect: ALLOW },
  { name: "delete scoped rw table missing predicate", sql: both("DELETE FROM users"), expect: deny(TENANT_SCOPE) },
  { name: "update unscoped rw table no predicate needed", sql: both("UPDATE webhooks SET url = 'x'"), expect: ALLOW },
  { name: "delete unscoped rw table", sql: both("DELETE FROM webhooks WHERE id = 1"), expect: ALLOW },

  // ── INSERT tenant correctness ─────────────────────────────────────────────
  { name: "insert scoped table with correct tenant", sql: both("INSERT INTO users (id, org_id) VALUES (1, 42)"), expect: ALLOW },
  { name: "insert scoped table wrong tenant", sql: both("INSERT INTO users (id, org_id) VALUES (1, 99)"), expect: deny(TENANT_SCOPE) },
  { name: "insert scoped table missing scope column", sql: both("INSERT INTO users (id) VALUES (1)"), expect: deny(TENANT_SCOPE) },
  { name: "insert multi-row, one row wrong tenant", sql: both("INSERT INTO users (id, org_id) VALUES (1, 42), (2, 99)"), expect: deny(TENANT_SCOPE) },
  { name: "insert unscoped rw table", sql: both("INSERT INTO webhooks (id, url) VALUES (1, 'x')"), expect: ALLOW },
  { name: "insert into deny-listed table", sql: both("INSERT INTO audit_log (id) VALUES (1)"), expect: deny(TABLE_ACCESS) },

  // ── subqueries: outer scoped table must still carry the predicate ─────────
  { name: "subquery IN, outer scoped table unscoped", sql: both("SELECT id FROM users WHERE id IN (SELECT user_id FROM memberships WHERE org_id = 42)"), expect: deny(TENANT_SCOPE) },
  { name: "subquery IN, outer scoped table scoped", sql: both("SELECT id FROM users WHERE org_id = 42 AND id IN (SELECT user_id FROM memberships)"), expect: ALLOW },

  // ── UNION arms each independently scoped ─────────────────────────────────
  { name: "union both arms scoped", sql: both("SELECT id FROM users WHERE org_id = 42 UNION SELECT id FROM users WHERE org_id = 42"), expect: ALLOW },
  { name: "union one arm unscoped", sql: both("SELECT id FROM users WHERE org_id = 42 UNION SELECT id FROM users"), expect: deny(TENANT_SCOPE) },

  // ── CTE name vs. real table (self-shadow read bypass) ─────────────────────
  // A non-recursive CTE's name does NOT bind in its own body, so the body reads
  // the REAL table — which must still be policy-checked. A CTE named after a
  // denied table that reads that table in its body must DENY, not slip through
  // as a "CTE reference".
  { name: "cte named after a denied table, body reads the real table", sql: both("WITH audit_log AS (SELECT * FROM audit_log) SELECT * FROM audit_log"), expect: deny(TABLE_ACCESS) },
  { name: "distinct cte reading a denied table in its body", sql: both("WITH c AS (SELECT * FROM audit_log) SELECT * FROM c"), expect: deny(TABLE_ACCESS) },
  // Legitimate shadowing (CTE body reads nothing real) still allows — the fix
  // must not over-correct into denying every CTE whose name matches a table.
  { name: "cte shadows a denied table but body reads nothing real", sql: both("WITH audit_log AS (SELECT 1 AS id) SELECT * FROM audit_log"), expect: ALLOW },

  // ── multi-statement (the canonical SQLi vector) ──────────────────────────
  { name: "stacked statements", sql: both("SELECT 1; DROP TABLE users"), expect: deny(MULTI_STATEMENT) },
  { name: "stacked select/select", sql: both("SELECT id FROM users WHERE org_id = 42; SELECT id FROM webhooks"), expect: deny(MULTI_STATEMENT) },

  // ── information_schema discovery carve-out ───────────────────────────────
  { name: "information_schema.tables allowed under deny-default", sql: both("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"), expect: ALLOW },
  { name: "information_schema.columns allowed", sql: both("SELECT column_name FROM information_schema.columns WHERE table_name = 'users'"), expect: ALLOW },

  // ── no-table / trivial ────────────────────────────────────────────────────
  { name: "constant select, no table", sql: both("SELECT 1"), expect: ALLOW },

  // ── parse error (reason parity; message differs by dialect, not asserted) ─
  { name: "syntax error denied", sql: both("SELEKT 1"), expect: deny(PARSE_ERROR) },
];
