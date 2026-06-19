// column_masks validator + YAML serialization (design A2). Mirrors the
// engine's column_masks schema; the validator is the save-time gate that keeps
// malformed masks out of Postgres, and the serializer emits the per-DB YAML the
// engine reads (plus requires_features so a future engine fails closed).

import { describe, expect, it } from "vitest";

import {
  MASK_TRANSFORMS,
  parseColumnMasksOrThrow,
  serializeMultiDbPolicyToYaml,
  validateColumnMasks,
  type DatabaseEntry,
} from "../src/policy.ts";

describe("validateColumnMasks", () => {
  it("treats null/undefined as an empty config", () => {
    expect(validateColumnMasks(null)).toEqual({ ok: true, value: {} });
    expect(validateColumnMasks(undefined)).toEqual({ ok: true, value: {} });
  });

  it("accepts a valid table -> column -> transform map", () => {
    expect(
      validateColumnMasks({
        "public.users": { email: "full-redact", ssn: "consistent-hash" },
      }),
    ).toEqual({
      ok: true,
      value: { "public.users": { email: "full-redact", ssn: "consistent-hash" } },
    });
  });

  it("rejects an unknown transform", () => {
    const r = validateColumnMasks({ "public.users": { email: "format-preserving-fake" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toContain("transform must be one of");
  });

  it("rejects a malformed column name", () => {
    expect(validateColumnMasks({ "public.users": { "ema il": "full-redact" } }).ok).toBe(false);
  });

  it("rejects a malformed table name", () => {
    expect(validateColumnMasks({ "we;ird": { email: "full-redact" } }).ok).toBe(false);
  });

  it("drops a table that resolves to zero columns (no error)", () => {
    expect(validateColumnMasks({ "public.users": {} })).toEqual({ ok: true, value: {} });
  });

  it("exposes the v1 transform set", () => {
    expect([...MASK_TRANSFORMS]).toEqual([
      "full-redact",
      "consistent-hash",
      "keep-last-4",
    ]);
  });
});

describe("parseColumnMasksOrThrow", () => {
  it("throws on invalid input (spawner fail-closed)", () => {
    expect(() =>
      parseColumnMasksOrThrow({ "public.users": { email: "nope" } }),
    ).toThrow(/invalid column_masks/);
  });
});

describe("serializeMultiDbPolicyToYaml + column_masks", () => {
  function entry(overrides: Partial<DatabaseEntry> = {}): DatabaseEntry {
    return {
      name: "main",
      projectDatabaseId: "01HXYZ123ABC456DEF789GHI01",
      tableAccess: { default: "read", tables: {} },
      tenantScope: { column: null, overrides: {}, exempt: [] },
      guardrails: { block_unqualified_dml: true, block_ddl: true },
      ...overrides,
    };
  }

  it("omits column_masks AND requires_features when there are no masks", () => {
    const yaml = serializeMultiDbPolicyToYaml([entry()]);
    expect(yaml).not.toContain("column_masks");
    expect(yaml).not.toContain("requires_features");
  });

  it("emits requires_features + sorted column_masks when present", () => {
    const yaml = serializeMultiDbPolicyToYaml([
      entry({
        columnMasks: {
          "public.users": { ssn: "consistent-hash", email: "full-redact" },
        },
      }),
    ]);
    expect(yaml).toContain(
      [
        "    requires_features:",
        "      - column_masks",
        "    column_masks:",
        "      public.users:",
        "        email: full-redact", // sorted: email before ssn
        "        ssn: consistent-hash",
      ].join("\n"),
    );
  });

  it("an empty columnMasks object emits nothing", () => {
    const yaml = serializeMultiDbPolicyToYaml([entry({ columnMasks: {} })]);
    expect(yaml).not.toContain("column_masks");
  });
});
