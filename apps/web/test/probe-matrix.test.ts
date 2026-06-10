// Probe-matrix builder — the zero-typing path's input to the engine
// dry-run. Pinned here: the V1 probe set (4 actions per table +
// cross-tenant select on scoped tables), dedupe across
// introspection ∪ policy sources, the 50-table cap with accurate
// truncation facts, and the row labels the panel renders.

import { describe, expect, it } from "vitest";

import {
  buildProbeMatrix,
  isTenantScoped,
  PROBE_TABLE_CAP,
  probeLabel,
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
