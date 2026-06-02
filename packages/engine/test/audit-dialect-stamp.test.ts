// DECIDED audit rows carry the dialect (0.7.0).
//
// The engine stamps `this.dialect.name` on every DECIDED payload (ALLOW + DENY)
// so cross-dialect audit consumers can group/filter per dialect. Additive
// optional field under schema_version 3 — no migration.

import { describe, expect, test } from "bun:test";
import { Engine } from "../src/engine.ts";
import { createMysqlDialect } from "../src/dialects/mysql/index.ts";
import { parseError } from "../src/policy/rules/parse-error.ts";
import { tableAccess } from "../src/policy/rules/table-access.ts";
import { MemoryAuditWriter, MockExecutor, StubCredentialStore, makeEngine, baseCtx } from "./_helpers.ts";

function decidedPayload(audit: MemoryAuditWriter): Record<string, unknown> {
  return audit.byType("DECIDED")[0]!.payload as Record<string, unknown>;
}

describe("DECIDED audit carries dialect", () => {
  test("postgres engine (default) stamps dialect: 'postgres' on ALLOW", async () => {
    const { engine, audit } = makeEngine();
    await engine.handle({ sql: "SELECT 1", ctx: baseCtx });
    const p = decidedPayload(audit);
    expect(p.decision).toBe("ALLOW");
    expect(p.dialect).toBe("postgres");
  });

  test("mysql engine stamps dialect: 'mysql' on ALLOW", async () => {
    const audit = new MemoryAuditWriter();
    const engine = new Engine({
      policy: { rules: [parseError(), tableAccess()] },
      audit,
      credentials: new StubCredentialStore(),
      executor: new MockExecutor(),
      dialect: createMysqlDialect({ database: "appdb" }),
    });
    await engine.handle({ sql: "SELECT 1", ctx: baseCtx });
    const p = decidedPayload(audit);
    expect(p.decision).toBe("ALLOW");
    expect(p.dialect).toBe("mysql");
  });

  test("mysql engine stamps dialect on DENY too", async () => {
    const audit = new MemoryAuditWriter();
    const engine = new Engine({
      policy: { rules: [parseError(), tableAccess()] },
      audit,
      credentials: new StubCredentialStore(),
      executor: new MockExecutor(),
      dialect: createMysqlDialect({ database: "appdb" }),
    });
    // USE → table_access no_target DENY.
    await engine.handle({ sql: "USE otherdb", ctx: baseCtx });
    const p = decidedPayload(audit);
    expect(p.decision).toBe("DENY");
    expect(p.dialect).toBe("mysql");
  });
});
