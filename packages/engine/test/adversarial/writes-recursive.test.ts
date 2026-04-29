// Adversarial corpus — writes_require_approval (recursive AST detection).
//
// V1 default: any write statement kind, anywhere in the AST, denies the
// whole query. The visitor walks every node — top level, inside a CTE,
// inside a subquery, inside a UNION arm, inside a JOIN's RHS — so writes
// hidden by syntactic nesting cannot bypass.
//
// Reference: design doc T1 (read-only default) + T4 (recursive AST
// detection). Test plan: "Edge Cases — Policy rule edges → bypass vectors".
// Real-world precedent: PocketOS unbounded delete, CTE-RETURNING bypass
// flagged by Codex during eng review.

import { describe, expect, test } from "bun:test";
import { makeEngine, baseCtx } from "../_helpers.ts";
import { PolicyRule } from "../../src/audit/types.ts";
import { expectDeny, expectAllow, expectDecidedDeny } from "./_helpers.ts";

const WRITES = PolicyRule.WRITES_REQUIRE_APPROVAL;

describe("adversarial/writes-recursive: top-level DML", () => {
  test("DELETE FROM users (no WHERE) → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "DELETE FROM users", WRITES);
  });

  test("DELETE FROM users WHERE id = 1 → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "DELETE FROM users WHERE id = 1", WRITES);
  });

  test("UPDATE users SET name='b' WHERE org_id=42 → deny", async () => {
    const { engine, audit } = makeEngine();
    await expectDeny(engine, baseCtx, "UPDATE users SET name='b' WHERE org_id=42", WRITES);
    expectDecidedDeny(audit, WRITES);
  });

  test("UPDATE … FROM (multi-table form) → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "UPDATE a SET n=1 FROM b WHERE a.id = b.id",
      WRITES,
    );
  });

  test("INSERT INTO users (org_id, name) VALUES (42, 'a') → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "INSERT INTO users (org_id, name) VALUES (42, 'a')",
      WRITES,
    );
  });

  test("INSERT … RETURNING * → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "INSERT INTO logs (msg) VALUES ('x') RETURNING id, msg",
      WRITES,
    );
  });

  test("INSERT … ON CONFLICT DO NOTHING → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "INSERT INTO t (x) VALUES (1) ON CONFLICT (x) DO NOTHING",
      WRITES,
    );
  });

  test("INSERT … ON CONFLICT DO UPDATE → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "INSERT INTO t (x, y) VALUES (1, 2) ON CONFLICT (x) DO UPDATE SET y = excluded.y",
      WRITES,
    );
  });

  test("MERGE (when matched + when not matched) → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      `MERGE INTO target t USING source s ON t.id = s.id
       WHEN MATCHED THEN UPDATE SET v = s.v
       WHEN NOT MATCHED THEN INSERT (id, v) VALUES (s.id, s.v)`,
      WRITES,
    );
  });

  test("MERGE (only when matched) → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "MERGE INTO target t USING source s ON t.id = s.id WHEN MATCHED THEN UPDATE SET v = s.v",
      WRITES,
    );
  });
});

describe("adversarial/writes-recursive: DDL", () => {
  test("DROP TABLE x → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "DROP TABLE x", WRITES);
  });

  test("TRUNCATE t → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "TRUNCATE t", WRITES);
  });

  test("CREATE TABLE foo (id int) → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "CREATE TABLE foo (id int)", WRITES);
  });

  test("CREATE TABLE AS SELECT → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "CREATE TABLE foo AS SELECT * FROM users",
      WRITES,
    );
  });

  test("ALTER TABLE … ADD COLUMN → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "ALTER TABLE users ADD COLUMN flag boolean",
      WRITES,
    );
  });

  test("CREATE INDEX → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "CREATE INDEX idx_users_email ON users (email)",
      WRITES,
    );
  });

  test("CREATE VIEW v AS SELECT → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "CREATE VIEW v AS SELECT 1", WRITES);
  });

  test("REFRESH MATERIALIZED VIEW → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "REFRESH MATERIALIZED VIEW v", WRITES);
  });

  test("GRANT SELECT → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "GRANT SELECT ON users TO some_role", WRITES);
  });

  test("REVOKE SELECT → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "REVOKE SELECT ON users FROM some_role", WRITES);
  });

  test("GRANT role → deny (GrantRoleStmt)", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "GRANT admin TO some_user", WRITES);
  });

  test("CREATE SCHEMA → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "CREATE SCHEMA s", WRITES);
  });

  test("CREATE ROLE → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "CREATE ROLE bob", WRITES);
  });

  test("CREATE FUNCTION → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql",
      WRITES,
    );
  });

  test("CREATE DATABASE → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "CREATE DATABASE d", WRITES);
  });

  test("ALTER DOMAIN → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "ALTER DOMAIN d SET DEFAULT 1",
      WRITES,
    );
  });

  test("CREATE RULE → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "CREATE RULE r AS ON SELECT TO t DO INSTEAD SELECT 1",
      WRITES,
    );
  });
});

describe("adversarial/writes-recursive: hidden inside CTE", () => {
  // Codex-flagged. Recursive AST detection per T4 closes this.
  test("WITH x AS (DELETE FROM y RETURNING *) SELECT * FROM x → deny", async () => {
    const { engine, audit } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "WITH x AS (DELETE FROM y RETURNING *) SELECT * FROM x",
      WRITES,
    );
    expectDecidedDeny(audit, WRITES);
  });

  test("WITH x AS (UPDATE y SET n=1 RETURNING *) SELECT * FROM x → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "WITH x AS (UPDATE y SET n=1 RETURNING *) SELECT * FROM x",
      WRITES,
    );
  });

  test("WITH x AS (INSERT INTO y VALUES (1) RETURNING *) SELECT * FROM x → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "WITH x AS (INSERT INTO y (n) VALUES (1) RETURNING *) SELECT * FROM x",
      WRITES,
    );
  });

  test("write hidden in second CTE (not first) → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      `WITH a AS (SELECT 1 AS n),
            b AS (DELETE FROM y RETURNING n)
       SELECT * FROM a, b`,
      WRITES,
    );
  });

  test("write hidden under nested CTE (CTE within CTE) → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      `WITH outer_cte AS (
         WITH inner_cte AS (DELETE FROM y RETURNING id)
         SELECT id FROM inner_cte
       ) SELECT * FROM outer_cte`,
      WRITES,
    );
  });

  test("WITH-modifying chain feeding INSERT → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "WITH d AS (DELETE FROM y RETURNING id) INSERT INTO archive (id) SELECT id FROM d",
      WRITES,
    );
  });

  test("RECURSIVE CTE wrapping a write → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      `WITH RECURSIVE r AS (
         SELECT 1 AS n
         UNION
         SELECT n+1 FROM r WHERE n < 5
       ), w AS (DELETE FROM y RETURNING id)
       SELECT * FROM r, w`,
      WRITES,
    );
  });

  test("CTE write referenced by EXISTS subquery → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      `WITH d AS (DELETE FROM y RETURNING id)
       SELECT id FROM x WHERE EXISTS (SELECT 1 FROM d WHERE d.id = x.id)`,
      WRITES,
    );
  });
});

describe("adversarial/writes-recursive: hidden inside set ops", () => {
  test("write in UNION arm via CTE → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      `WITH d AS (DELETE FROM y RETURNING id) SELECT id FROM x UNION SELECT id FROM d`,
      WRITES,
    );
  });

  test("write in INTERSECT arm via CTE → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      `WITH d AS (DELETE FROM y RETURNING id) SELECT id FROM x INTERSECT SELECT id FROM d`,
      WRITES,
    );
  });

  test("write in EXCEPT arm via CTE → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      `WITH d AS (DELETE FROM y RETURNING id) SELECT id FROM x EXCEPT SELECT id FROM d`,
      WRITES,
    );
  });
});

describe("adversarial/writes-recursive: opaque procedural body", () => {
  // libpg-query keeps DO $$ ... $$ body as a string literal — we can't see
  // inside. Conservative answer: deny DO outright.
  test("DO $$ ... DELETE FROM users ... $$ → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "DO $$ BEGIN DELETE FROM users; END $$",
      WRITES,
    );
  });

  test("DO $$ ... read-only body ... $$ → still deny (body opaque)", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "DO $$ BEGIN PERFORM 1; END $$", WRITES);
  });

  test("DO with custom $tag$ delimiter → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "DO $tag$ BEGIN PERFORM 1; END $tag$",
      WRITES,
    );
  });
});

describe("adversarial/writes-recursive: read-only control", () => {
  test("plain SELECT → allow", async () => {
    const { engine, executor } = makeEngine();
    await expectAllow(
      engine,
      baseCtx,
      "SELECT id, email FROM users WHERE org_id = 42",
    );
    expect(executor.calls.length).toBe(1);
  });

  test("SELECT with subquery → allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      baseCtx,
      "SELECT id FROM (SELECT id FROM users) AS u",
    );
  });

  test("SELECT with CTE → allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      baseCtx,
      "WITH u AS (SELECT id FROM users) SELECT * FROM u",
    );
  });
});
