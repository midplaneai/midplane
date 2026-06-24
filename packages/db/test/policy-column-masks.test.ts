// column_masks validator + YAML serialization (design A2). Mirrors the
// engine's column_masks schema; the validator is the save-time gate that keeps
// malformed masks out of Postgres, and the serializer emits the per-DB YAML the
// engine reads (plus requires_features so a future engine fails closed).

import { describe, expect, it } from "vitest";

import {
  MASK_TRANSFORM_KINDS,
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
    if (!r.ok) expect(r.errors[0]!.message).toContain("transform must be");
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

  it("exposes the full catalog (presets then parametric kinds)", () => {
    expect([...MASK_TRANSFORM_KINDS]).toEqual([
      "full-redact",
      "null-out",
      "consistent-hash",
      "partial",
      "generalize",
      "pseudonymize",
      "noise",
    ]);
  });

  it("accepts null-out for any column", () => {
    expect(
      validateColumnMasks({ "public.events": { created_at: "null-out" } }),
    ).toEqual({
      ok: true,
      value: { "public.events": { created_at: "null-out" } },
    });
  });

  it("rejects the retired keep-last-4 preset", () => {
    expect(validateColumnMasks({ "public.users": { ssn: "keep-last-4" } }).ok).toBe(false);
  });
});

describe("validateColumnMasks: parametric transforms", () => {
  it("accepts partial with bounds and normalizes to known keys only", () => {
    const r = validateColumnMasks({
      "public.users": { ssn: { t: "partial", keepEnd: 4, junk: 9 } },
    });
    expect(r).toEqual({
      ok: true,
      value: { "public.users": { ssn: { t: "partial", keepEnd: 4 } } },
    });
  });

  it("rejects partial whose kept span exceeds the cap", () => {
    const r = validateColumnMasks({
      "public.users": { ssn: { t: "partial", keepStart: 40, keepEnd: 40 } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toContain("keepStart + keepEnd");
  });

  it("rejects a multi-character glyph", () => {
    expect(
      validateColumnMasks({ "public.users": { ssn: { t: "partial", glyph: "xx" } } }).ok,
    ).toBe(false);
  });

  it("accepts generalize with a date granularity or a positive numeric width", () => {
    expect(
      validateColumnMasks({ "public.u": { dob: { t: "generalize", granularity: "year" } } }),
    ).toEqual({
      ok: true,
      value: { "public.u": { dob: { t: "generalize", granularity: "year" } } },
    });
    expect(
      validateColumnMasks({ "public.u": { salary: { t: "generalize", granularity: 1000 } } }).ok,
    ).toBe(true);
    expect(
      validateColumnMasks({ "public.u": { dob: { t: "generalize", granularity: "decade" } } }).ok,
    ).toBe(false);
    expect(
      validateColumnMasks({ "public.u": { x: { t: "generalize", granularity: 0 } } }).ok,
    ).toBe(false);
  });

  it("accepts pseudonymize with a known kind, rejects an unknown one", () => {
    expect(
      validateColumnMasks({ "public.u": { email: { t: "pseudonymize", kind: "email" } } }).ok,
    ).toBe(true);
    expect(
      validateColumnMasks({ "public.u": { ssn: { t: "pseudonymize", kind: "ssn" } } }).ok,
    ).toBe(false);
  });

  it("accepts noise in-range, rejects out-of-range or non-positive", () => {
    expect(
      validateColumnMasks({ "public.u": { salary: { t: "noise", ratio: 0.1 } } }).ok,
    ).toBe(true);
    expect(
      validateColumnMasks({ "public.u": { salary: { t: "noise", ratio: 999 } } }).ok,
    ).toBe(false);
    expect(
      validateColumnMasks({ "public.u": { salary: { t: "noise", ratio: 0 } } }).ok,
    ).toBe(false);
  });

  it("rejects an unknown parametric `t`", () => {
    expect(
      validateColumnMasks({ "public.u": { x: { t: "redact-future" } } }).ok,
    ).toBe(false);
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

  it("emits parametric rules as nested blocks, presets inline, columns sorted", () => {
    const yaml = serializeMultiDbPolicyToYaml([
      entry({
        columnMasks: {
          "public.users": {
            ssn: { t: "partial", keepEnd: 4 },
            dob: { t: "generalize", granularity: "year" },
            email: "full-redact",
            handle: { t: "partial", keepStart: 2, glyph: "#" },
          },
        },
      }),
    ]);
    expect(yaml).toContain(
      [
        "    column_masks:",
        "      public.users:",
        "        dob:", // sorted: dob, email, handle, ssn
        "          t: generalize",
        "          granularity: year",
        "        email: full-redact",
        "        handle:",
        "          t: partial",
        "          keepStart: 2",
        '          glyph: "#"',
        "        ssn:",
        "          t: partial",
        "          keepEnd: 4",
      ].join("\n"),
    );
  });
});
