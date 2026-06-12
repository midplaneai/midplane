// Probe-matrix builder — the zero-typing path's input to the engine
// dry-run. Pinned here: the V1 probe set (4 actions per table +
// cross-tenant select on scoped tables), dedupe across
// introspection ∪ policy sources, the 50-table cap with accurate
// truncation facts, and the row labels the panel renders.

import { describe, expect, it } from "vitest";

import type { TableAccessPolicy } from "@midplane-cloud/db/policy";

import {
  buildGuardrailProbes,
  buildProbeMatrix,
  expectedDecision,
  isTenantScoped,
  MAX_GUARDRAIL_PROBES,
  MAX_PROBES_PER_RUN,
  pickGuardrailTable,
  PROBE_TABLE_CAP,
  probeLabel,
  reconcileGuardrails,
} from "../src/lib/probe-matrix.ts";

const NO_SCOPE = { column: null, overrides: {}, exempt: [] };
const SCOPED = { column: "account_id", overrides: {}, exempt: ["plans"] };

describe("isTenantScoped", () => {
  it("default column scopes every table except exempt", () => {
    expect(isTenantScoped("orders", SCOPED)).toBe(true);
    expect(isTenantScoped("plans", SCOPED)).toBe(false);
  });

  it("override scopes a table even without a default column", () => {
    const scope = {
      column: null,
      overrides: { orders: "org_id" },
      exempt: [],
    };
    expect(isTenantScoped("orders", scope)).toBe(true);
    expect(isTenantScoped("users", scope)).toBe(false);
  });

  it("no column, no overrides → nothing scoped", () => {
    expect(isTenantScoped("orders", NO_SCOPE)).toBe(false);
  });
});

describe("buildProbeMatrix", () => {
  it("emits 4 probes per table without scoping", () => {
    const m = buildProbeMatrix(["orders", "users"], NO_SCOPE);
    expect(m.probes).toHaveLength(8);
    expect(m.truncated).toBe(false);
    expect(m.totalTables).toBe(2);
    expect(m.probes.filter((p) => p.cross_tenant)).toHaveLength(0);
  });

  it("adds a cross-tenant select per scoped table only", () => {
    const m = buildProbeMatrix(["orders", "plans"], SCOPED);
    // orders: 4 + 1 cross-tenant; plans (exempt): 4.
    expect(m.probes).toHaveLength(9);
    const cross = m.probes.filter((p) => p.cross_tenant);
    expect(cross).toEqual([
      { table: "orders", action: "select", cross_tenant: true },
    ]);
  });

  it("dedupes the introspection ∪ policy union and drops empties", () => {
    const m = buildProbeMatrix(["orders", "orders", "", "users"], NO_SCOPE);
    expect(m.tables).toEqual(["orders", "users"]);
    expect(m.probes).toHaveLength(8);
  });

  it("caps at PROBE_TABLE_CAP with accurate truncation facts", () => {
    const tables = Array.from({ length: 60 }, (_, i) => `t${i}`);
    const m = buildProbeMatrix(tables, NO_SCOPE);
    expect(m.tables).toHaveLength(PROBE_TABLE_CAP);
    expect(m.totalTables).toBe(60);
    expect(m.truncated).toBe(true);
    expect(m.probes).toHaveLength(PROBE_TABLE_CAP * 4);
  });

  it("worst case (every capped table scoped) stays within MAX_PROBES_PER_RUN", () => {
    // The dry-run route's request validator enforces this ceiling — if a
    // cap or action change pushes the panel's own request past it, this
    // test fails before the route starts 400ing in production.
    const tables = Array.from({ length: 60 }, (_, i) => `t${i}`);
    const m = buildProbeMatrix(tables, {
      column: "account_id",
      overrides: {},
      exempt: [],
    });
    expect(m.probes).toHaveLength(MAX_PROBES_PER_RUN);
  });
});

describe("expectedDecision", () => {
  // default read; orders is opened to writes; secrets is locked.
  const policy: TableAccessPolicy = {
    default: "read",
    tables: { orders: "read_write", secrets: "deny" },
  };

  it("select allowed at read+, denied only at deny", () => {
    // default read
    expect(
      expectedDecision({ table: "users", action: "select" }, policy, NO_SCOPE),
    ).toBe("allow");
    expect(
      expectedDecision(
        { table: "secrets", action: "select" },
        policy,
        NO_SCOPE,
      ),
    ).toBe("deny");
  });

  it("writes allowed only at read_write", () => {
    // default read → writes denied
    expect(
      expectedDecision({ table: "users", action: "insert" }, policy, NO_SCOPE),
    ).toBe("deny");
    // orders override read_write → writes allowed
    expect(
      expectedDecision({ table: "orders", action: "update" }, policy, NO_SCOPE),
    ).toBe("allow");
  });

  it("a table override beats the default", () => {
    const denyDefault: TableAccessPolicy = {
      default: "deny",
      tables: { orders: "read_write" },
    };
    expect(
      expectedDecision(
        { table: "orders", action: "delete" },
        denyDefault,
        NO_SCOPE,
      ),
    ).toBe("allow");
    expect(
      expectedDecision(
        { table: "anything-else", action: "select" },
        denyDefault,
        NO_SCOPE,
      ),
    ).toBe("deny");
  });

  it("a cross-tenant read is always denied", () => {
    expect(
      expectedDecision(
        { table: "orders", action: "select", cross_tenant: true },
        policy,
        SCOPED,
      ),
    ).toBe("deny");
  });
});

describe("buildGuardrailProbes", () => {
  const BOTH_ON = { block_unqualified_dml: true, block_ddl: true };

  it("emits 2 DML + 3 DDL statements when both flags are on", () => {
    const probes = buildGuardrailProbes("orders", BOTH_ON);
    expect(probes.map((p) => p.kind)).toEqual([
      "unqualified_delete",
      "unqualified_update",
      "ddl_drop",
      "ddl_truncate",
      "ddl_alter",
    ]);
    // DML probes must be genuinely unqualified — a WHERE would test
    // table_access instead of the guardrail.
    expect(probes[0]!.sql).toBe('delete from "orders"');
    expect(probes[0]!.sql).not.toMatch(/where/i);
    expect(probes[1]!.sql).not.toMatch(/where/i);
    expect(probes[2]!.sql).toBe('drop table "orders"');
  });

  it("emits probes only for flags that are ON (an OFF flag has no cloud-side expectation)", () => {
    const dmlOnly = buildGuardrailProbes("orders", {
      block_unqualified_dml: true,
      block_ddl: false,
    });
    expect(dmlOnly.map((p) => p.kind)).toEqual([
      "unqualified_delete",
      "unqualified_update",
    ]);
    const ddlOnly = buildGuardrailProbes("orders", {
      block_unqualified_dml: false,
      block_ddl: true,
    });
    expect(ddlOnly.map((p) => p.kind)).toEqual([
      "ddl_drop",
      "ddl_truncate",
      "ddl_alter",
    ]);
    expect(
      buildGuardrailProbes("orders", {
        block_unqualified_dml: false,
        block_ddl: false,
      }),
    ).toEqual([]);
  });

  it("emits nothing without a representative table", () => {
    expect(buildGuardrailProbes(undefined, BOTH_ON)).toEqual([]);
  });

  it("quotes identifiers so reserved-word tables don't 400 the whole run", () => {
    // `delete from user` fails the engine's parser, and a parse failure on
    // the custom-sql path is a 400 that kills the ENTIRE panel run —
    // unlike matrix probes, which degrade to a parse_error verdict row.
    const probes = buildGuardrailProbes("user", BOTH_ON);
    expect(probes[0]!.sql).toBe('delete from "user"');
    expect(probes[2]!.sql).toBe('drop table "user"');
    // Labels keep the bare name — they're display text, not SQL.
    expect(probes[0]!.label).toBe("DELETE FROM user with no WHERE");
  });

  it("quotes schema-qualified names per part and escapes embedded quotes", () => {
    const qualified = buildGuardrailProbes("public.orders", BOTH_ON);
    expect(qualified[0]!.sql).toBe('delete from "public"."orders"');
    const hostile = buildGuardrailProbes('we"ird', BOTH_ON);
    expect(hostile[0]!.sql).toBe('delete from "we""ird"');
  });

  it("worst case stays within MAX_GUARDRAIL_PROBES (the dry-run route's validator ceiling)", () => {
    expect(buildGuardrailProbes("orders", BOTH_ON).length).toBe(
      MAX_GUARDRAIL_PROBES,
    );
  });

  it("labels read like the risk they stand for — keywords UPPERCASE, identifiers + prose lowercase", () => {
    // All-lowercase made "with no where" read as English prose; the caps
    // mark which tokens are SQL and set statement rows apart from the
    // matrix's lowercase action labels.
    const probes = buildGuardrailProbes("orders", BOTH_ON);
    expect(probes[0]!.label).toBe("DELETE FROM orders with no WHERE");
    expect(probes[1]!.label).toBe("UPDATE orders with no WHERE");
    expect(probes[2]!.label).toBe("DROP TABLE orders");
    // The statements themselves stay lowercase — they're real SQL for the
    // engine, not display text.
    expect(probes[0]!.sql).toBe('delete from "orders"');
  });
});

describe("pickGuardrailTable", () => {
  it("prefers a writable table — the only place a deny proves the guardrail", () => {
    const policy: TableAccessPolicy = {
      default: "deny",
      tables: { orders: "read_write", users: "read" },
    };
    expect(pickGuardrailTable(["users", "orders", "audit"], policy)).toBe(
      "orders",
    );
  });

  it("falls back to the first table when nothing is writable (default-deny everywhere)", () => {
    const policy: TableAccessPolicy = { default: "deny", tables: {} };
    expect(pickGuardrailTable(["users", "orders"], policy)).toBe("users");
    expect(pickGuardrailTable([], policy)).toBeUndefined();
  });

  it("a writable default makes the first table the pick", () => {
    const policy: TableAccessPolicy = { default: "read_write", tables: {} };
    expect(pickGuardrailTable(["users", "orders"], policy)).toBe("users");
  });
});

describe("reconcileGuardrails", () => {
  const BOTH_ON = { block_unqualified_dml: true, block_ddl: true };
  const denied = (rule: string) => ({
    decision: "deny" as const,
    reason: "Denied.",
    matched_rule: rule,
  });

  it("zips probes to verdicts in order and credits the dangerous_statement rule", () => {
    const probes = buildGuardrailProbes("orders", {
      block_unqualified_dml: true,
      block_ddl: false,
    });
    const r = reconcileGuardrails(probes, [
      denied("dangerous_statement"),
      denied("dangerous_statement"),
    ]);
    expect(r).toHaveLength(2);
    expect(r.every((g) => g.match && g.byGuardrail)).toBe(true);
  });

  it("fails CLOSED: a probe with no verdict is a failed check, not a silent pass", () => {
    // Four review specialists flagged the original slice()-zip for
    // dropping unanswered probes — which let the headline read
    // "✓ engine enforces your policy" over an unverified guardrail.
    const probes = buildGuardrailProbes("orders", {
      block_unqualified_dml: true,
      block_ddl: false,
    }); // 2 probes
    const r = reconcileGuardrails(probes, [denied("dangerous_statement")]);
    expect(r).toHaveLength(2);
    expect(r[0]!.match).toBe(true);
    expect(r[1]!.verdict).toBeNull();
    expect(r[1]!.match).toBe(false);
  });

  it("a deny via an earlier rule still holds but is NOT credited to the guardrail", () => {
    // table_access(deny) fires before dangerous_statement in the engine's
    // chain — the statement is denied either way, but the row must not
    // claim the guardrail decided it.
    const probes = buildGuardrailProbes("secrets", BOTH_ON);
    const r = reconcileGuardrails(
      probes,
      probes.map(() => denied("table_access")),
    );
    expect(r.every((g) => g.match)).toBe(true);
    expect(r.every((g) => !g.byGuardrail)).toBe(true);
  });

  it("an allow verdict is a mismatch", () => {
    const probes = buildGuardrailProbes("orders", {
      block_unqualified_dml: false,
      block_ddl: true,
    });
    const r = reconcileGuardrails(probes, [
      { decision: "allow", reason: "write allowed", matched_rule: "table_access" },
      denied("dangerous_statement"),
      denied("dangerous_statement"),
    ]);
    expect(r[0]!.match).toBe(false);
    expect(r[1]!.match).toBe(true);
  });
});

describe("probeLabel", () => {
  it("reads like the SQL it stands for", () => {
    expect(probeLabel({ table: "orders", action: "select" })).toBe(
      "select from orders",
    );
    expect(probeLabel({ table: "orders", action: "insert" })).toBe(
      "insert into orders",
    );
    expect(probeLabel({ table: "orders", action: "update" })).toBe(
      "update orders",
    );
    expect(probeLabel({ table: "orders", action: "delete" })).toBe(
      "delete from orders",
    );
    expect(
      probeLabel({ table: "orders", action: "select", cross_tenant: true }),
    ).toBe("select another tenant's rows from orders");
  });
});
