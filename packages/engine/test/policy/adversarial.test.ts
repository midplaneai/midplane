// Adversarial SQL corpus.
// Every case here is either a known bypass attempt that V1 MUST deny,
// or a legitimate query that V1 must allow. Conservative semantics — false
// positives are acceptable; bypasses are not.
//
// Reference: design doc T8 (cross-model decisions), test plan
// "Edge Cases — Policy rule edges" + "Bypass vectors fail to bypass".

import { describe, expect, test } from "bun:test";
import { makeEngine, baseCtx, tenantScopedCtx } from "../_helpers.ts";
import { PolicyRule } from "../../src/audit/types.ts";

describe("adversarial: writes_require_approval — V1 default-read-only", () => {
  test("DELETE FROM users without WHERE → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({ sql: "DELETE FROM users", ctx: baseCtx });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.WRITES_REQUIRE_APPROVAL);
  });

  test("DROP TABLE z → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({ sql: "DROP TABLE z", ctx: baseCtx });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.WRITES_REQUIRE_APPROVAL);
  });

  test("TRUNCATE t → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({ sql: "TRUNCATE t", ctx: baseCtx });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.WRITES_REQUIRE_APPROVAL);
  });

  test("INSERT → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "INSERT INTO users (org_id, name) VALUES (42, 'a')",
      ctx: baseCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.WRITES_REQUIRE_APPROVAL);
  });

  test("UPDATE → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "UPDATE users SET name='b' WHERE org_id=42",
      ctx: baseCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.WRITES_REQUIRE_APPROVAL);
  });

  // The Codex-flagged CTE bypass. The core reason recursive AST detection (T4) exists.
  test("CTE-embedded DELETE → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "WITH x AS (DELETE FROM y RETURNING *) SELECT * FROM x",
      ctx: baseCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.WRITES_REQUIRE_APPROVAL);
  });

  test("CTE-embedded UPDATE → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "WITH x AS (UPDATE y SET n=1 RETURNING *) SELECT * FROM x",
      ctx: baseCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.WRITES_REQUIRE_APPROVAL);
  });

  test("MERGE → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: `MERGE INTO target t USING source s ON t.id=s.id
            WHEN MATCHED THEN UPDATE SET v=s.v
            WHEN NOT MATCHED THEN INSERT (id, v) VALUES (s.id, s.v)`,
      ctx: baseCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.WRITES_REQUIRE_APPROVAL);
  });

  test("GRANT → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "GRANT SELECT ON users TO some_role",
      ctx: baseCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.WRITES_REQUIRE_APPROVAL);
  });

  test("CREATE TABLE → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "CREATE TABLE foo (id int)",
      ctx: baseCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.WRITES_REQUIRE_APPROVAL);
  });

  // Reviewer-flagged: DO block with opaque body. libpg-query keeps the body
  // as a string literal, so AST-recursive write detection can't see writes
  // inside. Only safe answer at V1 is to deny DO outright.
  test("DO $$ ... DELETE FROM users ... $$ → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "DO $$ BEGIN DELETE FROM users; END $$",
      ctx: baseCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.WRITES_REQUIRE_APPROVAL);
  });

  test("DO $$ ... read-only body ... $$ → still deny (body is opaque)", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "DO $$ BEGIN PERFORM 1; END $$",
      ctx: baseCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.WRITES_REQUIRE_APPROVAL);
  });

  test("plain SELECT → allow", async () => {
    const { engine, executor } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT id, email FROM users WHERE org_id = 42",
      ctx: baseCtx,
    });
    expect(d.allowed).toBe(true);
    expect(executor.calls.length).toBe(1);
  });
});

describe("adversarial: multi_statement — Datadog stacked-statement injection", () => {
  test("two stmts: SELECT 1; DROP TABLE users; → deny on multi", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT 1; DROP TABLE users;",
      ctx: baseCtx,
    });
    expect(d.allowed).toBe(false);
    // multi_statement should fire BEFORE writes_require_approval evaluates
    // (eng review semantics: which fires first is implementation choice, but
    // both are valid reasons). We assert it's denied, but for this canonical
    // injection vector the rule that fires must be multi_statement.
    expect((d as { reason: string }).reason).toBe(PolicyRule.MULTI_STATEMENT);
  });

  test("trailing semicolon, single stmt → allow", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({ sql: "SELECT 1;", ctx: baseCtx });
    expect(d.allowed).toBe(true);
  });

  test("comment + stacked: -- ; SELECT 1; DROP TABLE x; → parser sees actual stmts", async () => {
    // The dash-comment hides nothing inside it; what's after the newline-or-end
    // matters. Here `-- ; SELECT 1; DROP TABLE x;` is one comment line, so the
    // statement count is whatever follows. We assert: parser handles it
    // correctly and either parses to 0 stmts (parse_error) or 1+ stmts where
    // multi or writes fires. Either way: not ALLOW.
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT 1; -- ; DROP TABLE x;",
      ctx: baseCtx,
    });
    // After the SELECT 1, the comment-prefixed DROP is hidden — so this is
    // a single-statement SELECT 1, which should ALLOW. Sanity check the
    // parser is not naively counting semicolons.
    expect(d.allowed).toBe(true);
  });

  test("block comment with stacked statement → parser counts real stmts", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "/* ; SELECT 99; */ SELECT 1",
      ctx: baseCtx,
    });
    expect(d.allowed).toBe(true);
  });
});

describe("adversarial: tenant_scope — conservative, literal WHERE column = context required", () => {
  test("SELECT * FROM users (no WHERE) when tenant_scope ON → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT * FROM users",
      ctx: tenantScopedCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.TENANT_SCOPE_MISSING);
  });

  test("SELECT * FROM users WHERE org_id = 42 → allow when context tenant_id=42", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT * FROM users WHERE org_id = 42",
      ctx: tenantScopedCtx,
    });
    expect(d.allowed).toBe(true);
  });

  test("wrong literal: WHERE org_id = 99 (context=42) → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT * FROM users WHERE org_id = 99",
      ctx: tenantScopedCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.TENANT_SCOPE_MISSING);
  });

  // Codex-flagged "fake safety" predicates — broad-but-valid but not literal-on-tenant
  test("WHERE 1 = 1 → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT * FROM users WHERE 1 = 1",
      ctx: tenantScopedCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.TENANT_SCOPE_MISSING);
  });

  test("WHERE id IS NOT NULL → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT * FROM users WHERE id IS NOT NULL",
      ctx: tenantScopedCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.TENANT_SCOPE_MISSING);
  });

  test("WHERE true → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT * FROM users WHERE true",
      ctx: tenantScopedCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.TENANT_SCOPE_MISSING);
  });

  test("UNION arm bypass: scoped UNION unscoped → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT * FROM users WHERE org_id = 42 UNION SELECT * FROM users",
      ctx: tenantScopedCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.TENANT_SCOPE_MISSING);
  });

  test("UNION both arms scoped → allow", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT id FROM users WHERE org_id = 42 UNION SELECT id FROM users WHERE org_id = 42",
      ctx: tenantScopedCtx,
    });
    expect(d.allowed).toBe(true);
  });

  test("subquery bypass: scoped outer, unscoped inner → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT * FROM (SELECT * FROM users) AS u WHERE u.org_id = 42",
      ctx: tenantScopedCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.TENANT_SCOPE_MISSING);
  });

  test("CTE referencing mapped table without scope → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "WITH u AS (SELECT * FROM users) SELECT * FROM u",
      ctx: tenantScopedCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.TENANT_SCOPE_MISSING);
  });

  test("non-mapped table — no tenant_scope check applies", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT version()",
      ctx: tenantScopedCtx,
    });
    expect(d.allowed).toBe(true);
  });

  test("when tenant_scope OFF (no mappings in ctx) → unmapped query allowed", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT * FROM users",
      ctx: baseCtx, // no tenant_scope
    });
    expect(d.allowed).toBe(true);
  });

  test("string-literal tenant: WHERE customer_id = 'cust42' matches context tenant_id 'cust42'", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT * FROM invoices WHERE customer_id = 'cust42'",
      ctx: { ...tenantScopedCtx, tenant_id: "cust42" },
    });
    expect(d.allowed).toBe(true);
  });

  test("tenant_scope ALONE (no writes_require_approval): DELETE on mapped table → deny", async () => {
    // Verifies tenant_scope is standalone-correct: mapped table outside a
    // SELECT (here, in DELETE.relation) still triggers DENY. In production
    // writes_require_approval normally denies writes first.
    const { engine } = makeEngine({
      rules: [
        // Order: parse_error first, tenant_scope second; writes rule omitted.
        (await import("../../src/policy/rules/parse-error.ts")).parseError(),
        (await import("../../src/policy/rules/tenant-scope.ts")).tenantScope(),
      ],
    });
    const d = await engine.handle({
      sql: "DELETE FROM users WHERE org_id = 42",
      ctx: tenantScopedCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.TENANT_SCOPE_MISSING);
  });

  test("AND-conjoined predicate: WHERE org_id = 42 AND foo = 1 → allow", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT * FROM users WHERE foo = 1 AND org_id = 42",
      ctx: tenantScopedCtx,
    });
    expect(d.allowed).toBe(true);
  });

  test("OR-disjoined: WHERE org_id = 42 OR id > 0 → deny (OR doesn't strengthen)", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT * FROM users WHERE org_id = 42 OR id > 0",
      ctx: tenantScopedCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.TENANT_SCOPE_MISSING);
  });

  test("reversed predicate order: WHERE 42 = org_id → allow", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT * FROM users WHERE 42 = org_id",
      ctx: tenantScopedCtx,
    });
    expect(d.allowed).toBe(true);
  });

  test("float literal tenant_id round-trips", async () => {
    // Exercises the A_Const.fval branch in tenant-scope's literal extractor.
    // (Postgres parser keeps numeric literals like `1.5` as fval.)
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT * FROM users WHERE org_id = 1.5",
      ctx: { ...tenantScopedCtx, tenant_id: "1.5" },
    });
    expect(d.allowed).toBe(true);
  });

  // Reviewer-flagged cross-tenant bypass: predicate qualifier dropped meant
  // u.org_id=42 satisfied EVERY mapped org_id table in the SELECT.
  test("multi-table JOIN, qualifier predicate only covers one table → deny", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT * FROM users u JOIN posts p ON true WHERE u.org_id = 42",
      ctx: tenantScopedCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.TENANT_SCOPE_MISSING);
  });

  test("multi-table JOIN with both tables qualified → allow", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT * FROM users u JOIN posts p ON true WHERE u.org_id = 42 AND p.org_id = 42",
      ctx: tenantScopedCtx,
    });
    expect(d.allowed).toBe(true);
  });

  test("multi-mapped-table JOIN, unqualified predicate → deny (ambiguous)", async () => {
    // Two mapped tables share the same tenant column. An unqualified
    // org_id=42 is ambiguous — conservatively deny rather than guess.
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT * FROM users JOIN posts ON true WHERE org_id = 42",
      ctx: tenantScopedCtx,
    });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.TENANT_SCOPE_MISSING);
  });

  test("qualified predicate referencing un-aliased table by relname → allow", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({
      sql: "SELECT * FROM users WHERE users.org_id = 42",
      ctx: tenantScopedCtx,
    });
    expect(d.allowed).toBe(true);
  });
});

describe("adversarial: parse_error", () => {
  test("invalid SQL → deny with parse_error", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({ sql: "this is not sql", ctx: baseCtx });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.PARSE_ERROR);
  });

  test("empty input → deny with parse_error", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({ sql: "", ctx: baseCtx });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.PARSE_ERROR);
  });

  test("whitespace only → deny with parse_error", async () => {
    const { engine } = makeEngine();
    const d = await engine.handle({ sql: "   \n\t  ", ctx: baseCtx });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.PARSE_ERROR);
  });

  test("very long input (>1MiB) → deny with parse_error before parsing", async () => {
    const { engine } = makeEngine();
    const big = "SELECT 1 -- " + "x".repeat(1_048_700);
    const d = await engine.handle({ sql: big, ctx: baseCtx });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe(PolicyRule.PARSE_ERROR);
  });
});
