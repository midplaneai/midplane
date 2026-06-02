// MySQL dialect — IR (normalize) pins.
//
// Pins the NormalizedProgram the MySQL adapter emits for representative shapes,
// especially the fail-closed security paths (USE, cross-DB, unknown statements)
// where the IR must carry BOTH an `unsupported` entry (tenant_scope fail-closed)
// AND a synthetic no_target AccessCheck (table_access deny). Behavioral verdicts
// are covered by adversarial/; this file locks the IR structure itself.

import { describe, expect, test } from "bun:test";
import { parse } from "../../../src/dialects/mysql/parse.ts";
import { createMysqlDialect } from "../../../src/dialects/mysql/index.ts";
import type { NormalizedProgram } from "../../../src/ir/types.ts";

const dialect = createMysqlDialect({ database: "appdb" });

async function ir(sql: string): Promise<NormalizedProgram> {
  const r = await parse(sql);
  if (!r.ok) throw new Error(`parse failed: ${r.error}`);
  return dialect.normalize(r.ast);
}

describe("dialects/mysql normalize: SELECT", () => {
  test("scoped select → read check + scope unit, no unsupported", async () => {
    const p = await ir("SELECT id FROM users WHERE org_id = 42");
    expect(p.statementCount).toBe(1);
    expect(p.auditStatementType).toBe("SELECT");
    expect(p.allRelnames).toEqual(["users"]);
    expect(p.unsupported).toEqual([]);
    expect(p.accessChecks).toEqual([{ kind: "read", ref: { schema: null, relname: "users", effectiveName: "users", alias: null } }]);
    expect(p.scopeUnits).toEqual([
      {
        kind: "scope",
        tables: [{ schema: null, relname: "users", effectiveName: "users", alias: null }],
        predicates: [{ qualifier: null, column: "org_id", literal: "42" }],
      },
    ]);
  });

  test("aliased qualifier and integer literal stringified", async () => {
    const p = await ir("SELECT u.id FROM users u WHERE u.org_id = 42");
    const unit = p.scopeUnits[0]!;
    if (unit.kind !== "scope") throw new Error("expected scope");
    expect(unit.tables[0]!.effectiveName).toBe("u");
    expect(unit.predicates).toEqual([{ qualifier: "u", column: "org_id", literal: "42" }]);
  });

  test("own-database qualifier normalizes to bare (schema null)", async () => {
    const p = await ir("SELECT * FROM appdb.users WHERE appdb.users.org_id = 42");
    expect(p.unsupported).toEqual([]);
    const read = p.accessChecks.find((c) => c.kind === "read");
    expect(read && read.kind === "read" ? read.ref.schema : "x").toBeNull();
    const unit = p.scopeUnits[0]!;
    if (unit.kind !== "scope") throw new Error("expected scope");
    // The own-db column qualifier collapses to the table name.
    expect(unit.predicates).toEqual([{ qualifier: "users", column: "org_id", literal: "42" }]);
  });

  test("information_schema ref carries schema=information_schema (carve-out)", async () => {
    const p = await ir("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    expect(p.unsupported).toEqual([]);
    const read = p.accessChecks.find((c) => c.kind === "read");
    expect(read && read.kind === "read" ? read.ref.schema : null).toBe("information_schema");
  });

  test("AND-only equality predicates collected; OR arm excluded", async () => {
    const p = await ir("SELECT * FROM users WHERE org_id = 42 AND name = 'x'");
    const unit = p.scopeUnits[0]!;
    if (unit.kind !== "scope") throw new Error("expected scope");
    expect(unit.predicates).toEqual([
      { qualifier: null, column: "org_id", literal: "42" },
      { qualifier: null, column: "name", literal: "x" },
    ]);

    const orP = await ir("SELECT * FROM users WHERE org_id = 42 OR id = 1");
    const orUnit = orP.scopeUnits[0]!;
    if (orUnit.kind !== "scope") throw new Error("expected scope");
    expect(orUnit.predicates).toEqual([]); // OR does not strengthen → nothing collected
  });

  test("UNION arms each emit their own scope unit", async () => {
    const p = await ir("SELECT * FROM users WHERE org_id = 42 UNION SELECT * FROM posts WHERE org_id = 42");
    expect(p.scopeUnits.length).toBe(2);
  });

  test("subquery emits a nested scope unit; outer + inner both present", async () => {
    const p = await ir("SELECT * FROM users WHERE id IN (SELECT user_id FROM memberships WHERE org_id = 42)");
    expect(p.scopeUnits.length).toBe(2);
    // both users (outer) and memberships (inner) appear as reads
    const readNames = p.accessChecks.filter((c) => c.kind === "read").map((c) => (c.kind === "read" ? c.ref.relname : ""));
    expect(readNames).toContain("users");
    expect(readNames).toContain("memberships");
  });
});

describe("dialects/mysql normalize: writes", () => {
  test("INSERT → write check + insert scope unit with valuesRows", async () => {
    const p = await ir("INSERT INTO users (id, org_id) VALUES (1, 42)");
    expect(p.auditStatementType).toBe("INSERT");
    expect(p.accessChecks).toContainEqual({ kind: "write", ref: { schema: null, relname: "users", effectiveName: "users", alias: null } });
    const unit = p.scopeUnits[0]!;
    if (unit.kind !== "insert") throw new Error("expected insert unit");
    expect(unit.shape.hasExplicitColumns).toBe(true);
    expect(unit.shape.columns).toEqual(["id", "org_id"]);
    expect(unit.shape.valuesRows).toEqual([["1", "42"]]);
    expect(unit.shape.onConflictDoUpdate).toBe(false);
  });

  test("INSERT … ON DUPLICATE KEY UPDATE sets onConflictDoUpdate", async () => {
    const p = await ir("INSERT INTO users (id, org_id) VALUES (1, 42) ON DUPLICATE KEY UPDATE id = 2");
    const unit = p.scopeUnits[0]!;
    if (unit.kind !== "insert") throw new Error("expected insert unit");
    expect(unit.shape.onConflictDoUpdate).toBe(true);
  });

  test("REPLACE forces the upsert deny path (onConflictDoUpdate=true)", async () => {
    const p = await ir("REPLACE INTO users (id, org_id) VALUES (1, 42)");
    expect(p.auditStatementType).toBe("REPLACE");
    const unit = p.scopeUnits[0]!;
    if (unit.kind !== "insert") throw new Error("expected insert unit");
    expect(unit.shape.onConflictDoUpdate).toBe(true);
  });

  test("INSERT … SELECT → valuesRows null (deny path) + source reads", async () => {
    const p = await ir("INSERT INTO users (id, org_id) SELECT a, b FROM staging");
    const unit = p.scopeUnits.find((u) => u.kind === "insert");
    if (!unit || unit.kind !== "insert") throw new Error("expected insert unit");
    expect(unit.shape.valuesRows).toBeNull();
    const readNames = p.accessChecks.filter((c) => c.kind === "read").map((c) => (c.kind === "read" ? c.ref.relname : ""));
    expect(readNames).toContain("staging");
  });

  test("UPDATE → write check on target before read; scope over base tables", async () => {
    const p = await ir("UPDATE users SET name = 'x' WHERE org_id = 42");
    expect(p.accessChecks[0]).toEqual({ kind: "write", ref: { schema: null, relname: "users", effectiveName: "users", alias: null } });
    const unit = p.scopeUnits[0]!;
    if (unit.kind !== "scope") throw new Error("expected scope");
    expect(unit.predicates).toEqual([{ qualifier: null, column: "org_id", literal: "42" }]);
  });

  test("DELETE → write check on target", async () => {
    const p = await ir("DELETE FROM users WHERE org_id = 42");
    expect(p.accessChecks.some((c) => c.kind === "write" && c.ref.relname === "users")).toBe(true);
  });

  test("DROP TABLE → write check, no scope unit", async () => {
    const p = await ir("DROP TABLE webhooks");
    expect(p.auditStatementType).toBe("DROP");
    expect(p.accessChecks).toEqual([{ kind: "write", ref: { schema: null, relname: "webhooks", effectiveName: "webhooks", alias: null } }]);
    expect(p.scopeUnits).toEqual([]);
  });
});

describe("dialects/mysql normalize: fail-closed (RED)", () => {
  test("USE → unsupported{USE} AND synthetic no_target", async () => {
    const p = await ir("USE otherdb");
    expect(p.unsupported.map((u) => u.keyword)).toEqual(["USE"]);
    expect(p.accessChecks).toEqual([{ kind: "no_target", keyword: "USE" }]);
  });

  test("cross-database table ref → unsupported + no_target + touchedTables", async () => {
    const p = await ir("SELECT * FROM otherdb.users WHERE otherdb.users.org_id = 42");
    expect(p.unsupported.length).toBe(1);
    expect(p.unsupported[0]!.keyword).toBe("cross-database reference");
    // touchedTables carries the relation so tenant_scope fails closed.
    expect(p.unsupported[0]!.touchedTables.some((t) => t.relname === "users")).toBe(true);
    expect(p.accessChecks).toContainEqual({ kind: "no_target", keyword: "cross-database reference" });
    // No read/write checks leak past the guard.
    expect(p.accessChecks.every((c) => c.kind === "no_target")).toBe(true);
  });

  test("cross-database ref hidden only in a column qualifier still rejected", async () => {
    const p = await ir("SELECT * FROM users WHERE otherdb.users.org_id = 42");
    expect(p.unsupported.length).toBe(1);
    expect(p.accessChecks).toContainEqual({ kind: "no_target", keyword: "cross-database reference" });
  });

  test("CALL → no_target, no unsupported entry (side-effect, like PG)", async () => {
    const p = await ir("CALL do_thing()");
    expect(p.accessChecks).toEqual([{ kind: "no_target", keyword: "CALL" }]);
    expect(p.unsupported).toEqual([]);
  });

  test("SET → no_target (session-mutator deny analog)", async () => {
    const p = await ir("SET autocommit = 0");
    expect(p.accessChecks).toEqual([{ kind: "no_target", keyword: "SET" }]);
    expect(p.unsupported).toEqual([]);
  });
});

describe("dialects/mysql normalize: strict fallback (database unknown)", () => {
  test("any explicit db qualifier rejected when database is null", async () => {
    const strict = createMysqlDialect(); // database unknown
    const r = await parse("SELECT * FROM appdb.users WHERE appdb.users.org_id = 42");
    if (!r.ok) throw new Error("parse failed");
    const p = strict.normalize(r.ast);
    expect(p.unsupported.length).toBe(1);
    expect(p.unsupported[0]!.keyword).toBe("cross-database reference");
  });

  test("information_schema still allowed in strict fallback", async () => {
    const strict = createMysqlDialect();
    const r = await parse("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    if (!r.ok) throw new Error("parse failed");
    const p = strict.normalize(r.ast);
    expect(p.unsupported).toEqual([]);
  });
});

describe("dialects/mysql normalize: multi-statement", () => {
  test("statementCount reflects array length", async () => {
    const p = await ir("SELECT 1; SELECT 2");
    expect(p.statementCount).toBe(2);
  });
});
