import { describe, expect, it } from "vitest";
import { DatabasePolicySchema } from "../src/index.ts";

describe("DatabasePolicySchema", () => {
  it("defaults to the safe posture", () => {
    const p = DatabasePolicySchema.parse({});
    expect(p.table_access).toEqual({ default: "deny", tables: {} });
    expect(p.writes).toEqual({ row_changes: "allow", schema_changes: "deny" });
    expect(p.masks).toEqual({});
    expect(p.labels).toEqual({ untrusted_columns: {}, secret_tables: [] });
    expect(p.requires_features).toEqual([]);
  });

  it("rejects unknown keys anywhere, so nothing is partly applied", () => {
    expect(DatabasePolicySchema.safeParse({ tenant_scope: {} }).success).toBe(
      false,
    );
    expect(
      DatabasePolicySchema.safeParse({
        table_access: { default: "read", extra: 1 },
      }).success,
    ).toBe(false);
    expect(
      DatabasePolicySchema.safeParse({
        masks: {
          "public.users": { email: { t: "partial", keepEnd: 2, reveal: true } },
        },
      }).success,
    ).toBe(false);
  });

  it("requires schema-qualified table keys", () => {
    expect(
      DatabasePolicySchema.safeParse({
        table_access: { tables: { users: "read" } },
      }).success,
    ).toBe(false);
    expect(
      DatabasePolicySchema.safeParse({
        table_access: { tables: { "public.users": "read" } },
      }).success,
    ).toBe(true);
  });

  it("rejects transforms v2.0 doesn't ship", () => {
    expect(
      DatabasePolicySchema.safeParse({
        masks: {
          "public.users": { name: { t: "pseudonymize", kind: "name" } },
        },
      }).success,
    ).toBe(false);
  });
});
