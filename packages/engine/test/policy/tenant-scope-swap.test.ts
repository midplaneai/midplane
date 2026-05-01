// tenantScope(getter) — mappings can be hot-swapped without rebuilding
// the engine.
//
// Mirror of table-access-swap.test.ts. Verifies the holder pattern used
// by mcp-server's POST /admin/policy:
//   1. Build engine pointed at mappings A. Run query → decide per A.
//   2. Mutate the holder to mappings B. Run same query → decide per B.
//   3. Construct a query that yields mid-pipeline (slow audit), swap the
//      holder during the yield, then resume — the rule reads the holder
//      once per finalize() call so the in-flight verdict reflects whichever
//      pointer was current at finalize() time. Never half-mixed.

import { describe, expect, test } from "bun:test";
import { Engine } from "../../src/engine.ts";
import { tableAccess } from "../../src/policy/rules/table-access.ts";
import { parseError } from "../../src/policy/rules/parse-error.ts";
import { multiStatement } from "../../src/policy/rules/multi-statement.ts";
import { tenantScope } from "../../src/policy/rules/tenant-scope.ts";
import {
  MemoryAuditWriter,
  MockExecutor,
  StubCredentialStore,
  baseCtx,
} from "../_helpers.ts";

function buildEngineWithHolder(initial: Record<string, string>) {
  const holder: { tenantScope: Record<string, string> } = {
    tenantScope: initial,
  };
  const audit = new MemoryAuditWriter();
  const executor = new MockExecutor();
  const engine = new Engine({
    policy: {
      rules: [
        parseError(),
        multiStatement(),
        tableAccess({ default: "read", tables: {} }),
        tenantScope(() => holder.tenantScope),
      ],
    },
    audit,
    credentials: new StubCredentialStore(),
    executor,
  });
  return { engine, audit, executor, holder };
}

describe("tenantScope — mappings swap via holder", () => {
  test("swap from mappings A → mappings B flips the next query's denial column", async () => {
    // SELECT FROM users with `WHERE org_id = 42` satisfies mappings A but
    // not mappings B (which expects customer_id). After the swap, the
    // identical query trips tenant_scope_missing.
    const mappingsA: Record<string, string> = { users: "org_id" };
    const mappingsB: Record<string, string> = { users: "customer_id" };
    const { engine, holder } = buildEngineWithHolder(mappingsA);

    const a = await engine.handle({
      sql: "SELECT id FROM users WHERE org_id = 42",
      ctx: baseCtx,
    });
    expect(a.allowed).toBe(true);

    holder.tenantScope = mappingsB;

    const b = await engine.handle({
      sql: "SELECT id FROM users WHERE org_id = 42",
      ctx: baseCtx,
    });
    expect(b.allowed).toBe(false);
    if (!b.allowed) {
      expect(b.reason).toBe("tenant_scope_missing");
      expect(b.message).toContain("customer_id");
      expect(b.message).not.toContain("org_id = <");
    }
  });

  test("swap to empty mappings disables tenant_scope enforcement", async () => {
    // Engine starts enforcing org_id on users. Bare SELECT denies. After
    // the swap to {} the same query allows — the rule's empty-mappings
    // branch returns ALLOW.
    const { engine, holder } = buildEngineWithHolder({ users: "org_id" });

    const denied = await engine.handle({
      sql: "SELECT id FROM users",
      ctx: baseCtx,
    });
    expect(denied.allowed).toBe(false);

    holder.tenantScope = {};
    const allowed = await engine.handle({
      sql: "SELECT id FROM users",
      ctx: baseCtx,
    });
    expect(allowed.allowed).toBe(true);
  });

  test("swap during in-flight query: verdict is consistent (no half-mix)", async () => {
    // Same construction as the table_access version: gate ATTEMPTED so
    // the rule's finalize() runs AFTER our holder swap.
    const mappingsAllow: Record<string, string> = {}; // no enforcement
    const mappingsDeny: Record<string, string> = { users: "org_id" };

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

    const holder: { tenantScope: Record<string, string> } = {
      tenantScope: mappingsAllow,
    };
    const engine = new Engine({
      policy: {
        rules: [
          parseError(),
          multiStatement(),
          tableAccess({ default: "read", tables: {} }),
          tenantScope(() => holder.tenantScope),
        ],
      },
      audit,
      credentials: new StubCredentialStore(),
      executor: new MockExecutor(),
    });

    const inFlight = engine.handle({
      sql: "SELECT id FROM users",
      ctx: baseCtx,
    });

    holder.tenantScope = mappingsDeny;
    releaseAttempted();

    const verdict = await inFlight;
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toBe("tenant_scope_missing");
    }
  });

  test("no-source form (back-compat) still reads mappings from ctx", async () => {
    // Pre-0.4.0 callers wired tenantScope() with no arg and passed
    // mappings via ctx. That path must keep working — the rule falls back
    // to ctx.tenant_scope.mappings when the source is undefined.
    const audit = new MemoryAuditWriter();
    const engine = new Engine({
      policy: {
        rules: [
          parseError(),
          multiStatement(),
          tableAccess({ default: "read", tables: {} }),
          tenantScope(), // no source
        ],
      },
      audit,
      credentials: new StubCredentialStore(),
      executor: new MockExecutor(),
    });

    const denied = await engine.handle({
      sql: "SELECT id FROM users",
      ctx: { ...baseCtx, tenant_scope: { mappings: { users: "org_id" } } },
    });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.reason).toBe("tenant_scope_missing");
    }
  });

  test("static-mappings form (no getter) reads the same object on every call", async () => {
    // Backwards-compat: tenantScope(staticMappings) — passing the bare
    // dict object reads it once per finalize() but never reaches into
    // the holder pattern. Mutating the dict externally IS visible (same
    // object reference) — callers who want isolation pass a getter.
    const mappings: Record<string, string> = { users: "org_id" };
    const audit = new MemoryAuditWriter();
    const engine = new Engine({
      policy: {
        rules: [
          parseError(),
          multiStatement(),
          tableAccess({ default: "read", tables: {} }),
          tenantScope(mappings),
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
    expect(d.allowed).toBe(false);

    delete mappings.users;
    const d2 = await engine.handle({
      sql: "SELECT id FROM users",
      ctx: baseCtx,
    });
    expect(d2.allowed).toBe(true);
  });
});
