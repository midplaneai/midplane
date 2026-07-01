// column_masks validator + YAML serialization (design A2). Mirrors the
// engine's column_masks schema; the validator is the save-time gate that keeps
// malformed masks out of Postgres, and the serializer emits the per-DB YAML the
// engine reads (plus requires_features so a future engine fails closed).

import { describe, expect, it } from "vitest";

import {
  checkMaskTypeDomain,
  MASK_TRANSFORMS,
  maskRuleKind,
  maskRuleLabel,
  normalizeMaskRule,
  parseColumnMasksOrThrow,
  parseIgnoredColumnsOrThrow,
  pgDataTypeToMaskCategory,
  PSEUDONYMIZE_KINDS,
  serializeMultiDbPolicyToYaml,
  validateColumnMasks,
  validateIgnoredColumns,
  type DatabaseEntry,
  type MaskColumnCategory,
  type MaskRule,
} from "../src/policy.ts";

describe("validateColumnMasks: presets", () => {
  it("treats null/undefined as an empty config", () => {
    expect(validateColumnMasks(null)).toEqual({ ok: true, value: {} });
    expect(validateColumnMasks(undefined)).toEqual({ ok: true, value: {} });
  });

  it("accepts a valid table -> column -> preset map", () => {
    expect(
      validateColumnMasks({
        "public.users": { email: "full-redact", ssn: "consistent-hash" },
      }),
    ).toEqual({
      ok: true,
      value: { "public.users": { email: "full-redact", ssn: "consistent-hash" } },
    });
  });

  it("accepts null-out for any column", () => {
    expect(
      validateColumnMasks({ "public.events": { created_at: "null-out" } }),
    ).toEqual({
      ok: true,
      value: { "public.events": { created_at: "null-out" } },
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

  it("exposes the transform KIND set (drift-checked against the engine)", () => {
    expect([...MASK_TRANSFORMS]).toEqual([
      "full-redact",
      "null-out",
      "consistent-hash",
      "partial",
      "generalize",
      "pseudonymize",
      "noise",
    ]);
  });

  it("exposes the closed pseudonymize-kind set (drift-checked against the engine)", () => {
    expect([...PSEUDONYMIZE_KINDS]).toEqual(["email", "name", "phone"]);
  });
});

describe("validateColumnMasks: partial", () => {
  it("accepts keepStart / keepEnd / glyph and keeps a minimal canonical form", () => {
    expect(
      validateColumnMasks({ "public.users": { ssn: { t: "partial", keepEnd: 4 } } }),
    ).toEqual({ ok: true, value: { "public.users": { ssn: { t: "partial", keepEnd: 4 } } } });

    expect(
      validateColumnMasks({
        "public.users": { card: { t: "partial", keepStart: 2, keepEnd: 4, glyph: "#" } },
      }),
    ).toEqual({
      ok: true,
      value: { "public.users": { card: { t: "partial", keepStart: 2, keepEnd: 4, glyph: "#" } } },
    });
  });

  it("drops zero keeps + a default glyph from the canonical form", () => {
    const r = validateColumnMasks({
      "public.users": { ssn: { t: "partial", keepStart: 0, keepEnd: 4 } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value["public.users"]!.ssn).toEqual({ t: "partial", keepEnd: 4 });
  });

  it("rejects non-integer / negative keeps and over-cap sums", () => {
    expect(validateColumnMasks({ "public.users": { ssn: { t: "partial", keepEnd: -1 } } }).ok).toBe(false);
    expect(validateColumnMasks({ "public.users": { ssn: { t: "partial", keepEnd: 1.5 } } }).ok).toBe(false);
    expect(
      validateColumnMasks({ "public.users": { ssn: { t: "partial", keepStart: 40, keepEnd: 40 } } }).ok,
    ).toBe(false);
  });

  it("rejects a multi-character glyph", () => {
    const r = validateColumnMasks({ "public.users": { ssn: { t: "partial", keepEnd: 4, glyph: "ab" } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toContain("single character");
  });
});

describe("validateColumnMasks: generalize", () => {
  it("accepts a date unit and a numeric bucket width", () => {
    expect(
      validateColumnMasks({
        "public.people": {
          dob: { t: "generalize", granularity: "year" },
          salary: { t: "generalize", granularity: 1000 },
        },
      }),
    ).toEqual({
      ok: true,
      value: {
        "public.people": {
          dob: { t: "generalize", granularity: "year" },
          salary: { t: "generalize", granularity: 1000 },
        },
      },
    });
  });

  it("rejects an unknown unit or a non-positive / non-integer width", () => {
    expect(validateColumnMasks({ "public.people": { dob: { t: "generalize", granularity: "decade" } } }).ok).toBe(false);
    expect(validateColumnMasks({ "public.people": { salary: { t: "generalize", granularity: 0 } } }).ok).toBe(false);
    expect(validateColumnMasks({ "public.people": { salary: { t: "generalize", granularity: -100 } } }).ok).toBe(false);
    expect(validateColumnMasks({ "public.people": { salary: { t: "generalize", granularity: 10.5 } } }).ok).toBe(false);
  });
});

describe("validateColumnMasks: pseudonymize", () => {
  it("accepts each closed kind and round-trips it", () => {
    for (const kind of PSEUDONYMIZE_KINDS) {
      expect(
        validateColumnMasks({ "public.users": { contact: { t: "pseudonymize", kind } } }),
      ).toEqual({
        ok: true,
        value: { "public.users": { contact: { t: "pseudonymize", kind } } },
      });
    }
  });

  it("rejects a kind outside the closed set (no engine dictionary)", () => {
    const r = validateColumnMasks({ "public.users": { city: { t: "pseudonymize", kind: "city" } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toContain("pseudonymize.kind must be one of");
  });

  it("rejects a missing / non-string kind", () => {
    expect(validateColumnMasks({ "public.users": { email: { t: "pseudonymize" } } }).ok).toBe(false);
    expect(validateColumnMasks({ "public.users": { email: { t: "pseudonymize", kind: 42 } } }).ok).toBe(false);
  });
});

describe("validateColumnMasks: noise", () => {
  it("accepts a ratio in (0, 1]", () => {
    expect(validateColumnMasks({ "public.people": { salary: { t: "noise", ratio: 0.1 } } })).toEqual({
      ok: true,
      value: { "public.people": { salary: { t: "noise", ratio: 0.1 } } },
    });
    // The closed upper bound is inclusive.
    expect(validateColumnMasks({ "public.people": { salary: { t: "noise", ratio: 1 } } }).ok).toBe(true);
  });

  it("rejects ratio <= 0, > 1, or non-finite", () => {
    expect(validateColumnMasks({ "public.people": { salary: { t: "noise", ratio: 0 } } }).ok).toBe(false);
    expect(validateColumnMasks({ "public.people": { salary: { t: "noise", ratio: -0.5 } } }).ok).toBe(false);
    expect(validateColumnMasks({ "public.people": { salary: { t: "noise", ratio: 1.5 } } }).ok).toBe(false);
    expect(validateColumnMasks({ "public.people": { salary: { t: "noise", ratio: Number.NaN } } }).ok).toBe(false);
    expect(validateColumnMasks({ "public.people": { salary: { t: "noise" } } }).ok).toBe(false);
  });
});

describe("validateColumnMasks: back-compat reader (keep-last-4)", () => {
  it("normalizes the retired keep-last-4 bare string to partial{keepEnd:4}", () => {
    const r = validateColumnMasks({ "public.users": { ssn: "keep-last-4" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value["public.users"]!.ssn).toEqual({ t: "partial", keepEnd: 4 });
  });

  it("normalizeMaskRule maps keep-last-4 and rejects junk", () => {
    expect(normalizeMaskRule("keep-last-4")).toEqual({ ok: true, value: { t: "partial", keepEnd: 4 } });
    expect(normalizeMaskRule("full-redact")).toEqual({ ok: true, value: "full-redact" });
    expect(normalizeMaskRule("nope").ok).toBe(false);
    expect(normalizeMaskRule({ t: "pseudonymize" }).ok).toBe(false);
  });
});

describe("maskRuleKind / maskRuleLabel", () => {
  it("kind is the preset string or the discriminant", () => {
    expect(maskRuleKind("full-redact")).toBe("full-redact");
    expect(maskRuleKind({ t: "partial", keepEnd: 4 })).toBe("partial");
    expect(maskRuleKind({ t: "generalize", granularity: "year" })).toBe("generalize");
    expect(maskRuleKind({ t: "pseudonymize", kind: "email" })).toBe("pseudonymize");
    expect(maskRuleKind({ t: "noise", ratio: 0.1 })).toBe("noise");
  });
  it("label is human-readable", () => {
    expect(maskRuleLabel("consistent-hash")).toBe("consistent-hash");
    expect(maskRuleLabel({ t: "partial", keepStart: 2, keepEnd: 4 })).toBe("partial · first 2, last 4");
    expect(maskRuleLabel({ t: "generalize", granularity: 1000 })).toBe("generalize · 1000");
    expect(maskRuleLabel({ t: "pseudonymize", kind: "email" })).toBe("pseudonymize · email");
    expect(maskRuleLabel({ t: "noise", ratio: 0.1 })).toBe("noise · ±10%");
  });
});

describe("parseColumnMasksOrThrow", () => {
  it("throws on invalid input (spawner fail-closed)", () => {
    expect(() =>
      parseColumnMasksOrThrow({ "public.users": { email: "nope" } }),
    ).toThrow(/invalid column_masks/);
  });

  it("normalizes legacy rows (keep-last-4) without throwing", () => {
    expect(parseColumnMasksOrThrow({ "public.users": { ssn: "keep-last-4" } })).toEqual({
      "public.users": { ssn: { t: "partial", keepEnd: 4 } },
    });
  });
});

describe("mask type-domain validation (ET6 / B5)", () => {
  it("maps information_schema data_type strings to the engine's typcategory", () => {
    for (const t of ["text", "character varying", "varchar", "char", "name", "citext"]) {
      expect(pgDataTypeToMaskCategory(t)).toBe("S");
    }
    for (const t of ["integer", "bigint", "smallint", "numeric", "decimal", "real", "double precision", "money"]) {
      expect(pgDataTypeToMaskCategory(t)).toBe("N");
    }
    for (const t of ["date", "timestamp without time zone", "timestamp with time zone", "time with time zone"]) {
      expect(pgDataTypeToMaskCategory(t)).toBe("D");
    }
    // unknown / user-defined → null → the check is SKIPPED (query-time backstop).
    for (const t of ["boolean", "uuid", "jsonb", "bytea", "interval", "USER-DEFINED"]) {
      expect(pgDataTypeToMaskCategory(t)).toBeNull();
    }
  });

  it("pins the (transform, category) grid for BOTH modes — must match the engine SSOTs", () => {
    // post_exec mirrors mask-result-set.ts checkInputDomain (full-redact/consistent-hash
    // are DOMAIN-FREE); source_rewrite mirrors transform-sql.ts (they collapse to text).
    // Drift here means authoring-time and query-time disagree.
    const grid: Array<{ rule: MaskRule; post: [boolean, boolean, boolean]; rw: [boolean, boolean, boolean] }> = [
      // rule                                   post_exec [S,N,D]   source_rewrite [S,N,D]
      { rule: "null-out",                        post: [true, true, true],   rw: [true, true, true] },
      { rule: "full-redact",                     post: [true, true, true],   rw: [true, false, false] },
      { rule: "consistent-hash",                 post: [true, true, true],   rw: [true, false, false] },
      { rule: { t: "partial", keepEnd: 4 },      post: [true, false, false], rw: [true, false, false] },
      { rule: { t: "pseudonymize", kind: "email" }, post: [true, false, false], rw: [true, false, false] },
      { rule: { t: "generalize", granularity: "year" }, post: [false, false, true], rw: [false, false, true] },
      { rule: { t: "generalize", granularity: 1000 }, post: [false, true, false], rw: [false, true, false] },
      { rule: { t: "noise", ratio: 0.1 },        post: [false, true, false], rw: [false, true, false] },
    ];
    const cats = ["S", "N", "D"] as MaskColumnCategory[];
    for (const row of grid) {
      cats.forEach((cat, i) => {
        expect(checkMaskTypeDomain(row.rule, cat, "post_exec").ok).toBe(row.post[i]);
        expect(checkMaskTypeDomain(row.rule, cat, "source_rewrite").ok).toBe(row.rw[i]);
        // default mode is post_exec (today's live behavior)
        expect(checkMaskTypeDomain(row.rule, cat).ok).toBe(row.post[i]);
      });
    }
  });

  it("default (post_exec) mode does NOT reject full-redact/consistent-hash on non-text (valid today)", () => {
    // Regression: applying source-rewrite strictness by default would reject a mask that
    // is perfectly valid under the current post-exec masker.
    expect(validateColumnMasks(
      { "public.users": { age: "full-redact", joined: "consistent-hash" } },
      { "public.users": { age: "integer", joined: "date" } },
    ).ok).toBe(true);
  });

  it("rejects an always-invalid (transform, type) at authoring even in post_exec mode", () => {
    // partial/generalize/noise on the wrong type is rejected in BOTH modes.
    const r = validateColumnMasks(
      { "public.users": { age: { t: "partial", keepEnd: 4 }, email: { t: "partial", keepEnd: 4 } } },
      { "public.users": { age: "integer", email: "text" } },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.path)).toEqual(["public.users.age"]); // age(int) rejected; email(text) ok
      expect(r.errors[0]!.message).toContain("column type: integer");
    }
  });

  it("source_rewrite mode DOES reject full-redact on a non-text column (pre-flip catch)", () => {
    const r = validateColumnMasks(
      { "public.users": { age: "full-redact" } },
      { "public.users": { age: "integer" } },
      "source_rewrite",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.message).toContain("source-rewrite");
  });

  it("validateColumnMasks skips the check for unknown types + when no types are given", () => {
    // unknown type (jsonb → null category) → not judged.
    expect(validateColumnMasks({ "public.t": { data: "full-redact" } }, { "public.t": { data: "jsonb" } }).ok).toBe(true);
    // no columnTypes → current behavior, no type check.
    expect(validateColumnMasks({ "public.t": { data: "full-redact" } }).ok).toBe(true);
  });

  it("accepts a type-appropriate config (generalize:year on a date, noise on numeric)", () => {
    const r = validateColumnMasks(
      { "public.e": { created_at: { t: "generalize", granularity: "year" }, salary: { t: "noise", ratio: 0.1 } } },
      { "public.e": { created_at: "date", salary: "numeric" } },
    );
    expect(r.ok).toBe(true);
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

  it("emits requires_features + sorted preset column_masks when present", () => {
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

  it("maskSourceRewrite adds the flag + requires_features token when masks are present", () => {
    const yaml = serializeMultiDbPolicyToYaml([
      entry({
        maskSourceRewrite: true,
        columnMasks: { "public.users": { email: "full-redact" } },
      }),
    ]);
    expect(yaml).toContain(
      [
        "    requires_features:",
        "      - column_masks",
        "      - mask_source_rewrite",
        "    mask_source_rewrite: true",
        "    column_masks:",
      ].join("\n"),
    );
  });

  it("maskSourceRewrite defaults OFF ⇒ byte-identical to today (no flag, token = column_masks only)", () => {
    const withMasks = { columnMasks: { "public.users": { email: "full-redact" } } };
    const off = serializeMultiDbPolicyToYaml([entry(withMasks)]);
    expect(off).not.toContain("mask_source_rewrite");
    // Explicit false is the same as absent.
    const explicitOff = serializeMultiDbPolicyToYaml([entry({ ...withMasks, maskSourceRewrite: false })]);
    expect(explicitOff).toEqual(off);
  });

  it("maskSourceRewrite is inert without masks (no token requiring a feature for nothing)", () => {
    const yaml = serializeMultiDbPolicyToYaml([entry({ maskSourceRewrite: true })]);
    expect(yaml).not.toContain("mask_source_rewrite");
    expect(yaml).not.toContain("requires_features");
  });

  it("emits parametric rules as nested block maps (deterministic key order)", () => {
    const yaml = serializeMultiDbPolicyToYaml([
      entry({
        columnMasks: {
          "public.people": {
            ssn: { t: "partial", keepEnd: 4 },
            salary: { t: "generalize", granularity: 1000 },
            dob: { t: "generalize", granularity: "year" },
            card: { t: "partial", keepStart: 2, keepEnd: 4, glyph: "#" },
          },
        },
      }),
    ]);
    expect(yaml).toContain(
      [
        "      public.people:",
        // columns sorted: card, dob, salary, ssn
        "        card:",
        "          t: partial",
        "          keepStart: 2",
        "          keepEnd: 4",
        '          glyph: "#"',
        "        dob:",
        "          t: generalize",
        "          granularity: year",
        "        salary:",
        "          t: generalize",
        "          granularity: 1000",
        "        ssn:",
        "          t: partial",
        "          keepEnd: 4",
      ].join("\n"),
    );
  });

  it("emits pseudonymize (kind) and noise (ratio) as nested block maps", () => {
    const yaml = serializeMultiDbPolicyToYaml([
      entry({
        columnMasks: {
          "public.people": {
            email: { t: "pseudonymize", kind: "email" },
            salary: { t: "noise", ratio: 0.1 },
          },
        },
      }),
    ]);
    expect(yaml).toContain(
      [
        "      public.people:",
        // columns sorted: email, salary
        "        email:",
        "          t: pseudonymize",
        "          kind: email",
        "        salary:",
        "          t: noise",
        "          ratio: 0.1",
      ].join("\n"),
    );
  });

  it("serializes a legacy keep-last-4 value as a partial block (codemod-equivalent)", () => {
    const yaml = serializeMultiDbPolicyToYaml([
      entry({ columnMasks: { "public.users": { ssn: "keep-last-4" } as never } }),
    ]);
    expect(yaml).toContain(
      ["        ssn:", "          t: partial", "          keepEnd: 4"].join("\n"),
    );
  });

  it("an empty columnMasks object emits nothing", () => {
    const yaml = serializeMultiDbPolicyToYaml([entry({ columnMasks: {} })]);
    expect(yaml).not.toContain("column_masks");
  });
});

// ignored_columns — scan-view dismissals. Same identifier shapes as
// column_masks but one level shallower (table -> [column…]); never serialized
// into the engine YAML, so there's no emitter to test.
describe("validateIgnoredColumns", () => {
  it("treats null / undefined as the empty set", () => {
    expect(validateIgnoredColumns(null)).toEqual({ ok: true, value: {} });
    expect(validateIgnoredColumns(undefined)).toEqual({ ok: true, value: {} });
  });

  it("accepts a schema-qualified table mapped to a list of column identifiers", () => {
    expect(
      validateIgnoredColumns({ "public.users": ["display_name", "ip_version"] }),
    ).toEqual({ ok: true, value: { "public.users": ["display_name", "ip_version"] } });
  });

  it("dedupes repeated columns, order-preserving", () => {
    expect(
      validateIgnoredColumns({ "public.users": ["name", "name", "email"] }),
    ).toEqual({ ok: true, value: { "public.users": ["name", "email"] } });
  });

  it("drops a table whose column list is empty", () => {
    expect(validateIgnoredColumns({ "public.users": [] })).toEqual({
      ok: true,
      value: {},
    });
  });

  it("rejects a non-array value", () => {
    expect(validateIgnoredColumns({ "public.users": "email" }).ok).toBe(false);
  });

  it("rejects a non-object top level", () => {
    expect(validateIgnoredColumns(["public.users"]).ok).toBe(false);
    expect(validateIgnoredColumns("nope").ok).toBe(false);
  });

  it("rejects a malformed table identifier", () => {
    expect(validateIgnoredColumns({ "we;ird": ["email"] }).ok).toBe(false);
  });

  it("rejects a malformed column identifier", () => {
    expect(validateIgnoredColumns({ "public.users": ["ema il"] }).ok).toBe(false);
  });

  it("parseIgnoredColumnsOrThrow returns the value on success and throws on garbage", () => {
    expect(parseIgnoredColumnsOrThrow({ "public.users": ["email"] })).toEqual({
      "public.users": ["email"],
    });
    expect(() => parseIgnoredColumnsOrThrow({ "we;ird": ["email"] })).toThrow(
      /invalid ignored_columns/,
    );
  });
});
