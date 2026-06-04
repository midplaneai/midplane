// DECIDED audit rows carry the dialect.
//
// The engine stamps `this.dialect.name` on every DECIDED payload (ALLOW + DENY)
// so audit consumers can group/filter per dialect. Additive optional field
// under schema_version 3 — no migration. Postgres-only build: every row stamps
// "postgres"; the field exists so a future dialect needs no schema change.

import { describe, expect, test } from "bun:test";
import { MemoryAuditWriter, makeEngine, baseCtx } from "./_helpers.ts";

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

  test("postgres engine stamps dialect on DENY too", async () => {
    const { engine, audit } = makeEngine();
    // Default posture denies writes via table_access.
    await engine.handle({ sql: "DELETE FROM users WHERE id = 1", ctx: baseCtx });
    const p = decidedPayload(audit);
    expect(p.decision).toBe("DENY");
    expect(p.dialect).toBe("postgres");
  });
});
