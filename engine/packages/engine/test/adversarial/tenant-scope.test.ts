// Adversarial corpus — tenant_scope (cross-tenant exfiltration).
//
// V1 semantics: with a tenant_scope mapping `users → org_id` and an MCP
// context `tenant_id=42`, every SelectStmt that references a mapped
// table at its scope MUST carry a literal `WHERE org_id = 42` predicate
// reachable through AND-conjunctions only (OR/NOT do not count).
// "Same scope" = the immediately enclosing SelectStmt — UNION arms,
// CTE bodies, subqueries, and JOIN-RHS subselects each get their own
// scope check.
//
// Conservative tradeoff: false positives (legitimate queries denied)
// are acceptable; bypasses are not. Real-world precedent: Supabase MCP
// cross-tenant exfiltration via missing or wrong-literal WHERE.

import { describe, test } from "bun:test";
import { makeEngine, baseCtx, tenantScopedCtx } from "../_helpers.ts";
import { PolicyRule } from "../../src/audit/types.ts";
import { expectDeny, expectAllow, expectDecidedDeny } from "./_helpers.ts";
import { parseError } from "../../src/policy/rules/parse-error.ts";
import { tenantScope } from "../../src/policy/rules/tenant-scope.ts";

const TENANT = PolicyRule.TENANT_SCOPE_MISSING;

// tenant_scope-only rule list. Used for cases where we want to verify
// tenant_scope is correct on its own — in production writes_require_approval
// normally fires first on writes.
function tenantOnlyEngine() {
  return makeEngine({ rules: [parseError(), tenantScope()] });
}

describe("adversarial/tenant-scope: missing scope predicate", () => {
  test("SELECT * FROM users (no WHERE) → deny", async () => {
    const { engine, audit } = makeEngine();
    await expectDeny(engine, tenantScopedCtx, "SELECT * FROM users", TENANT);
    expectDecidedDeny(audit, TENANT);
  });

  test("SELECT * FROM users WHERE id > 0 (wrong column) → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users WHERE id > 0",
      TENANT,
    );
  });

  test("scoped query satisfies tenant_scope → allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users WHERE org_id = 42",
    );
  });

  test("non-mapped table — tenant_scope doesn't apply → allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, tenantScopedCtx, "SELECT version()");
  });

  test("tenant_scope OFF (no mappings) — query on mapped name allowed", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "SELECT * FROM users");
  });
});

describe("adversarial/tenant-scope: wrong-literal predicates", () => {
  test("WHERE org_id = 99 (context=42) → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users WHERE org_id = 99",
      TENANT,
    );
  });

  test("WHERE 1 = 1 (tautology) → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users WHERE 1 = 1",
      TENANT,
    );
  });

  test("WHERE id IS NOT NULL → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users WHERE id IS NOT NULL",
      TENANT,
    );
  });

  test("WHERE true → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users WHERE true",
      TENANT,
    );
  });

  test("WHERE org_id IN (42) — IN, not = → conservative deny", async () => {
    // V1 doesn't unfold IN-list singletons. Operator must be `=`.
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users WHERE org_id IN (42)",
      TENANT,
    );
  });

  test("WHERE org_id::text = '42' — cast → conservative deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users WHERE org_id::text = '42'",
      TENANT,
    );
  });

  test("WHERE org_id = NULL — A_Const with no ival/sval/fval → conservative deny", async () => {
    // `= NULL` is semantically always NULL/false in Postgres; the literal
    // extractor receives an A_Const with `isnull` (none of the three value
    // shapes it knows). Returning null from extractConstLiteral means the
    // predicate isn't extracted at all — falls through to deny.
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users WHERE org_id = NULL",
      TENANT,
    );
  });
});

describe("adversarial/tenant-scope: predicate connective handling", () => {
  test("AND-conjoined: WHERE foo=1 AND org_id=42 → allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users WHERE foo = 1 AND org_id = 42",
    );
  });

  test("nested AND: WHERE (a=1 AND b=2) AND org_id=42 → allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users WHERE (a = 1 AND b = 2) AND org_id = 42",
    );
  });

  test("OR-disjoined: WHERE org_id=42 OR id>0 → deny (OR doesn't strengthen)", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users WHERE org_id = 42 OR id > 0",
      TENANT,
    );
  });

  test("NOT-wrapped: WHERE NOT (org_id <> 42) → conservative deny", async () => {
    // Logically equivalent to org_id=42, but V1 only recognizes literal `=`
    // through AND-conjunctions. NOT is intentionally not propagated.
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users WHERE NOT (org_id <> 42)",
      TENANT,
    );
  });

  test("reversed predicate: WHERE 42 = org_id → allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users WHERE 42 = org_id",
    );
  });
});

describe("adversarial/tenant-scope: scope-bypass via nesting", () => {
  test("UNION arm bypass: scoped UNION unscoped → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users WHERE org_id = 42 UNION SELECT * FROM users",
      TENANT,
    );
  });

  test("UNION both arms scoped → allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      tenantScopedCtx,
      "SELECT id FROM users WHERE org_id = 42 UNION SELECT id FROM users WHERE org_id = 42",
    );
  });

  test("INTERSECT one arm unscoped → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT id FROM users WHERE org_id = 42 INTERSECT SELECT id FROM users",
      TENANT,
    );
  });

  test("EXCEPT one arm unscoped → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT id FROM users WHERE org_id = 42 EXCEPT SELECT id FROM users",
      TENANT,
    );
  });

  test("subquery FROM-clause: scoped outer, unscoped inner → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT * FROM (SELECT * FROM users) AS u WHERE u.org_id = 42",
      TENANT,
    );
  });

  test("CTE referencing mapped without scope → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "WITH u AS (SELECT * FROM users) SELECT * FROM u",
      TENANT,
    );
  });

  test("CTE with scope inside, used downstream → allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      tenantScopedCtx,
      "WITH u AS (SELECT * FROM users WHERE org_id = 42) SELECT * FROM u",
    );
  });

  test("scalar subquery in SELECT list referencing mapped → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT (SELECT count(*) FROM users) AS n",
      TENANT,
    );
  });

  test("EXISTS subquery on mapped without scope → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT 1 WHERE EXISTS (SELECT 1 FROM users)",
      TENANT,
    );
  });

  test("IN-subquery on mapped without scope → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT * FROM other WHERE id IN (SELECT id FROM users)",
      TENANT,
    );
  });

  test("ANY-subquery on mapped without scope → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT * FROM other WHERE id = ANY (SELECT id FROM users)",
      TENANT,
    );
  });

  test("NATURAL JOIN on mapped table → deny", async () => {
    // NATURAL JOIN inferred ON-condition doesn't help — tenant_scope still
    // requires a literal `WHERE org_id = ctx`. Conservative-by-default.
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users NATURAL JOIN posts WHERE u.org_id = 42",
      TENANT,
    );
  });
});

describe("adversarial/tenant-scope: multi-table JOIN qualifier semantics", () => {
  test("two mapped tables, predicate covers only one → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users u JOIN posts p ON true WHERE u.org_id = 42",
      TENANT,
    );
  });

  test("two mapped tables, both qualified → allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users u JOIN posts p ON true WHERE u.org_id = 42 AND p.org_id = 42",
    );
  });

  test("two mapped tables, unqualified predicate → deny (ambiguous)", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users JOIN posts ON true WHERE org_id = 42",
      TENANT,
    );
  });

  test("qualified by relname (no alias) → allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users WHERE users.org_id = 42",
    );
  });

  test("LATERAL subquery on mapped without scope → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users u, LATERAL (SELECT * FROM posts WHERE author_id = u.id) AS p WHERE u.org_id = 42",
      TENANT,
    );
  });

  test("LATERAL subquery on mapped with scope inside → allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      tenantScopedCtx,
      "SELECT * FROM users u, LATERAL (SELECT * FROM posts WHERE author_id = u.id AND org_id = 42) AS p WHERE u.org_id = 42",
    );
  });
});

describe("adversarial/tenant-scope: literal types", () => {
  test("string literal tenant: WHERE customer_id = 'cust42' (ctx=cust42) → allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      { ...tenantScopedCtx, tenant_id: "cust42" },
      "SELECT * FROM invoices WHERE customer_id = 'cust42'",
    );
  });

  test("float literal tenant_id round-trip", async () => {
    // Exercises A_Const.fval branch.
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      { ...tenantScopedCtx, tenant_id: "1.5" },
      "SELECT * FROM users WHERE org_id = 1.5",
    );
  });

  test("string literal mismatch → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      { ...tenantScopedCtx, tenant_id: "cust42" },
      "SELECT * FROM invoices WHERE customer_id = 'cust99'",
      TENANT,
    );
  });
});

describe("adversarial/tenant-scope: standalone DML (writes rule disabled)", () => {
  // These cases verify tenant_scope is correct on its own. In production
  // writes_require_approval normally denies all writes first.
  test("DELETE on mapped table without predicate → deny", async () => {
    const { engine } = tenantOnlyEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "DELETE FROM users",
      TENANT,
    );
  });

  test("DELETE on mapped table WITH matching predicate → allow", async () => {
    // 0.5.0: UPDATE/DELETE check the WHERE clause the same way SELECT
    // does. A correctly-scoped DELETE allows; the over-conservative
    // pre-0.5.0 blanket-deny broke read_write tables under strict mode.
    const { engine } = tenantOnlyEngine();
    await expectAllow(
      engine,
      tenantScopedCtx,
      "DELETE FROM users WHERE org_id = 42",
    );
  });

  test("DELETE WHERE 1=1 on mapped → deny (no tenant predicate)", async () => {
    const { engine } = tenantOnlyEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "DELETE FROM users WHERE 1 = 1",
      TENANT,
    );
  });

  test("DELETE WHERE wrong-tenant literal → deny", async () => {
    const { engine } = tenantOnlyEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "DELETE FROM users WHERE org_id = 99",
      TENANT,
    );
  });

  test("UPDATE on mapped table WITH matching predicate → allow", async () => {
    const { engine } = tenantOnlyEngine();
    await expectAllow(
      engine,
      tenantScopedCtx,
      "UPDATE users SET name='b' WHERE org_id = 42",
    );
  });

  test("UPDATE mapped … FROM unmapped, no predicate → deny", async () => {
    const { engine } = tenantOnlyEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "UPDATE users SET name='b' FROM logs WHERE users.id = logs.user_id",
      TENANT,
    );
  });

  test("UPDATE mapped … FROM unmapped WITH predicate → allow", async () => {
    const { engine } = tenantOnlyEngine();
    await expectAllow(
      engine,
      tenantScopedCtx,
      "UPDATE users SET name='b' FROM logs WHERE users.id = logs.user_id AND users.org_id = 42",
    );
  });

  test("INSERT INTO mapped (cross-tenant literal) → deny", async () => {
    // 0.5.0: INSERT VALUES is verified row-by-row at the tenant-column
    // position. Wrong literal denies.
    const { engine } = tenantOnlyEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "INSERT INTO users (org_id, name) VALUES (99, 'a')",
      TENANT,
    );
  });

  test("INSERT INTO mapped (matching tenant literal) → allow", async () => {
    const { engine } = tenantOnlyEngine();
    await expectAllow(
      engine,
      tenantScopedCtx,
      "INSERT INTO users (org_id, name) VALUES (42, 'a')",
    );
  });

  test("INSERT INTO mapped, omits tenant column → deny", async () => {
    // Column list doesn't include `org_id` — the row would get NULL or
    // a default, neither of which we can verify. Conservative deny.
    const { engine } = tenantOnlyEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "INSERT INTO users (name) VALUES ('a')",
      TENANT,
    );
  });

  test("INSERT INTO mapped without column list → deny (position unknown)", async () => {
    // No explicit column list means tenant-column position depends on
    // schema we don't introspect. Conservative deny — operator must
    // either supply a column list or `exempt` the table.
    const { engine } = tenantOnlyEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "INSERT INTO users VALUES (42, 'a')",
      TENANT,
    );
  });

  test("INSERT … SELECT into mapped → deny (can't verify row-by-row)", async () => {
    // The inner SELECT is its own scope (checked separately). The
    // INSERT target's tenant column would be whatever the SELECT
    // yields — not statically verifiable. Conservative deny.
    const { engine } = tenantOnlyEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "INSERT INTO users (org_id, name) SELECT org_id, name FROM staging WHERE org_id = 42",
      TENANT,
    );
  });

  test("INSERT multi-row, one row wrong tenant → deny", async () => {
    const { engine } = tenantOnlyEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "INSERT INTO users (org_id, name) VALUES (42, 'a'), (99, 'b')",
      TENANT,
    );
  });

  test("INSERT with ON CONFLICT DO UPDATE on scoped table → deny", async () => {
    // ON CONFLICT DO UPDATE silently overwrites existing rows — the
    // VALUES check guards the would-be-inserted row, but the update
    // path can hit any row matching the conflict target. Conservative
    // deny; operator must `exempt` to use this pattern.
    const { engine } = tenantOnlyEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "INSERT INTO users (org_id, name) VALUES (42, 'a') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name",
      TENANT,
    );
  });

  test("INSERT with ON CONFLICT DO NOTHING on scoped table → allow", async () => {
    const { engine } = tenantOnlyEngine();
    await expectAllow(
      engine,
      tenantScopedCtx,
      "INSERT INTO users (org_id, name) VALUES (42, 'a') ON CONFLICT (name) DO NOTHING",
    );
  });

  test("MERGE INTO mapped → deny (always; operator must exempt)", async () => {
    const { engine } = tenantOnlyEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      `MERGE INTO users u USING staging s ON u.id = s.id
       WHEN MATCHED THEN UPDATE SET name = s.name`,
      TENANT,
    );
  });

  test("DML on un-mapped table → allow (no tenant scope to enforce)", async () => {
    const { engine } = tenantOnlyEngine();
    await expectAllow(engine, tenantScopedCtx, "DELETE FROM logs WHERE id = 1");
  });

  test("CTE-write into mapped table → deny via inner SELECT scope", async () => {
    // The DELETE target is `logs` (un-mapped) but the inner CTE references
    // `users` (mapped) without scope. tenant_scope visits the inner SELECT.
    const { engine } = tenantOnlyEngine();
    await expectDeny(
      engine,
      tenantScopedCtx,
      "WITH u AS (SELECT id FROM users) DELETE FROM logs WHERE id IN (SELECT id FROM u)",
      TENANT,
    );
  });
});

describe("adversarial/tenant-scope: information_schema carve-out", () => {
  // information_schema is unconditionally exempt from tenant-scope (matches
  // table_access's existing carve-out). Without this, list_tables /
  // describe_table — which query information_schema — would always fail
  // under strict mode.
  test("SELECT FROM information_schema.tables → allow under strict mode", async () => {
    const { engine } = makeEngine({
      rules: [
        parseError(),
        tenantScope({
          defaultColumn: "tenant_id",
          overrides: {},
          exempt: [],
        }),
      ],
    });
    await expectAllow(
      engine,
      tenantScopedCtx,
      "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
  });

  test("SELECT FROM information_schema.columns → allow under strict mode", async () => {
    const { engine } = makeEngine({
      rules: [
        parseError(),
        tenantScope({
          defaultColumn: "tenant_id",
          overrides: {},
          exempt: [],
        }),
      ],
    });
    await expectAllow(
      engine,
      tenantScopedCtx,
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users'",
    );
  });

  test("pg_catalog is NOT carved out — query without predicate denies", async () => {
    // Matches table_access's choice to leave pg_catalog policied: it
    // exposes pg_roles etc. beyond schema discovery. An operator who
    // genuinely needs pg_catalog access must `exempt` the specific
    // table.
    const { engine } = makeEngine({
      rules: [
        parseError(),
        tenantScope({
          defaultColumn: "tenant_id",
          overrides: {},
          exempt: [],
        }),
      ],
    });
    await expectDeny(
      engine,
      tenantScopedCtx,
      "SELECT * FROM pg_catalog.pg_roles",
      TENANT,
    );
  });
});
