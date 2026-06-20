// Adversarial corpus — table_access (per-table R/W policy, AST-recursive).
//
// `table_access` replaces the binary writes_require_approval sentinel.
// Default behavior with no YAML is identical to the V1 trust posture:
// every write denies regardless of target. With YAML, writes only allow
// when the target table is `read_write`; reads only allow when the
// table is `read` or `read_write` (and `default: deny` blocks unlisted
// tables entirely).
//
// Recursive AST detection — writes hidden in CTEs, subqueries, UNION
// arms, JOINs are detected at the inner write node and checked against
// the target table's permission. The walk also enforces `read` on every
// table reference, so `INSERT INTO read_write_table SELECT FROM
// deny_table` denies on the SELECT side even though the write target
// is permitted.

import { describe, expect, test } from "bun:test";
import { makeEngine, baseCtx } from "../_helpers.ts";
import { PolicyRule } from "../../src/audit/types.ts";
import type { TableAccessConfig } from "../../src/policy/rules/table-access.ts";
import { expectDeny, expectAllow, expectDecidedDeny } from "./_helpers.ts";

const TABLE_ACCESS = PolicyRule.TABLE_ACCESS;

// A YAML-equivalent config that the corpus exercises against. Mirrors
// the docs example: a SaaS that lets the agent write feature_flags +
// webhooks, read users + posts, and never touch audit_log.
const YAML_CONFIG: TableAccessConfig = {
  default: "read",
  tables: {
    users: "read",
    posts: "read",
    audit_log: "deny",
    webhooks: "read_write",
    feature_flags: "read_write",
    "stripe.charges": "read",
  },
};

// ─── Legacy parity (no YAML) ────────────────────────────────────────────────

describe("adversarial/table-access (no YAML): top-level DML", () => {
  test("DELETE FROM users (no WHERE) → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "DELETE FROM users", TABLE_ACCESS);
  });

  test("DELETE FROM users WHERE id = 1 → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "DELETE FROM users WHERE id = 1", TABLE_ACCESS);
  });

  test("UPDATE users SET name='b' WHERE org_id=42 → deny", async () => {
    const { engine, audit } = makeEngine();
    await expectDeny(engine, baseCtx, "UPDATE users SET name='b' WHERE org_id=42", TABLE_ACCESS);
    expectDecidedDeny(audit, TABLE_ACCESS);
  });

  test("UPDATE … FROM (multi-table form) → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "UPDATE a SET n=1 FROM b WHERE a.id = b.id",
      TABLE_ACCESS,
    );
  });

  test("INSERT INTO users (org_id, name) VALUES (42, 'a') → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "INSERT INTO users (org_id, name) VALUES (42, 'a')",
      TABLE_ACCESS,
    );
  });

  test("INSERT … RETURNING * → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "INSERT INTO logs (msg) VALUES ('x') RETURNING id, msg",
      TABLE_ACCESS,
    );
  });

  test("INSERT … ON CONFLICT DO NOTHING → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "INSERT INTO t (x) VALUES (1) ON CONFLICT (x) DO NOTHING",
      TABLE_ACCESS,
    );
  });

  test("INSERT … ON CONFLICT DO UPDATE → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "INSERT INTO t (x, y) VALUES (1, 2) ON CONFLICT (x) DO UPDATE SET y = excluded.y",
      TABLE_ACCESS,
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
      TABLE_ACCESS,
    );
  });

  test("MERGE (only when matched) → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "MERGE INTO target t USING source s ON t.id = s.id WHEN MATCHED THEN UPDATE SET v = s.v",
      TABLE_ACCESS,
    );
  });
});

describe("adversarial/table-access (no YAML): DDL", () => {
  test("DROP TABLE x → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "DROP TABLE x", TABLE_ACCESS);
  });

  test("DROP TABLE schema.t (schema-qualified) → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "DROP TABLE public.users", TABLE_ACCESS);
  });

  test("TRUNCATE t → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "TRUNCATE t", TABLE_ACCESS);
  });

  test("CREATE TABLE foo (id int) → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "CREATE TABLE foo (id int)", TABLE_ACCESS);
  });

  test("CREATE TABLE AS SELECT → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "CREATE TABLE foo AS SELECT * FROM users",
      TABLE_ACCESS,
    );
  });

  test("SELECT … INTO foo → deny (legacy CREATE TABLE AS spelling)", async () => {
    // `SELECT … INTO foo` creates a table — libpg models it as a SelectStmt
    // with an intoClause, not a CreateTableAsStmt, so it once slipped past as a
    // plain read and a read-only agent could materialize a table (issue #109).
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "SELECT id, email INTO foo FROM users",
      TABLE_ACCESS,
    );
  });

  test("SELECT … INTO TEMP foo → deny (TEMP is no escape hatch)", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "SELECT id INTO TEMP foo FROM users", TABLE_ACCESS);
  });

  test("ALTER TABLE … ADD COLUMN → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "ALTER TABLE users ADD COLUMN flag boolean",
      TABLE_ACCESS,
    );
  });

  test("CREATE INDEX → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "CREATE INDEX idx_users_email ON users (email)",
      TABLE_ACCESS,
    );
  });

  test("CREATE VIEW v AS SELECT → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "CREATE VIEW v AS SELECT 1", TABLE_ACCESS);
  });

  test("REFRESH MATERIALIZED VIEW → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "REFRESH MATERIALIZED VIEW v", TABLE_ACCESS);
  });

  test("GRANT SELECT → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "GRANT SELECT ON users TO some_role", TABLE_ACCESS);
  });

  test("REVOKE SELECT → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "REVOKE SELECT ON users FROM some_role", TABLE_ACCESS);
  });

  test("GRANT role → deny (GrantRoleStmt; non-table object)", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "GRANT admin TO some_user", TABLE_ACCESS);
  });

  test("CREATE SCHEMA → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "CREATE SCHEMA s", TABLE_ACCESS);
  });

  test("CREATE ROLE → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "CREATE ROLE bob", TABLE_ACCESS);
  });

  test("CREATE FUNCTION → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql",
      TABLE_ACCESS,
    );
  });

  test("CREATE DATABASE → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "CREATE DATABASE d", TABLE_ACCESS);
  });

  test("ALTER DOMAIN → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "ALTER DOMAIN d SET DEFAULT 1",
      TABLE_ACCESS,
    );
  });

  test("CREATE RULE → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "CREATE RULE r AS ON SELECT TO t DO INSTEAD SELECT 1",
      TABLE_ACCESS,
    );
  });
});

describe("adversarial/table-access (no YAML): hidden inside CTE", () => {
  // The canonical recursive-detection case. Codex flagged it during
  // eng review; the walker exists to close it.
  test("WITH x AS (DELETE FROM y RETURNING *) SELECT * FROM x → deny", async () => {
    const { engine, audit } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "WITH x AS (DELETE FROM y RETURNING *) SELECT * FROM x",
      TABLE_ACCESS,
    );
    expectDecidedDeny(audit, TABLE_ACCESS);
  });

  test("WITH x AS (UPDATE y SET n=1 RETURNING *) SELECT * FROM x → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "WITH x AS (UPDATE y SET n=1 RETURNING *) SELECT * FROM x",
      TABLE_ACCESS,
    );
  });

  test("WITH x AS (INSERT INTO y VALUES (1) RETURNING *) SELECT * FROM x → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "WITH x AS (INSERT INTO y (n) VALUES (1) RETURNING *) SELECT * FROM x",
      TABLE_ACCESS,
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
      TABLE_ACCESS,
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
      TABLE_ACCESS,
    );
  });

  test("WITH-modifying chain feeding INSERT → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "WITH d AS (DELETE FROM y RETURNING id) INSERT INTO archive (id) SELECT id FROM d",
      TABLE_ACCESS,
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
      TABLE_ACCESS,
    );
  });

  test("CTE write referenced by EXISTS subquery → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      `WITH d AS (DELETE FROM y RETURNING id)
       SELECT id FROM x WHERE EXISTS (SELECT 1 FROM d WHERE d.id = x.id)`,
      TABLE_ACCESS,
    );
  });
});

describe("adversarial/table-access (no YAML): hidden inside set ops", () => {
  test("write in UNION arm via CTE → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      `WITH d AS (DELETE FROM y RETURNING id) SELECT id FROM x UNION SELECT id FROM d`,
      TABLE_ACCESS,
    );
  });

  test("write in INTERSECT arm via CTE → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      `WITH d AS (DELETE FROM y RETURNING id) SELECT id FROM x INTERSECT SELECT id FROM d`,
      TABLE_ACCESS,
    );
  });

  test("write in EXCEPT arm via CTE → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      `WITH d AS (DELETE FROM y RETURNING id) SELECT id FROM x EXCEPT SELECT id FROM d`,
      TABLE_ACCESS,
    );
  });
});

describe("adversarial/table-access (no YAML): opaque procedural body", () => {
  // libpg-query keeps DO $$ ... $$ body as a string literal — we can't
  // see inside, and a DO block has no extractable target table, so we
  // deny outright even with a YAML config.
  test("DO $$ ... DELETE FROM users ... $$ → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "DO $$ BEGIN DELETE FROM users; END $$",
      TABLE_ACCESS,
    );
  });

  test("DO $$ ... read-only body ... $$ → still deny (body opaque)", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "DO $$ BEGIN PERFORM 1; END $$", TABLE_ACCESS);
  });

  test("DO with custom $tag$ delimiter → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "DO $tag$ BEGIN PERFORM 1; END $tag$",
      TABLE_ACCESS,
    );
  });
});

describe("adversarial/table-access (no YAML): read-only control", () => {
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

// ─── YAML-driven semantics ──────────────────────────────────────────────────

describe("adversarial/table-access (YAML): per-permission semantics", () => {
  test("read on `read` table → allow", async () => {
    const { engine } = makeEngine({ tableAccess: YAML_CONFIG });
    await expectAllow(engine, baseCtx, "SELECT * FROM users WHERE id = 1");
  });

  test("write on `read` table → deny", async () => {
    const { engine } = makeEngine({ tableAccess: YAML_CONFIG });
    await expectDeny(engine, baseCtx, "DELETE FROM users WHERE id = 1", TABLE_ACCESS);
  });

  test("write on `read_write` table → allow", async () => {
    const { engine } = makeEngine({ tableAccess: YAML_CONFIG });
    await expectAllow(engine, baseCtx, "DELETE FROM webhooks WHERE id = 1");
  });

  test("INSERT on `read_write` table → allow", async () => {
    const { engine } = makeEngine({ tableAccess: YAML_CONFIG });
    await expectAllow(engine, baseCtx, "INSERT INTO feature_flags (name) VALUES ('beta')");
  });

  test("UPDATE on `read_write` table → allow", async () => {
    const { engine } = makeEngine({ tableAccess: YAML_CONFIG });
    await expectAllow(engine, baseCtx, "UPDATE feature_flags SET enabled = true WHERE name = 'beta'");
  });

  test("read on `deny` table → deny", async () => {
    const { engine } = makeEngine({ tableAccess: YAML_CONFIG });
    await expectDeny(engine, baseCtx, "SELECT * FROM audit_log", TABLE_ACCESS);
  });

  test("write on `deny` table → deny", async () => {
    const { engine } = makeEngine({ tableAccess: YAML_CONFIG });
    await expectDeny(engine, baseCtx, "INSERT INTO audit_log (msg) VALUES ('x')", TABLE_ACCESS);
  });

  test("CTE write at depth on `read` → deny on inner DELETE", async () => {
    const { engine } = makeEngine({ tableAccess: YAML_CONFIG });
    await expectDeny(
      engine,
      baseCtx,
      "WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x",
      TABLE_ACCESS,
    );
  });

  test("CTE write at depth on `read_write` → allow", async () => {
    const { engine } = makeEngine({ tableAccess: YAML_CONFIG });
    await expectAllow(
      engine,
      baseCtx,
      "WITH x AS (DELETE FROM webhooks RETURNING *) SELECT * FROM x",
    );
  });

  test("INSERT INTO read_write SELECT FROM deny → deny on read side", async () => {
    const { engine } = makeEngine({ tableAccess: YAML_CONFIG });
    await expectDeny(
      engine,
      baseCtx,
      "INSERT INTO webhooks (msg) SELECT msg FROM audit_log",
      TABLE_ACCESS,
    );
  });

  test("INSERT INTO read_write SELECT FROM read → allow", async () => {
    const { engine } = makeEngine({ tableAccess: YAML_CONFIG });
    await expectAllow(
      engine,
      baseCtx,
      "INSERT INTO webhooks (uid) SELECT id FROM users",
    );
  });

  test("schema-qualified key matches before bare name", async () => {
    const cfg: TableAccessConfig = {
      default: "read",
      tables: {
        "stripe.charges": "read_write",
        // intentionally no bare `charges` key
      },
    };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectAllow(engine, baseCtx, "SELECT * FROM stripe.charges WHERE id = 1");
    await expectAllow(engine, baseCtx, "DELETE FROM stripe.charges WHERE id = 1");
  });

  test("DROP TABLE on schema-qualified `read_write` → allow", async () => {
    const cfg: TableAccessConfig = {
      default: "read",
      tables: { "stripe.charges": "read_write" },
    };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectAllow(engine, baseCtx, "DROP TABLE stripe.charges");
  });

  test("bare-name match wins when schema-qualified key absent", async () => {
    const cfg: TableAccessConfig = {
      default: "deny",
      tables: { charges: "read" },
    };
    const { engine } = makeEngine({ tableAccess: cfg });
    // public.charges resolves: try `public.charges` (miss) → try `charges` (read).
    await expectAllow(engine, baseCtx, "SELECT * FROM public.charges");
  });

  test("schema-qualified key on `read` denies write", async () => {
    // YAML_CONFIG: "stripe.charges": "read"
    const { engine } = makeEngine({ tableAccess: YAML_CONFIG });
    await expectAllow(engine, baseCtx, "SELECT * FROM stripe.charges");
    await expectDeny(engine, baseCtx, "DELETE FROM stripe.charges", TABLE_ACCESS);
  });

  test("YAML present, table unlisted, default `read`, write → deny", async () => {
    const { engine } = makeEngine({ tableAccess: YAML_CONFIG });
    await expectDeny(engine, baseCtx, "INSERT INTO unlisted (n) VALUES (1)", TABLE_ACCESS);
  });

  test("YAML present, table unlisted, default `read`, read → allow", async () => {
    const { engine } = makeEngine({ tableAccess: YAML_CONFIG });
    await expectAllow(engine, baseCtx, "SELECT * FROM unlisted");
  });

  test("default `deny`: read on unlisted table → deny", async () => {
    const cfg: TableAccessConfig = { default: "deny", tables: { allowed: "read" } };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectDeny(engine, baseCtx, "SELECT * FROM something", TABLE_ACCESS);
  });

  test("default `deny`: read on listed `read` table → allow", async () => {
    const cfg: TableAccessConfig = { default: "deny", tables: { allowed: "read" } };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectAllow(engine, baseCtx, "SELECT * FROM allowed");
  });
});

// ─── Bare → public.<name> fallback (search_path implicit resolution) ──────
//
// Postgres's default search_path resolves `FROM users` to `public.users` on
// 99% of setups. Operators writing per-table policy use the canonical
// schema-qualified form (`public.users`), not the syntactic form the agent
// happens to use (`FROM users`). The lookup order tries `public.<name>`
// before the bare key for bare refs so the two match without forcing
// operators to double-list every table.

describe("adversarial/table-access: bare → public.<name> fallback", () => {
  test("default `deny` + `public.users: read` + `FROM users` → allow (the new fallback)", async () => {
    const cfg: TableAccessConfig = {
      default: "deny",
      tables: { "public.users": "read" },
    };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectAllow(engine, baseCtx, "SELECT COUNT(*) FROM users");
  });

  test("default `deny` + `public.users: read` + `FROM other_schema.users` → deny (different schema)", async () => {
    // Qualified ref to a non-public schema must not pick up public.* policy.
    const cfg: TableAccessConfig = {
      default: "deny",
      tables: { "public.users": "read" },
    };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectDeny(
      engine,
      baseCtx,
      "SELECT * FROM other_schema.users",
      TABLE_ACCESS,
    );
  });

  test("ambiguous policy: `public.users: deny` + `users: read_write` + bare ref → qualified form wins (deny)", async () => {
    // When both keys are present for a bare ref, public.<name> matches first.
    // Deny beats allow when the operator clearly identified the table by
    // schema-qualified path — the safer interpretation.
    const cfg: TableAccessConfig = {
      default: "deny",
      tables: { "public.users": "deny", users: "read_write" },
    };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectDeny(engine, baseCtx, "SELECT * FROM users", TABLE_ACCESS);
  });

  test("default `deny` + `users: read` + `FROM users` → allow (bare-key fallback still works)", async () => {
    // Operators who wrote bare-key policies before the public.<name>
    // fallback existed don't regress: bare ref → public.users miss → bare
    // `users` hit.
    const cfg: TableAccessConfig = {
      default: "deny",
      tables: { users: "read" },
    };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectAllow(engine, baseCtx, "SELECT * FROM users");
  });

  test("`public.users: read` + write `INSERT INTO users` → deny (read perm doesn't satisfy write)", async () => {
    // The new fallback resolves the table; write-target check still
    // requires `read_write`.
    const cfg: TableAccessConfig = {
      default: "deny",
      tables: { "public.users": "read" },
    };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectDeny(
      engine,
      baseCtx,
      "INSERT INTO users (id, name) VALUES (1, 'a')",
      TABLE_ACCESS,
    );
  });

  test("CTE name shadows even when `public.<name>` policy entry exists", async () => {
    // `WITH users AS (...) SELECT * FROM users` — the bare RangeVar `users`
    // is a CTE reference. CTE shadowing must run before policy lookup so
    // the public.users key isn't consulted.
    const cfg: TableAccessConfig = {
      default: "read",
      tables: { "public.users": "deny" },
    };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectAllow(
      engine,
      baseCtx,
      "WITH users AS (SELECT 1) SELECT * FROM users",
    );
  });
});

// ─── CTE-name shadowing (regression for review feedback) ───────────────────
//
// libpg-query represents `FROM <cte_name>` with the same RangeVar shape it
// uses for base tables. Without explicit shadowing, `default: deny` would
// incorrectly reject `WITH x AS (...) SELECT * FROM x` (no `x` in the YAML)
// and a CTE name colliding with a denied table would be conflated with the
// real table. These tests pin the lexical-scope behavior.

describe("adversarial/table-access: CTE-name shadowing", () => {
  test("default `deny`: WITH x AS (...) SELECT FROM x → allow when no real tables touched", async () => {
    const cfg: TableAccessConfig = { default: "deny", tables: {} };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectAllow(engine, baseCtx, "WITH x AS (SELECT 1) SELECT * FROM x");
  });

  test("CTE name colliding with `deny` table → CTE shadows base table", async () => {
    const cfg: TableAccessConfig = { default: "read", tables: { audit_log: "deny" } };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectAllow(
      engine,
      baseCtx,
      "WITH audit_log AS (SELECT 1) SELECT * FROM audit_log",
    );
  });

  test("schema-qualified ref does NOT match a CTE name", async () => {
    const cfg: TableAccessConfig = { default: "read", tables: { audit_log: "deny" } };
    const { engine } = makeEngine({ tableAccess: cfg });
    // Outer ref is public.audit_log — schema-qualified, never a CTE; falls
    // back to the bare `audit_log` key (deny).
    await expectDeny(
      engine,
      baseCtx,
      "WITH audit_log AS (SELECT 1) SELECT * FROM public.audit_log",
      TABLE_ACCESS,
    );
  });

  test("CTE body still checked against policy", async () => {
    const cfg: TableAccessConfig = { default: "read", tables: { audit_log: "deny" } };
    const { engine } = makeEngine({ tableAccess: cfg });
    // Outer `cte` is a CTE (skipped); inner `audit_log` is the real table
    // and resolves to deny → read_blocked.
    await expectDeny(
      engine,
      baseCtx,
      "WITH cte AS (SELECT * FROM audit_log) SELECT * FROM cte",
      TABLE_ACCESS,
    );
  });

  test("self-shadow: CTE named after a denied table reads the REAL table → deny", async () => {
    // The self-shadow read bypass. A non-recursive CTE's name does NOT bind in
    // its own body, so `WITH audit_log AS (SELECT * FROM audit_log) ...` reads
    // the REAL audit_log (deny) in the body — it must NOT be mistaken for a
    // self-reference and skipped. (Regression: this slipped through as an ALLOW
    // until the definingStack fix in the normalized-IR adapter.) The legitimate
    // shadow case above — body reads nothing real — still allows, proving the
    // fix doesn't over-correct.
    const cfg: TableAccessConfig = { default: "read", tables: { audit_log: "deny" } };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectDeny(
      engine,
      baseCtx,
      "WITH audit_log AS (SELECT * FROM audit_log) SELECT * FROM audit_log",
      TABLE_ACCESS,
    );
  });

  test("CTE write at depth on real `read` table still denies", async () => {
    const cfg: TableAccessConfig = { default: "deny", tables: { real: "read" } };
    const { engine } = makeEngine({ tableAccess: cfg });
    // Inner DELETE on `real` (which is `read`, not `read_write`) → deny.
    await expectDeny(
      engine,
      baseCtx,
      "WITH x AS (DELETE FROM real RETURNING *) SELECT * FROM x",
      TABLE_ACCESS,
    );
  });

  test("nested CTEs: inner CTE name only shadows in its own scope", async () => {
    const cfg: TableAccessConfig = { default: "deny", tables: {} };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectAllow(
      engine,
      baseCtx,
      `WITH outer_cte AS (
         WITH inner_cte AS (SELECT 1) SELECT * FROM inner_cte
       ) SELECT * FROM outer_cte`,
    );
  });

  test("RECURSIVE CTE self-reference is treated as CTE, not base table", async () => {
    const cfg: TableAccessConfig = { default: "deny", tables: {} };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectAllow(
      engine,
      baseCtx,
      `WITH RECURSIVE r AS (
         SELECT 1 AS n
         UNION ALL
         SELECT n+1 FROM r WHERE n < 5
       ) SELECT * FROM r`,
    );
  });
});

// ─── information_schema discovery carve-out ───────────────────────────────
//
// information_schema (read-only SQL-standard views over schema, not row
// data) gets an unconditional `read` so agents on default-deny tokens can
// discover what tables exist before asking the operator for access.
// Without this, list_tables / describe_table tools deny under default-deny
// and the human can never be asked "may I read public.users?" — the agent
// doesn't know public.users is a thing. pg_catalog is intentionally NOT
// carved out (pg_roles, pg_proc bodies, pg_settings exceed discovery scope).

describe("adversarial/table-access: information_schema discovery", () => {
  test("default deny + SELECT from information_schema.tables → allow", async () => {
    const cfg: TableAccessConfig = { default: "deny", tables: {} };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectAllow(
      engine,
      baseCtx,
      "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
  });

  test("default deny + SELECT from information_schema.columns → allow (describe_table)", async () => {
    const cfg: TableAccessConfig = { default: "deny", tables: {} };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectAllow(
      engine,
      baseCtx,
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users'",
    );
  });

  test("default deny + JOIN information_schema.tables with public.users → deny on user table", async () => {
    // The metadata-schema RangeVar is allowed but the public.users RangeVar
    // still gets checked against the policy and resolves to default deny.
    const cfg: TableAccessConfig = { default: "deny", tables: {} };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectDeny(
      engine,
      baseCtx,
      "SELECT t.table_name, u.id FROM information_schema.tables t JOIN public.users u ON true",
      TABLE_ACCESS,
    );
  });

  test("explicit `information_schema.tables: deny` ignored — carve-out is unconditional", async () => {
    const cfg: TableAccessConfig = {
      default: "deny",
      tables: { "information_schema.tables": "deny" },
    };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectAllow(
      engine,
      baseCtx,
      "SELECT table_name FROM information_schema.tables",
    );
  });

  test("default deny + UPDATE on information_schema.* → still deny via write path", async () => {
    // Carve-out resolves to "read", which fails the read_write requirement
    // a write target imposes — so writes against metadata schemas still deny.
    const cfg: TableAccessConfig = { default: "deny", tables: {} };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectDeny(
      engine,
      baseCtx,
      "UPDATE information_schema.tables SET table_name = 'x'",
      TABLE_ACCESS,
    );
  });

  test("pg_catalog is NOT carved out — default deny + SELECT pg_catalog.pg_roles → deny", async () => {
    // Catalog leaks beyond schema discovery (pg_roles names, pg_proc bodies,
    // pg_settings server config) so it stays subject to policy.
    const cfg: TableAccessConfig = { default: "deny", tables: {} };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectDeny(
      engine,
      baseCtx,
      "SELECT rolname FROM pg_catalog.pg_roles",
      TABLE_ACCESS,
    );
  });

  test("pg_catalog allowed when default permits or table explicitly listed", async () => {
    // Sanity: pg_catalog isn't blacklisted, just not carved out. With
    // default `read` it allows, matching the V1 trust posture.
    const cfg: TableAccessConfig = { default: "read", tables: {} };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectAllow(engine, baseCtx, "SELECT tablename FROM pg_catalog.pg_tables");
  });

  test("carve-out does NOT extend to pg_temp_* or other schemas", async () => {
    const cfg: TableAccessConfig = { default: "deny", tables: {} };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectDeny(
      engine,
      baseCtx,
      "SELECT * FROM pg_temp_3.scratch",
      TABLE_ACCESS,
    );
  });
});

// ─── COPY / LOCK side-effect denials (regression for review feedback) ─────
//
// COPY moves data on the server filesystem; LOCK takes a transaction-scoped
// concurrency hold with availability impact. Both have side effects beyond
// per-table row writes that the YAML can't reasonably grant. They deny
// unconditionally — `webhooks: read_write` MUST NOT enable
// `COPY webhooks TO '/tmp/leak'` or `LOCK TABLE webhooks IN ACCESS EXCLUSIVE`.

describe("adversarial/table-access: COPY/LOCK unconditional deny", () => {
  test("COPY webhooks TO '/tmp/leak' → deny even when webhooks is read_write", async () => {
    const cfg: TableAccessConfig = { default: "read", tables: { webhooks: "read_write" } };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectDeny(engine, baseCtx, "COPY webhooks TO '/tmp/leak'", TABLE_ACCESS);
  });

  test("COPY webhooks FROM '/etc/passwd' → deny even when webhooks is read_write", async () => {
    const cfg: TableAccessConfig = { default: "read", tables: { webhooks: "read_write" } };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectDeny(engine, baseCtx, "COPY webhooks FROM '/etc/passwd'", TABLE_ACCESS);
  });

  test("LOCK TABLE webhooks → deny even when webhooks is read_write", async () => {
    const cfg: TableAccessConfig = { default: "read", tables: { webhooks: "read_write" } };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectDeny(
      engine,
      baseCtx,
      "LOCK TABLE webhooks IN ACCESS EXCLUSIVE MODE",
      TABLE_ACCESS,
    );
  });
});

// ─── SET (VariableSetStmt) unconditional deny ─────────────────────────────
//
// `SET search_path = ...` would let an agent redirect bare-name table
// resolution on a pooled connection, breaking the policy engine's
// "bare → public.<name>" guarantee that pairs with PgPoolExecutor's
// search_path pin. Every SET denies unconditionally; the YAML can't
// grant any of them safely (no per-table target), and SET is rarely
// needed in agent SQL. This pairs with the executor-side search_path
// pin in `packages/mcp-server/src/executor/pg-pool.ts`.

describe("adversarial/table-access: SET unconditional deny", () => {
  test("SET search_path = malicious → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "SET search_path = malicious_schema", TABLE_ACCESS);
  });

  test("SET search_path with multiple schemas → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "SET search_path = malicious_schema, public",
      TABLE_ACCESS,
    );
  });

  test("SET timezone = 'UTC' → deny (any SET, not just search_path)", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "SET timezone = 'UTC'", TABLE_ACCESS);
  });

  test("SET LOCAL search_path → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "SET LOCAL search_path = elsewhere", TABLE_ACCESS);
  });

  test("SET SESSION search_path → deny", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "SET SESSION search_path = elsewhere", TABLE_ACCESS);
  });

  test("RESET search_path → deny (RESET parses as VariableSetStmt)", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "RESET search_path", TABLE_ACCESS);
  });

  test("SET denies under YAML config too — no key can grant it", async () => {
    const cfg: TableAccessConfig = {
      default: "read_write",
      tables: { users: "read_write" },
    };
    const { engine } = makeEngine({ tableAccess: cfg });
    await expectDeny(engine, baseCtx, "SET search_path = whatever", TABLE_ACCESS);
  });
});

// `SELECT … INTO new_table` is the legacy spelling of `CREATE TABLE new_table AS
// SELECT …`. libpg models it as a SelectStmt with an intoClause (NOT a
// CreateTableAsStmt), so it used to be classified as a plain read and a
// read-only (`default: read`) policy ALLOWED it — letting a read-only agent
// materialize a table (snapshot a table it can read, or fill disk). Issue #109.
// The fix governs the creation target exactly like CreateTableAsStmt's target,
// so the two spellings are now indistinguishable to the policy.
describe("adversarial/table-access: SELECT … INTO (issue #109)", () => {
  test("default: read → write to the creation target is denied", async () => {
    const { engine } = makeEngine({ tableAccess: { default: "read", tables: {} } });
    const d = await engine.handle({
      sql: "SELECT id, email INTO _mp_leaked FROM users",
      ctx: baseCtx,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe(TABLE_ACCESS);
      // The reason names the WRITE to the new table, not a read.
      expect(d.message).toContain("writes to table `_mp_leaked`");
    }
  });

  test("schema-qualified target → denied on the qualified name", async () => {
    const { engine } = makeEngine({ tableAccess: { default: "read", tables: {} } });
    const d = await engine.handle({
      sql: "SELECT id INTO public.snapshot FROM users",
      ctx: baseCtx,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.message).toContain("writes to table `public.snapshot`");
  });

  test("read side is still enforced — INTO a writable target FROM a denied table denies the read", async () => {
    const { engine } = makeEngine({
      tableAccess: { default: "read", tables: { dst: "read_write", secrets: "deny" } },
    });
    await expectDeny(engine, baseCtx, "SELECT * INTO dst FROM secrets", TABLE_ACCESS);
  });

  test("read_write target → allowed (operator authorized the write), same as CREATE TABLE AS", async () => {
    const cfg: TableAccessConfig = {
      default: "read",
      tables: { snapshot: "read_write", users: "read" },
    };
    const into = makeEngine({ tableAccess: cfg });
    const ctas = makeEngine({ tableAccess: cfg });
    await expectAllow(into.engine, baseCtx, "SELECT id INTO snapshot FROM users");
    // The twin spelling resolves identically — the fix unified them.
    await expectAllow(ctas.engine, baseCtx, "CREATE TABLE snapshot AS SELECT id FROM users");
  });

  test("read-only scope ceiling denies INTO even when policy permits the write", async () => {
    // Policy would allow the write (default read_write), but the session's
    // per-agent credential is scoped read-only — the table-creating copy is the
    // exact exfil vector that clamp exists to stop.
    const { engine } = makeEngine({ tableAccess: { default: "read_write", tables: {} } });
    const d = await engine.handle({
      sql: "SELECT id, email INTO _mp_leaked FROM users",
      ctx: { ...baseCtx, scope_max_access: "read" },
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe(TABLE_ACCESS);
      expect(d.message).toContain("scoped to read-only");
    }
  });
});
