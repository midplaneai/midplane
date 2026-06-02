// MySQL-only adversarial safety cases.
//
// The dialect-specific half of the corpus: constructs that exist only in MySQL
// (USE, cross-database refs, ON DUPLICATE KEY UPDATE, REPLACE, backticks,
// multi-table UPDATE/DELETE) and the fail-closed guarantees around them. The
// shared cross-dialect cases live in cross-dialect.test.ts; these can't be
// expressed identically on Postgres, so they get their own bucket.
//
// Trust posture: anything that could escape the connected-database namespace or
// that we can't statically verify is DENIED. We test both directions — the safe
// form ALLOWs, the bypass form DENIes.

import { describe, expect, test } from "bun:test";
import { Engine } from "../../src/engine.ts";
import { createMysqlDialect } from "../../src/dialects/mysql/index.ts";
import type { TenantScopeConfig } from "../../src/policy/rules/tenant-scope.ts";
import type { TableAccessConfig } from "../../src/policy/rules/table-access.ts";
import { parseError } from "../../src/policy/rules/parse-error.ts";
import { multiStatement } from "../../src/policy/rules/multi-statement.ts";
import { tableAccess } from "../../src/policy/rules/table-access.ts";
import { tenantScope } from "../../src/policy/rules/tenant-scope.ts";
import { MemoryAuditWriter, MockExecutor, StubCredentialStore } from "../_helpers.ts";

const TABLE_ACCESS: TableAccessConfig = {
  default: "read",
  tables: { users: "read_write", webhooks: "read_write", accounts: "read", audit_log: "deny" },
};
const TENANT_SCOPE: TenantScopeConfig = {
  defaultColumn: null,
  overrides: { users: "org_id" },
  exempt: [],
};

function makeMysqlEngine(database: string | null = "appdb"): Engine {
  let counter = 0;
  return new Engine({
    policy: {
      rules: [
        parseError(),
        multiStatement(),
        tableAccess(() => TABLE_ACCESS),
        tenantScope((): TenantScopeConfig => TENANT_SCOPE),
      ],
    },
    audit: new MemoryAuditWriter(),
    credentials: new StubCredentialStore(),
    executor: new MockExecutor(),
    dialect: createMysqlDialect({ database }),
    now: () => 1_700_000_000_000,
    idGen: () => `01TESTID${(counter++).toString().padStart(18, "0")}`,
  });
}

const ctx = { tenant_id: "42", agent_name: "t", agent_version: "0", mcp_token_id: null, role: "agent_readonly" };

async function expectDeny(engine: Engine, sql: string, reason: string): Promise<void> {
  const d = await engine.handle({ sql, ctx });
  expect(d.allowed).toBe(false);
  expect((d as { allowed: false; reason: string }).reason).toBe(reason);
}
async function expectAllow(engine: Engine, sql: string): Promise<void> {
  const d = await engine.handle({ sql, ctx });
  expect(d.allowed).toBe(true);
}

describe("mysql-safety: USE is denied unconditionally (not via multi_statement)", () => {
  const engine = makeMysqlEngine();
  test("standalone USE → table_access no_target deny", () => expectDeny(engine, "USE otherdb", "table_access"));
  // `USE x; SELECT 1` is also caught by multi_statement; standalone proves USE
  // does not rely on it.
  test("USE followed by SELECT → denied", async () => {
    const d = await engine.handle({ sql: "USE otherdb; SELECT 1", ctx });
    expect(d.allowed).toBe(false);
  });
});

describe("mysql-safety: cross-database references are rejected (RED)", () => {
  const engine = makeMysqlEngine("appdb");

  test("foreign-db table ref denied", () => expectDeny(engine, "SELECT * FROM otherdb.users WHERE otherdb.users.org_id = 42", "table_access"));
  test("foreign-db ref hidden only in a column qualifier denied", () => expectDeny(engine, "SELECT * FROM users WHERE otherdb.users.org_id = 42", "table_access"));
  test("foreign-db write target denied", () => expectDeny(engine, "DELETE FROM otherdb.users WHERE org_id = 42", "table_access"));

  // Safe direction: own-database qualifier is allowed and resolves to bare.
  test("own-db qualifier on scoped table allowed", () => expectAllow(engine, "SELECT * FROM appdb.users WHERE appdb.users.org_id = 42"));
  test("own-db qualifier still enforces tenant scope", () => expectDeny(engine, "SELECT * FROM appdb.users", "tenant_scope_missing"));
});

describe("mysql-safety: upsert paths re-open scoped rows → tenant_scope deny", () => {
  const engine = makeMysqlEngine();
  test("ON DUPLICATE KEY UPDATE on scoped rw table denied even with correct tenant", () =>
    expectDeny(engine, "INSERT INTO users (id, org_id) VALUES (1, 42) ON DUPLICATE KEY UPDATE name = 'x'", "tenant_scope_missing"));
  test("REPLACE on scoped rw table denied even with correct tenant", () =>
    expectDeny(engine, "REPLACE INTO users (id, org_id) VALUES (1, 42)", "tenant_scope_missing"));
  // On an UNSCOPED rw table the upsert is fine.
  test("ON DUPLICATE KEY UPDATE on unscoped rw table allowed", () =>
    expectAllow(engine, "INSERT INTO webhooks (id, url) VALUES (1, 'x') ON DUPLICATE KEY UPDATE url = 'y'"));
});

describe("mysql-safety: backtick identifiers resolve to bare policy keys", () => {
  const engine = makeMysqlEngine();
  test("backtick deny-listed table still denied", () => expectDeny(engine, "SELECT * FROM `audit_log`", "table_access"));
  test("backtick scoped table still enforced", () => expectDeny(engine, "SELECT * FROM `users`", "tenant_scope_missing"));
  test("backtick scoped table with predicate allowed", () => expectAllow(engine, "SELECT * FROM `users` WHERE `org_id` = 42"));
});

describe("mysql-safety: MERGE is a parse error (node-sql-parser rejects it)", () => {
  const engine = makeMysqlEngine();
  test("MERGE → parse_error deny", () => expectDeny(engine, "MERGE INTO users USING staging ON (users.id = staging.id) WHEN MATCHED THEN UPDATE SET users.name = staging.name", "parse_error"));
});

describe("mysql-safety: multi-table UPDATE/DELETE", () => {
  const engine = makeMysqlEngine();
  // accounts is read-only; writing it (even via join) must be denied. users is
  // rw + scoped; the joined read of accounts is fine, but a write target check
  // on a non-rw table denies.
  test("multi-table UPDATE writing a read-only joined table denied", () =>
    expectDeny(engine, "UPDATE accounts a JOIN users u ON u.account_id = a.id SET a.name = 'x' WHERE u.org_id = 42", "table_access"));
  test("multi-table DELETE targeting scoped rw table with predicate allowed", () =>
    expectAllow(engine, "DELETE u FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.org_id = 42"));
  test("multi-table DELETE targeting scoped rw table missing predicate denied", () =>
    expectDeny(engine, "DELETE u FROM users u JOIN accounts a ON a.id = u.account_id", "tenant_scope_missing"));
});

describe("mysql-safety: strict fallback when DSN names no database", () => {
  const strict = makeMysqlEngine(null);
  test("any explicit db qualifier rejected (database unknown)", () =>
    expectDeny(strict, "SELECT * FROM appdb.users WHERE appdb.users.org_id = 42", "table_access"));
  test("bare scoped table still works in strict fallback", () =>
    expectAllow(strict, "SELECT * FROM users WHERE org_id = 42"));
});
