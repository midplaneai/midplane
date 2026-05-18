// Adversarial corpus — tenant_scope strict mode (0.5.0).
//
// Strict mode = `defaultColumn` is set. Semantics: every queried table is
// scoped on that column UNLESS listed in `exempt` or covered by a
// per-table `overrides` entry (which redirects to a different column).
// This eliminates the silent-leak class: a forgotten table is denied by
// default, not allowed.
//
// The corpus mirrors the legacy `tenant-scope.test.ts` cases but with a
// strict-mode config, plus new cases that only exist in strict mode
// (universal default, exempt, override-vs-default precedence).

import { describe, test, expect } from "bun:test";
import { Engine, type EngineContext } from "../../src/engine.ts";
import {
  MemoryAuditWriter,
  MockExecutor,
  StubCredentialStore,
  baseCtx,
} from "../_helpers.ts";
import { parseError } from "../../src/policy/rules/parse-error.ts";
import { multiStatement } from "../../src/policy/rules/multi-statement.ts";
import { tableAccess } from "../../src/policy/rules/table-access.ts";
import {
  tenantScope,
  type TenantScopeConfig,
} from "../../src/policy/rules/tenant-scope.ts";
import { PolicyRule } from "../../src/audit/types.ts";
import { expectAllow, expectDeny } from "./_helpers.ts";

const TENANT = PolicyRule.TENANT_SCOPE_MISSING;

function strictEngine(cfg: Partial<TenantScopeConfig>) {
  const audit = new MemoryAuditWriter();
  const executor = new MockExecutor();
  // `defaultColumn: null` is a meaningful value (inert config); use `in`
  // so a tester can pass `null` without the helper coercing it to the
  // helper default.
  const defaultColumn =
    "defaultColumn" in cfg ? (cfg.defaultColumn as string | null) : "tenant_id";
  const engine = new Engine({
    policy: {
      rules: [
        parseError(),
        multiStatement(),
        tableAccess({ default: "read", tables: {} }),
        tenantScope({
          defaultColumn,
          overrides: cfg.overrides ?? {},
          exempt: cfg.exempt ?? [],
        }),
      ],
    },
    audit,
    credentials: new StubCredentialStore(),
    executor,
  });
  return { engine, audit, executor };
}

const ctx: EngineContext = { ...baseCtx, tenant_id: "42" };

describe("adversarial/tenant-scope strict: universal column", () => {
  test("table the operator never listed (the original footgun) → deny", async () => {
    // Pre-0.5.0 `mappings`-only config would have silently allowed this
    // query — `invoices` wasn't listed, so no scope check fired. Strict
    // mode flips it to deny: the table is scoped by the universal
    // `defaultColumn` unless explicitly exempted.
    const { engine } = strictEngine({});
    await expectDeny(
      engine,
      ctx,
      "SELECT * FROM invoices",
      TENANT,
    );
  });

  test("scoped query on universal column → allow", async () => {
    const { engine } = strictEngine({});
    await expectAllow(
      engine,
      ctx,
      "SELECT * FROM invoices WHERE tenant_id = 42",
    );
  });

  test("wrong tenant literal under universal column → deny", async () => {
    const { engine } = strictEngine({});
    await expectDeny(
      engine,
      ctx,
      "SELECT * FROM invoices WHERE tenant_id = 99",
      TENANT,
    );
  });

  test("strict-mode + DML on un-listed table requires predicate → deny", async () => {
    // Pre-0.5.0 only `mappings`-listed tables had their DML targets
    // checked. Strict mode treats every DML target as scoped (unless
    // exempt). table_access fires first in production for unconfigured
    // writes — drop it from the chain here so we can pin the verdict
    // on tenant_scope alone.
    const audit = new MemoryAuditWriter();
    const engine = new Engine({
      policy: {
        rules: [
          parseError(),
          tenantScope({
            defaultColumn: "tenant_id",
            overrides: {},
            exempt: [],
          }),
        ],
      },
      audit,
      credentials: new StubCredentialStore(),
      executor: new MockExecutor(),
    });
    const result = await engine.handle({
      sql: "DELETE FROM webhooks WHERE id = 1",
      ctx,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe(TENANT);
  });
});

describe("adversarial/tenant-scope strict: exempt list", () => {
  test("exempt table can be queried without predicate → allow", async () => {
    const { engine } = strictEngine({ exempt: ["regions"] });
    await expectAllow(engine, ctx, "SELECT * FROM regions");
  });

  test("exempt table mixed with scoped table in same SELECT — scoped still required → deny", async () => {
    const { engine } = strictEngine({ exempt: ["regions"] });
    await expectDeny(
      engine,
      ctx,
      "SELECT * FROM regions r JOIN users u ON u.region_id = r.id",
      TENANT,
    );
  });

  test("exempt table + scoped table both qualified → allow", async () => {
    const { engine } = strictEngine({ exempt: ["regions"] });
    await expectAllow(
      engine,
      ctx,
      "SELECT * FROM regions r JOIN users u ON u.region_id = r.id WHERE u.tenant_id = 42",
    );
  });

  test("exempt table referenced in a CTE that feeds a scoped query → allow", async () => {
    const { engine } = strictEngine({ exempt: ["regions"] });
    await expectAllow(
      engine,
      ctx,
      "WITH r AS (SELECT * FROM regions) SELECT * FROM users WHERE tenant_id = 42",
    );
  });
});

describe("adversarial/tenant-scope strict: overrides precedence", () => {
  test("override wins over default column → query must use override column", async () => {
    // Default is `tenant_id`. `orders` is overridden to `org_id`. A
    // query using the default column on `orders` denies — operator
    // declared a different column for this table.
    const { engine } = strictEngine({ overrides: { orders: "org_id" } });
    await expectDeny(
      engine,
      ctx,
      "SELECT * FROM orders WHERE tenant_id = 42",
      TENANT,
    );
  });

  test("override applies its own column → allow", async () => {
    const { engine } = strictEngine({ overrides: { orders: "org_id" } });
    await expectAllow(
      engine,
      ctx,
      "SELECT * FROM orders WHERE org_id = 42",
    );
  });

  test("default still applies to tables without an override → allow when default used", async () => {
    const { engine } = strictEngine({ overrides: { orders: "org_id" } });
    await expectAllow(
      engine,
      ctx,
      "SELECT * FROM users WHERE tenant_id = 42",
    );
  });

  test("exempt wins over override (exempt is the most explicit signal)", async () => {
    // The strict-mode precedence is exempt → overrides → defaultColumn.
    // Listing a table in both is a no-op for that table — exempt is the
    // operator's explicit "this is intentionally not scoped" declaration.
    const { engine } = strictEngine({
      overrides: { audit_log: "org_id" },
      exempt: ["audit_log"],
    });
    await expectAllow(engine, ctx, "SELECT * FROM audit_log");
  });
});

describe("adversarial/tenant-scope strict: scope-bypass via nesting", () => {
  test("subquery on un-listed table without scope → deny", async () => {
    const { engine } = strictEngine({});
    await expectDeny(
      engine,
      ctx,
      "SELECT (SELECT count(*) FROM invoices) AS n",
      TENANT,
    );
  });

  test("UNION arm with un-listed table without scope → deny", async () => {
    const { engine } = strictEngine({});
    await expectDeny(
      engine,
      ctx,
      "SELECT id FROM invoices WHERE tenant_id = 42 UNION SELECT id FROM invoices",
      TENANT,
    );
  });

  test("CTE on un-listed table without scope → deny", async () => {
    const { engine } = strictEngine({});
    await expectDeny(
      engine,
      ctx,
      "WITH x AS (SELECT * FROM invoices) SELECT * FROM x",
      TENANT,
    );
  });

  test("JOIN of scoped + un-listed table → both must carry predicate", async () => {
    const { engine } = strictEngine({});
    await expectDeny(
      engine,
      ctx,
      "SELECT * FROM users u JOIN invoices i ON u.id = i.user_id WHERE u.tenant_id = 42",
      TENANT,
    );
  });

  test("JOIN of scoped + un-listed table with both predicates → allow", async () => {
    const { engine } = strictEngine({});
    await expectAllow(
      engine,
      ctx,
      "SELECT * FROM users u JOIN invoices i ON u.id = i.user_id WHERE u.tenant_id = 42 AND i.tenant_id = 42",
    );
  });
});

describe("adversarial/tenant-scope strict: empty/disabled config short-circuits", () => {
  test("no defaultColumn + no overrides → ALLOW (no enforcement)", async () => {
    // This is the inert config — same as not configuring tenant_scope
    // at all. Used by callers who want to disable the rule without
    // removing it from the chain.
    const { engine } = strictEngine({
      defaultColumn: null,
      overrides: {},
      exempt: ["whatever"], // exempt without anything to scope is a no-op
    });
    await expectAllow(engine, ctx, "SELECT * FROM anything");
  });

  test("legacy flat record source (no default) → only listed tables checked", async () => {
    // Back-compat shim: a plain `Record<string, string>` passed as the
    // source is read as `{ defaultColumn: null, overrides: <record>,
    // exempt: [] }` — matches pre-0.5.0 mappings-only semantics.
    const audit = new MemoryAuditWriter();
    const engine = new Engine({
      policy: {
        rules: [
          parseError(),
          tableAccess({ default: "read", tables: {} }),
          tenantScope({ users: "org_id" }), // legacy flat-record source
        ],
      },
      audit,
      credentials: new StubCredentialStore(),
      executor: new MockExecutor(),
    });
    // `users` requires `org_id`; `invoices` is unlisted ⇒ allowed in
    // legacy mode (this is exactly the silent-leak strict mode fixes).
    const usersBare = await engine.handle({
      sql: "SELECT * FROM users",
      ctx,
    });
    expect(usersBare.allowed).toBe(false);
    const invoicesBare = await engine.handle({
      sql: "SELECT * FROM invoices",
      ctx,
    });
    expect(invoicesBare.allowed).toBe(true);
  });
});
