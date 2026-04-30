// tableAccess(getter) — config can be hot-swapped without rebuilding the engine.
//
// Verifies the holder pattern used by mcp-server's POST /admin/policy:
//   1. Build engine pointed at policy A. Run query → decide per A.
//   2. Mutate the holder to policy B. Run same query → decide per B.
//   3. Construct a query that yields mid-pipeline (slow audit), swap the
//      holder during the yield, then resume — the rule reads the holder
//      once per finalize() call so the in-flight verdict reflects whichever
//      pointer was current at finalize() time. Never half-mixed.

import { describe, expect, test } from "bun:test";
import { Engine } from "../../src/engine.ts";
import {
  tableAccess,
  type TableAccessConfig,
} from "../../src/policy/rules/table-access.ts";
import { parseError } from "../../src/policy/rules/parse-error.ts";
import { multiStatement } from "../../src/policy/rules/multi-statement.ts";
import { tenantScope } from "../../src/policy/rules/tenant-scope.ts";
import {
  MemoryAuditWriter,
  MockExecutor,
  StubCredentialStore,
  baseCtx,
} from "../_helpers.ts";

function buildEngineWithHolder(initial: TableAccessConfig | undefined) {
  const holder: { tableAccess: TableAccessConfig | undefined } = {
    tableAccess: initial,
  };
  const audit = new MemoryAuditWriter();
  const executor = new MockExecutor();
  const engine = new Engine({
    policy: {
      rules: [
        parseError(),
        multiStatement(),
        tableAccess(() => holder.tableAccess),
        tenantScope(),
      ],
    },
    audit,
    credentials: new StubCredentialStore(),
    executor,
  });
  return { engine, audit, executor, holder };
}

describe("tableAccess — config swap via holder", () => {
  test("swap from policy A → policy B flips the next query's verdict", async () => {
    const policyA: TableAccessConfig = {
      default: "deny",
      tables: { users: "read" },
    };
    const policyB: TableAccessConfig = {
      default: "deny",
      tables: { users: "deny" },
    };
    const { engine, holder } = buildEngineWithHolder(policyA);

    const a = await engine.handle({
      sql: "SELECT id FROM users",
      ctx: baseCtx,
    });
    expect(a.allowed).toBe(true);

    // Atomic-pointer-swap of the holder's field.
    holder.tableAccess = policyB;

    const b = await engine.handle({
      sql: "SELECT id FROM users",
      ctx: baseCtx,
    });
    expect(b.allowed).toBe(false);
    if (!b.allowed) {
      expect(b.reason).toBe("table_access");
      expect(b.message).toContain("reads from table `users`");
    }
  });

  test("swap to undefined falls back to legacy no-yaml config", async () => {
    const restrictive: TableAccessConfig = {
      default: "deny",
      tables: {},
    };
    const { engine, holder } = buildEngineWithHolder(restrictive);

    // Under restrictive config, a SELECT on `users` denies (default deny).
    const denied = await engine.handle({
      sql: "SELECT id FROM users",
      ctx: baseCtx,
    });
    expect(denied.allowed).toBe(false);

    // Swap to undefined: legacy fallback is { default: "read", tables: {} },
    // so SELECT allows.
    holder.tableAccess = undefined;
    const allowed = await engine.handle({
      sql: "SELECT id FROM users",
      ctx: baseCtx,
    });
    expect(allowed.allowed).toBe(true);
  });

  test("swap during in-flight query: verdict is consistent (no half-mix)", async () => {
    // Construct a controllable yield point: an audit writer that blocks the
    // ATTEMPTED write on a manual gate. Pipeline order is parse → ATTEMPTED
    // → policy → DECIDED, so blocking ATTEMPTED forces the rule to evaluate
    // AFTER our swap.
    const policyAllow: TableAccessConfig = {
      default: "deny",
      tables: { users: "read" },
    };
    const policyDeny: TableAccessConfig = {
      default: "deny",
      tables: { users: "deny" },
    };

    let releaseAttempted!: () => void;
    const attemptedGate = new Promise<void>((resolve) => {
      releaseAttempted = resolve;
    });

    const audit = new MemoryAuditWriter();
    const baseWrite = audit.write.bind(audit);
    audit.write = async (event) => {
      if (event.event_type === "ATTEMPTED") await attemptedGate;
      return baseWrite(event);
    };

    const holder: { tableAccess: TableAccessConfig | undefined } = {
      tableAccess: policyAllow,
    };
    const engine = new Engine({
      policy: {
        rules: [
          parseError(),
          multiStatement(),
          tableAccess(() => holder.tableAccess),
          tenantScope(),
        ],
      },
      audit,
      credentials: new StubCredentialStore(),
      executor: new MockExecutor(),
    });

    // Start a query while ATTEMPTED is gated. Rule evaluation hasn't run yet.
    const inFlight = engine.handle({
      sql: "SELECT id FROM users",
      ctx: baseCtx,
    });

    // Swap policies BEFORE releasing the gate.
    holder.tableAccess = policyDeny;
    releaseAttempted();

    const verdict = await inFlight;
    // Whichever pointer was current at finalize() time wins. After the swap,
    // the rule reads policyDeny → DENY. Critically: never throws, never
    // returns a partial state.
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toBe("table_access");
    }
  });

  test("static-config form (no getter) still works for callers that don't need swap", async () => {
    // Backwards-compat: tableAccess(config) — passing the bare config object
    // (the pre-holder API) reads it once at construction and never changes.
    const policy: TableAccessConfig = {
      default: "deny",
      tables: { users: "read" },
    };
    const audit = new MemoryAuditWriter();
    const engine = new Engine({
      policy: {
        rules: [
          parseError(),
          multiStatement(),
          tableAccess(policy),
          tenantScope(),
        ],
      },
      audit,
      credentials: new StubCredentialStore(),
      executor: new MockExecutor(),
    });

    const d = await engine.handle({
      sql: "SELECT id FROM users",
      ctx: baseCtx,
    });
    expect(d.allowed).toBe(true);

    // Mutating the local object after construction does NOT affect future
    // verdicts — the rule captured the reference but the test mutates the
    // contents to confirm read-once semantics aren't accidentally
    // happening (the rule reads the SAME object every time, so mutation
    // would be visible — this just documents the expectation that holder
    // semantics belong to the getter form).
    policy.tables.users = "deny";
    const d2 = await engine.handle({
      sql: "SELECT id FROM users",
      ctx: baseCtx,
    });
    // The rule re-reads the same object, so the mutation IS visible. This is
    // expected — callers who want isolation pass a getter and own the swap.
    expect(d2.allowed).toBe(false);
  });
});
