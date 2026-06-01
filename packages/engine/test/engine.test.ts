// End-to-end Engine tests with a mock execute stage.
//
// Verifies pipeline invariants: order of audit events, audit failure
// aborts execute, executed/failed audit failure does NOT abort.

import { describe, expect, test } from "bun:test";
import { makeEngine, baseCtx, MemoryAuditWriter, MockExecutor } from "./_helpers.ts";
import { Engine } from "../src/engine.ts";
import { AuditUnavailableError } from "../src/errors.ts";
import { tableAccess } from "../src/policy/rules/table-access.ts";
import { multiStatement } from "../src/policy/rules/multi-statement.ts";
import { parseError } from "../src/policy/rules/parse-error.ts";
import { tenantScope } from "../src/policy/rules/tenant-scope.ts";
import { StubCredentialStore } from "./_helpers.ts";

describe("Engine.handle — happy path (ALLOW)", () => {
  test("writes ATTEMPTED, DECIDED, EXECUTED in order — and executes", async () => {
    const { engine, audit, executor } = makeEngine();
    executor.result = { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };

    const d = await engine.handle({ sql: "SELECT id FROM users WHERE org_id=42", ctx: baseCtx });

    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.result.rows.length).toBe(2);
      expect(d.auditId).toBeTruthy();
    }

    // Pipeline order
    expect(audit.events.map((e) => e.event_type)).toEqual([
      "ATTEMPTED",
      "DECIDED",
      "EXECUTED",
    ]);

    // Decided event has ALLOW + statement_type + tables
    const decided = audit.byType("DECIDED")[0]!;
    expect(decided.payload).toMatchObject({ decision: "ALLOW", statement_type: "SELECT" });
    expect((decided.payload as { tables_touched: string[] }).tables_touched).toContain("users");

    // Executor was called once with the original SQL + tenant
    expect(executor.calls).toEqual([{ sql: "SELECT id FROM users WHERE org_id=42", tenant_id: "42" }]);
  });

  test("ATTEMPTED captures sql_fingerprint as 16 hex chars", async () => {
    const { engine, audit } = makeEngine();
    await engine.handle({ sql: "SELECT 1", ctx: baseCtx });
    const attempted = audit.byType("ATTEMPTED")[0]!;
    const payload = attempted.payload as { sql_fingerprint: string; sql_raw: string };
    expect(payload.sql_fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(payload.sql_raw).toBe("SELECT 1");
  });

  test("fingerprint stable across literal changes (normalization)", async () => {
    const { engine: e1, audit: a1 } = makeEngine();
    const { engine: e2, audit: a2 } = makeEngine();
    await e1.handle({ sql: "SELECT * FROM users WHERE id = 42", ctx: baseCtx });
    await e2.handle({ sql: "SELECT * FROM users WHERE id = 99", ctx: baseCtx });
    const fp1 = (a1.byType("ATTEMPTED")[0]!.payload as { sql_fingerprint: string }).sql_fingerprint;
    const fp2 = (a2.byType("ATTEMPTED")[0]!.payload as { sql_fingerprint: string }).sql_fingerprint;
    expect(fp1).toBe(fp2);
  });
});

describe("Engine.handle — DENY path", () => {
  test("DENY: writes ATTEMPTED + DECIDED, does NOT execute", async () => {
    const { engine, audit, executor } = makeEngine();
    const d = await engine.handle({ sql: "DELETE FROM users", ctx: baseCtx });

    expect(d.allowed).toBe(false);
    expect(audit.events.map((e) => e.event_type)).toEqual(["ATTEMPTED", "DECIDED"]);
    expect(executor.calls.length).toBe(0);

    const decided = audit.byType("DECIDED")[0]!;
    expect(decided.payload).toMatchObject({
      decision: "DENY",
      policy_rule: "table_access",
    });
    expect((decided.payload as { reason: string }).reason).toContain("table-access policy");
  });

  test("parse_error denial includes parse_error rule + does not include exec", async () => {
    const { engine, audit, executor } = makeEngine();
    const d = await engine.handle({ sql: "garbage in", ctx: baseCtx });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe("parse_error");
    expect(audit.events.map((e) => e.event_type)).toEqual(["ATTEMPTED", "DECIDED"]);
    expect(executor.calls.length).toBe(0);
  });
});

describe("Engine.handle — audit failure semantics", () => {
  test("ATTEMPTED audit failure throws AuditUnavailableError + does NOT execute", async () => {
    const { engine, audit, executor } = makeEngine();
    audit.failOn = "ATTEMPTED";
    await expect(
      engine.handle({ sql: "SELECT 1", ctx: baseCtx }),
    ).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(executor.calls.length).toBe(0);
  });

  test("DECIDED audit failure throws AuditUnavailableError + does NOT execute", async () => {
    const { engine, audit, executor } = makeEngine();
    audit.failOn = "DECIDED";
    await expect(
      engine.handle({ sql: "SELECT 1", ctx: baseCtx }),
    ).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(executor.calls.length).toBe(0);
  });

  test("EXECUTED audit failure does NOT throw (best-effort) — query still allowed", async () => {
    const { engine, audit, executor } = makeEngine();
    executor.result = { rows: [], rowCount: 0 };
    audit.failOn = "EXECUTED";

    // The executor still ran; we still return allowed=true. The post-exec
    // audit failure is logged to ops, not surfaced as an exception.
    const d = await engine.handle({ sql: "SELECT 1", ctx: baseCtx });
    expect(d.allowed).toBe(true);
    expect(executor.calls.length).toBe(1);
  });
});

describe("Engine.handle — execute failure", () => {
  test("execute throws → engine writes FAILED audit + rethrows", async () => {
    const { engine, audit, executor } = makeEngine();
    executor.shouldThrow = { sqlstate: "42P01", message: "relation x does not exist" };

    await expect(
      engine.handle({ sql: "SELECT 1", ctx: baseCtx }),
    ).rejects.toThrow(/relation x does not exist/);

    const types = audit.events.map((e) => e.event_type);
    expect(types).toEqual(["ATTEMPTED", "DECIDED", "FAILED"]);

    const failed = audit.byType("FAILED")[0]!;
    expect(failed.payload).toMatchObject({
      error_class: "42P01",
      error_message: "relation x does not exist",
    });
  });
});

describe("Engine.handle — query_id grouping", () => {
  test("all events for one query share the same query_id", async () => {
    const { engine, audit } = makeEngine();
    await engine.handle({ sql: "SELECT 1", ctx: baseCtx });
    const ids = new Set(audit.events.map((e) => e.query_id));
    expect(ids.size).toBe(1);
  });

  test("two queries get distinct query_ids", async () => {
    const { engine, audit } = makeEngine();
    await engine.handle({ sql: "SELECT 1", ctx: baseCtx });
    await engine.handle({ sql: "SELECT 2", ctx: baseCtx });
    const ids = new Set(audit.events.map((e) => e.query_id));
    expect(ids.size).toBe(2);
  });
});

describe("Engine.handle — robustness against misbehaving rules", () => {
  // Reviewer-flagged: previously evaluate() ran before ATTEMPTED was written,
  // so a rule that throws made the query disappear from audit entirely.
  test("rule that throws still produces ATTEMPTED + DECIDED (internal_error)", async () => {
    const audit = new MemoryAuditWriter();
    const executor = new MockExecutor();
    const credentials = new StubCredentialStore();
    const throwingRule = {
      name: "throwing_rule",
      evaluateIR() {
        throw new Error("kaboom");
      },
    };
    let counter = 0;
    const engine = new Engine({
      policy: { rules: [throwingRule] },
      audit,
      executor,
      credentials,
      now: () => 1_700_000_000_000,
      idGen: () => `01TESTID${(counter++).toString().padStart(18, "0")}`,
    });

    const d = await engine.handle({ sql: "SELECT 1", ctx: baseCtx });

    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe("internal_error");
    expect(audit.events.map((e) => e.event_type)).toEqual(["ATTEMPTED", "DECIDED"]);
    expect(executor.calls.length).toBe(0);

    const decided = audit.byType("DECIDED")[0]!;
    expect(decided.payload).toMatchObject({
      decision: "DENY",
      policy_rule: "internal_error",
    });
  });

  test("dialect whose normalize() throws still produces ATTEMPTED + DECIDED (internal_error)", async () => {
    // IR-era analog of the old "throw during the walk" case: normalization is
    // the only walk now, and it runs inside evaluate() under engine.handle's
    // policy try/catch, so a throw there must still audit + deny, not vanish.
    const audit = new MemoryAuditWriter();
    const executor = new MockExecutor();
    const credentials = new StubCredentialStore();
    const throwingDialect = {
      name: "postgres" as const,
      parse: async () => ({ ok: true as const, ast: { version: 0, stmts: [] } }),
      warmup: async () => {},
      normalize() {
        throw new Error("normalize explosion");
      },
    };
    let counter = 0;
    const engine = new Engine({
      policy: { rules: [parseError(), tableAccess()] },
      audit,
      executor,
      credentials,
      dialect: throwingDialect,
      now: () => 1_700_000_000_000,
      idGen: () => `01TESTID${(counter++).toString().padStart(18, "0")}`,
    });

    const d = await engine.handle({ sql: "SELECT 1", ctx: baseCtx });

    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe("internal_error");
    expect(audit.byType("ATTEMPTED").length).toBe(1);
    expect(audit.byType("DECIDED").length).toBe(1);
    expect(executor.calls.length).toBe(0);
  });
});

describe("Engine — ulid/Date defaults work without injection", () => {
  test("constructor without idGen/now produces valid events", async () => {
    const audit = new MemoryAuditWriter();
    const executor = new MockExecutor();
    const credentials = new StubCredentialStore();
    const engine = new Engine({
      policy: { rules: [parseError(), multiStatement(), tableAccess(), tenantScope()] },
      audit,
      executor,
      credentials,
    });
    const d = await engine.handle({ sql: "SELECT 1", ctx: baseCtx });
    expect(d.allowed).toBe(true);
    expect(audit.events.length).toBe(3);
    // ULIDs are 26 chars
    for (const e of audit.events) expect(e.id.length).toBe(26);
  });
});
