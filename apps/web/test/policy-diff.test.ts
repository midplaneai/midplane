import { describe, expect, it } from "vitest";

import type { TableAccessPolicy, WriteRules } from "@midplane-cloud/db/policy";

import {
  diffPolicy,
  hasPolicyChanges,
  summarizePolicyChanges,
  type PolicySnapshot,
} from "../src/lib/policy-diff.ts";

// One Save for two lists means the bar has to name what it's about to save —
// including an edit in the list you scrolled past.

const RULES: WriteRules = {
  row_changes: "allow",
  whole_table_writes: "refuse",
  schema_changes: "refuse",
};

const TABLES: TableAccessPolicy = {
  default: "deny",
  tables: { orders: "read_write", users: "read" },
};

const BASE: PolicySnapshot = { tableAccess: TABLES, writeRules: RULES };

function withTables(tables: TableAccessPolicy["tables"]): PolicySnapshot {
  return { ...BASE, tableAccess: { ...TABLES, tables } };
}

describe("diffPolicy", () => {
  it("finds nothing in an untouched draft", () => {
    const changes = diffPolicy(BASE, { ...BASE });
    expect(hasPolicyChanges(changes)).toBe(false);
    expect(summarizePolicyChanges(changes)).toBeNull();
  });

  it("counts an added, a removed, and a re-levelled table each as one", () => {
    expect(
      diffPolicy(BASE, withTables({ ...TABLES.tables, audit: "read" })).tables,
    ).toBe(1);
    expect(diffPolicy(BASE, withTables({ orders: "read_write" })).tables).toBe(1);
    expect(
      diffPolicy(BASE, withTables({ ...TABLES.tables, users: "deny" })).tables,
    ).toBe(1);
  });

  it("separates the catch-all from the listed tables", () => {
    // Moving the default re-levels every table you didn't list, so it is worth
    // naming on its own rather than folding into a table count of zero.
    const changes = diffPolicy(BASE, {
      ...BASE,
      tableAccess: { ...TABLES, default: "read" },
    });
    expect(changes).toEqual({ defaultLevel: true, tables: 0, writeRules: 0 });
    expect(summarizePolicyChanges(changes)).toBe("Unsaved: the default");
  });

  it("counts write-rule moves per class", () => {
    const changes = diffPolicy(BASE, {
      ...BASE,
      writeRules: { ...RULES, row_changes: "ask", schema_changes: "ask" },
    });
    expect(changes.writeRules).toBe(2);
  });
});

describe("summarizePolicyChanges", () => {
  it("names every list that changed, in reading order", () => {
    const changes = diffPolicy(BASE, {
      tableAccess: {
        default: "read",
        tables: { orders: "read", users: "read", audit: "deny" },
      },
      writeRules: { ...RULES, schema_changes: "ask" },
    });
    expect(summarizePolicyChanges(changes)).toBe(
      "Unsaved: the default, 2 tables, a write rule",
    );
  });

  it("says 'a table' / 'a write rule' at one, and counts above that", () => {
    expect(
      summarizePolicyChanges(
        diffPolicy(BASE, withTables({ ...TABLES.tables, audit: "read" })),
      ),
    ).toBe("Unsaved: a table");
    expect(
      summarizePolicyChanges(
        diffPolicy(BASE, {
          ...BASE,
          writeRules: {
            row_changes: "ask",
            whole_table_writes: "allow",
            schema_changes: "ask",
          },
        }),
      ),
    ).toBe("Unsaved: 3 write rules");
  });
});
