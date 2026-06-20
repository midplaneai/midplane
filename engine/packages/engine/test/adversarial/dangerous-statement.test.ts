// Adversarial corpus — dangerous_statement (destructive-op guardrails).
//
// The "an agent can't nuke prod" net: block whole-table DML and DDL REGARDLESS
// of table_access / tenant_scope policy. Wired LAST in the chain, so a
// more-specific rule's denial still wins when one applies; the guardrail only
// adds NEW denials for statements every other rule permitted (notably writes to
// `read_write` tables). Two independently-toggled guards: block_unqualified_dml
// (DELETE/UPDATE with no WHERE) and block_ddl (DROP/TRUNCATE/ALTER).

import { describe, test } from "bun:test";
import { makeEngine, baseCtx, tenantScopedCtx } from "../_helpers.ts";
import { PolicyRule } from "../../src/audit/types.ts";
import type { TableAccessConfig } from "../../src/policy/rules/table-access.ts";
import type { DangerousStatementConfig } from "../../src/policy/rules/dangerous-statement.ts";
import { parseError } from "../../src/policy/rules/parse-error.ts";
import { multiStatement } from "../../src/policy/rules/multi-statement.ts";
import { tableAccess } from "../../src/policy/rules/table-access.ts";
import { tenantScope } from "../../src/policy/rules/tenant-scope.ts";
import { dangerousStatement } from "../../src/policy/rules/dangerous-statement.ts";
import { expectDeny, expectAllow, expectDecidedDeny } from "./_helpers.ts";

const DANGEROUS = PolicyRule.DANGEROUS_STATEMENT;
const TABLE_ACCESS = PolicyRule.TABLE_ACCESS;
const TENANT = PolicyRule.TENANT_SCOPE_MISSING;

const BOTH_ON: DangerousStatementConfig = { blockUnqualifiedDml: true, blockDdl: true };

// table_access permits everything, so the guardrail is unambiguously the denier
// — this isolates "blocked regardless of (even maximally permissive) policy."
const PERMISSIVE: TableAccessConfig = { default: "read_write", tables: {} };

// A realistic mix for ordering tests: `users` read, `webhooks`/`posts`
// read_write. `posts` is also tenant-scoped via tenantScopedCtx (org_id).
const MIXED: TableAccessConfig = {
  default: "read",
  tables: { users: "read", webhooks: "read_write", posts: "read_write" },
};

// Full production chain, guardrails + table_access configurable. tenant_scope
// reads ctx mappings (off for baseCtx, on for tenantScopedCtx), as in production.
function guardedEngine(
  guardrails: DangerousStatementConfig = BOTH_ON,
  config: TableAccessConfig = PERMISSIVE,
) {
  return makeEngine({
    rules: [
      parseError(),
      multiStatement(),
      tableAccess(config),
      tenantScope(),
      dangerousStatement(guardrails),
    ],
  });
}

describe("adversarial/dangerous-statement: block_ddl", () => {
  test("DROP TABLE → deny dangerous_statement (regardless of read_write policy)", async () => {
    const { engine, audit } = guardedEngine();
    await expectDeny(engine, baseCtx, "DROP TABLE webhooks", DANGEROUS);
    expectDecidedDeny(audit, DANGEROUS);
  });

  test("TRUNCATE → deny", async () => {
    const { engine } = guardedEngine();
    await expectDeny(engine, baseCtx, "TRUNCATE webhooks", DANGEROUS);
  });

  test("ALTER TABLE … ADD COLUMN → deny", async () => {
    const { engine } = guardedEngine();
    await expectDeny(engine, baseCtx, "ALTER TABLE webhooks ADD COLUMN flag boolean", DANGEROUS);
  });

  test("ALTER TABLE … RENAME (RenameStmt) → deny", async () => {
    const { engine } = guardedEngine();
    await expectDeny(engine, baseCtx, "ALTER TABLE webhooks RENAME TO hooks", DANGEROUS);
  });

  test("DROP INDEX → deny", async () => {
    const { engine } = guardedEngine();
    await expectDeny(engine, baseCtx, "DROP INDEX webhooks_idx", DANGEROUS);
  });

  test("DROP SCHEMA → table_access (no_target) catches it first; still denied", async () => {
    // DROP on a non-table object (schema) has no per-table target, so
    // table_access denies it as no_target before the guardrail is reached.
    // Layered defense: the destructive op is blocked either way.
    const { engine } = guardedEngine();
    await expectDeny(engine, baseCtx, "DROP SCHEMA public CASCADE", TABLE_ACCESS);
  });

  test("SELECT … INTO under default:read + block_ddl ON → denied (table_access catches the table-creating copy first)", async () => {
    // Issue #109: `SELECT … INTO foo` creates a table but parses as a SelectStmt
    // (not CreateTableAsStmt), so it once passed the read-only policy AND the
    // block_ddl guardrail. With the fix the creation target is a write, so
    // table_access denies it before the guardrail is reached — denied either way,
    // exactly like `CREATE TABLE foo AS SELECT …`.
    const READ_ONLY: TableAccessConfig = { default: "read", tables: {} };
    const { engine } = guardedEngine(BOTH_ON, READ_ONLY);
    await expectDeny(engine, baseCtx, "SELECT id, email INTO _mp_leaked FROM users", TABLE_ACCESS);
  });

  test("SELECT … INTO on a read_write policy + block_ddl ON → allowed, same as CREATE TABLE AS", async () => {
    // block_ddl deliberately does NOT cover table creation in v1 (CREATE is
    // excluded); when the operator grants read_write to the target, the
    // table-creating copy is authorized — and the two spellings stay consistent.
    const { engine } = guardedEngine(BOTH_ON, PERMISSIVE);
    await expectAllow(engine, baseCtx, "SELECT id INTO snapshot FROM users");
    await expectAllow(engine, baseCtx, "CREATE TABLE snapshot AS SELECT id FROM users");
  });

  test("block_ddl: false → DDL allowed by the guardrail (table_access permits)", async () => {
    const { engine } = guardedEngine({ blockUnqualifiedDml: true, blockDdl: false });
    await expectAllow(engine, baseCtx, "DROP TABLE webhooks");
  });

  test("block_ddl: false → DROP on a `read` table still denied by table_access", async () => {
    const { engine } = guardedEngine({ blockUnqualifiedDml: true, blockDdl: false }, MIXED);
    await expectDeny(engine, baseCtx, "DROP TABLE users", TABLE_ACCESS);
  });
});

describe("adversarial/dangerous-statement: block_unqualified_dml", () => {
  test("DELETE with no WHERE → deny dangerous_statement", async () => {
    const { engine, audit } = guardedEngine();
    await expectDeny(engine, baseCtx, "DELETE FROM webhooks", DANGEROUS);
    expectDecidedDeny(audit, DANGEROUS);
  });

  test("UPDATE with no WHERE → deny", async () => {
    const { engine } = guardedEngine();
    await expectDeny(engine, baseCtx, "UPDATE webhooks SET enabled = true", DANGEROUS);
  });

  test("DELETE WITH a WHERE → allow (guardrail is missing-WHERE only)", async () => {
    const { engine } = guardedEngine();
    await expectAllow(engine, baseCtx, "DELETE FROM webhooks WHERE id = 1");
  });

  test("UPDATE WITH a WHERE → allow", async () => {
    const { engine } = guardedEngine();
    await expectAllow(engine, baseCtx, "UPDATE webhooks SET enabled = true WHERE id = 1");
  });

  test("DELETE WHERE true → allow (an explicit WHERE is not unqualified)", async () => {
    const { engine } = guardedEngine();
    await expectAllow(engine, baseCtx, "DELETE FROM webhooks WHERE true");
  });

  test("no-WHERE DELETE hidden in a CTE → deny (fail-closed on nested DML)", async () => {
    const { engine } = guardedEngine();
    await expectDeny(
      engine,
      baseCtx,
      "WITH d AS (DELETE FROM webhooks RETURNING *) SELECT * FROM d",
      DANGEROUS,
    );
  });

  test("block_unqualified_dml: false → no-WHERE DELETE allowed", async () => {
    const { engine } = guardedEngine({ blockUnqualifiedDml: false, blockDdl: true });
    await expectAllow(engine, baseCtx, "DELETE FROM webhooks");
  });

  test("block_unqualified_dml: false → DDL still blocked", async () => {
    const { engine } = guardedEngine({ blockUnqualifiedDml: false, blockDdl: true });
    await expectDeny(engine, baseCtx, "DROP TABLE webhooks", DANGEROUS);
  });
});

describe("adversarial/dangerous-statement: block_ddl covers the whole ALTER family", () => {
  // Isolated guardrail engine (no table_access) so the guardrail is provably the
  // rule that catches non-table ALTER forms. In the full chain, table_access's
  // no_target denial fires first for the relation-less ones (both deny — defense
  // in depth); these prove the guardrail itself has no ALTER gaps.
  function guardOnlyEngine() {
    return makeEngine({ rules: [parseError(), dangerousStatement(BOTH_ON)] });
  }

  const alters = [
    "ALTER TYPE mood ADD VALUE 'sad'", // AlterEnumStmt — the reviewer's case
    "ALTER ROLE bob WITH PASSWORD 'x'", // AlterRoleStmt
    "ALTER TABLE users SET SCHEMA other", // AlterObjectSchemaStmt
    "ALTER SEQUENCE s RESTART", // AlterSeqStmt
    "ALTER TABLE users RENAME COLUMN a TO b", // RenameStmt
    "ALTER TABLE users RENAME TO u", // RenameStmt (table)
    "ALTER INDEX i RENAME TO j", // RenameStmt (index)
  ];
  for (const sql of alters) {
    test(`guardrail denies \`${sql}\``, async () => {
      const { engine } = guardOnlyEngine();
      await expectDeny(engine, baseCtx, sql, DANGEROUS);
    });
  }

  test("ALTER TYPE … ADD VALUE denies end-to-end even with permissive table_access", async () => {
    // Full chain + default read_write: the non-table ALTER has no per-table
    // target, so table_access's no_target denial catches it first — still
    // blocked (the contract is "ALTER is denied", not "by which rule").
    const { engine } = guardedEngine(BOTH_ON, PERMISSIVE);
    await expectDeny(engine, baseCtx, "ALTER TYPE mood ADD VALUE 'sad'", TABLE_ACCESS);
  });
});

describe("adversarial/dangerous-statement: ALTER opt-out still respects table_access", () => {
  // block_ddl OFF ⇒ ALTER forms fall through to table_access, which must still
  // deny a write to a `read` table. The bug this guards: RenameStmt /
  // AlterObjectSchemaStmt weren't classified as writes, so a `read` table could
  // be renamed / moved when the guardrail was opted out.
  const DDL_OFF: DangerousStatementConfig = { blockUnqualifiedDml: true, blockDdl: false };

  test("ALTER TABLE … RENAME on a `read` table → table_access (block_ddl off)", async () => {
    const { engine } = guardedEngine(DDL_OFF, MIXED);
    await expectDeny(engine, baseCtx, "ALTER TABLE users RENAME TO u", TABLE_ACCESS);
  });

  test("ALTER TABLE … SET SCHEMA on a `read` table → table_access (block_ddl off)", async () => {
    const { engine } = guardedEngine(DDL_OFF, MIXED);
    await expectDeny(engine, baseCtx, "ALTER TABLE users SET SCHEMA other", TABLE_ACCESS);
  });

  test("ALTER TABLE … RENAME on a read_write table → allow (block_ddl off)", async () => {
    // Operator opted out AND marked the table writable — RENAME is allowed,
    // consistent with ALTER TABLE … ADD COLUMN on a read_write table.
    const { engine } = guardedEngine(DDL_OFF, MIXED);
    await expectAllow(engine, baseCtx, "ALTER TABLE webhooks RENAME TO hooks");
  });
});

describe("adversarial/dangerous-statement: ordering (guardrail is last)", () => {
  test("DROP on `read` table → table_access wins (more-specific reason)", async () => {
    const { engine } = guardedEngine(BOTH_ON, MIXED);
    await expectDeny(engine, baseCtx, "DROP TABLE users", TABLE_ACCESS);
  });

  test("no-WHERE DELETE on a read_write + tenant-scoped table → tenant_scope wins", async () => {
    // `posts` is read_write (table_access permits the write) AND scoped on
    // org_id (tenantScopedCtx); tenant_scope denies the missing predicate
    // before the guardrail is reached. Both would deny — the specific reason wins.
    const { engine } = guardedEngine(BOTH_ON, MIXED);
    await expectDeny(engine, tenantScopedCtx, "DELETE FROM posts", TENANT);
  });

  test("no-WHERE DELETE on read_write + unscoped → guardrail is the net that catches it", async () => {
    // table_access allows (read_write), tenant_scope inert (baseCtx) — only the
    // guardrail stands between the agent and a whole-table wipe.
    const { engine } = guardedEngine(BOTH_ON, MIXED);
    await expectDeny(engine, baseCtx, "DELETE FROM webhooks", DANGEROUS);
  });
});

describe("adversarial/dangerous-statement: non-targets", () => {
  test("SELECT is never a dangerous statement → allow", async () => {
    const { engine } = guardedEngine();
    await expectAllow(engine, baseCtx, "SELECT * FROM webhooks");
  });

  test("INSERT is not covered by these guardrails → allow", async () => {
    const { engine } = guardedEngine();
    await expectAllow(engine, baseCtx, "INSERT INTO webhooks (uid) VALUES (1)");
  });

  test("both guards off → no-WHERE DELETE + DDL both allow", async () => {
    const { engine } = guardedEngine({ blockUnqualifiedDml: false, blockDdl: false });
    await expectAllow(engine, baseCtx, "DELETE FROM webhooks");
    await expectAllow(engine, baseCtx, "DROP TABLE webhooks");
  });
});
