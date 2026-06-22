// Masking transforms — unit pins for the v1 catalog.
//
// These cover the transform-level slices of the leak matrix (the rest — alias
// / view / CTE / whole-row provenance — lives in the masker + adversarial
// suites once those land). Focus here: determinism, the short-value leak
// guard, NULL passthrough, and fail-closed on an unknown transform.

import { describe, expect, test } from "bun:test";
import {
  applyTransform,
  isTransformKind,
  isTransformName,
  ruleKind,
  TRANSFORM_KINDS,
  TRANSFORM_NAMES,
  UnknownTransformError,
  type MaskRule,
  type TransformContext,
} from "../../src/masking/transforms.ts";

const SALT: TransformContext = { salt: "project-salt-A" };
const SALT_B: TransformContext = { salt: "project-salt-B" };

describe("masking/transforms: full-redact", () => {
  test("collapses any value to a constant token carrying no information", () => {
    expect(applyTransform("full-redact", "ada@acme.io", SALT)).toBe("***");
    expect(applyTransform("full-redact", 12345, SALT)).toBe("***");
    expect(applyTransform("full-redact", "x", SALT)).toBe("***");
  });
});

describe("masking/transforms: null-out", () => {
  test("replaces any value with SQL NULL (type-preserving redaction)", () => {
    expect(applyTransform("null-out", "ada@acme.io", SALT)).toBeNull();
    expect(applyTransform("null-out", 12345, SALT)).toBeNull();
    expect(applyTransform("null-out", true, SALT)).toBeNull();
    expect(applyTransform("null-out", new Date("2020-01-01"), SALT)).toBeNull();
  });

  test("an already-NULL value stays NULL; undefined stays undefined", () => {
    expect(applyTransform("null-out", null, SALT)).toBeNull();
    expect(applyTransform("null-out", undefined, SALT)).toBeUndefined();
  });
});

describe("masking/transforms: consistent-hash", () => {
  test("is deterministic — same (salt, value) yields the same token (joins survive)", () => {
    const a = applyTransform("consistent-hash", "ada@acme.io", SALT);
    const b = applyTransform("consistent-hash", "ada@acme.io", SALT);
    expect(a).toBe(b);
  });

  test("different values yield different tokens", () => {
    const a = applyTransform("consistent-hash", "ada@acme.io", SALT);
    const b = applyTransform("consistent-hash", "bob@acme.io", SALT);
    expect(a).not.toBe(b);
  });

  test("different salt yields a different token for the same value", () => {
    const a = applyTransform("consistent-hash", "ada@acme.io", SALT);
    const b = applyTransform("consistent-hash", "ada@acme.io", SALT_B);
    expect(a).not.toBe(b);
  });

  test("never returns the original value", () => {
    const out = applyTransform("consistent-hash", "ada@acme.io", SALT);
    expect(out).not.toBe("ada@acme.io");
    expect(String(out)).not.toContain("ada@acme.io");
  });
});

describe("masking/transforms: partial (generalizes keep-last-4)", () => {
  test("keepEnd:4 reveals only the last 4 characters (the keep-last-4 case)", () => {
    expect(applyTransform({ t: "partial", keepEnd: 4 }, "4111111111114242", SALT)).toBe(
      "••••••••••••4242",
    );
  });

  test("keepStart reveals the leading characters (e.g. email local part)", () => {
    expect(applyTransform({ t: "partial", keepStart: 2 }, "ada@acme.io", SALT)).toBe(
      "ad•••••••••",
    );
  });

  test("keepStart + keepEnd reveal both ends, mask the middle", () => {
    expect(
      applyTransform({ t: "partial", keepStart: 1, keepEnd: 1 }, "abcdef", SALT),
    ).toBe("a••••f");
  });

  test("a custom glyph is honored", () => {
    expect(applyTransform({ t: "partial", keepEnd: 2, glyph: "#" }, "abcdef", SALT)).toBe(
      "####ef",
    );
  });

  test("short-value guard: when the kept window covers the value, FULLY mask", () => {
    // Returning the whole short value would leak 100% of it.
    expect(applyTransform({ t: "partial", keepEnd: 4 }, "4242", SALT)).toBe("••••");
    expect(applyTransform({ t: "partial", keepEnd: 4 }, "12", SALT)).toBe("••");
    expect(applyTransform({ t: "partial", keepStart: 3, keepEnd: 3 }, "abcde", SALT)).toBe(
      "•••••",
    );
    expect(applyTransform({ t: "partial", keepEnd: 4 }, "x", SALT)).toBe("•");
  });

  test("empty string does not throw and reveals nothing", () => {
    expect(applyTransform({ t: "partial", keepEnd: 4 }, "", SALT)).toBe("•");
  });
});

describe("masking/transforms: generalize — date truncation", () => {
  const TS = new Date("1994-07-23T15:42:11.123Z");

  test("year truncates to Jan 1 (the dob → birth-year case)", () => {
    const out = applyTransform({ t: "generalize", granularity: "year" }, TS, SALT) as Date;
    expect(out.toISOString()).toBe("1994-01-01T00:00:00.000Z");
  });

  test("month truncates to the 1st at midnight UTC", () => {
    const out = applyTransform({ t: "generalize", granularity: "month" }, TS, SALT) as Date;
    expect(out.toISOString()).toBe("1994-07-01T00:00:00.000Z");
  });

  test("day truncates to midnight UTC", () => {
    const out = applyTransform({ t: "generalize", granularity: "day" }, TS, SALT) as Date;
    expect(out.toISOString()).toBe("1994-07-23T00:00:00.000Z");
  });

  test("is deterministic — same instant yields the same truncation", () => {
    const a = applyTransform({ t: "generalize", granularity: "year" }, TS, SALT);
    const b = applyTransform({ t: "generalize", granularity: "year" }, new Date(TS), SALT_B);
    expect((a as Date).toISOString()).toBe((b as Date).toISOString());
  });
});

describe("masking/transforms: generalize — numeric bucketing", () => {
  test("rounds DOWN to a multiple of the bucket width (salary band)", () => {
    expect(applyTransform({ t: "generalize", granularity: 1000 }, 73500, SALT)).toBe(73000);
    expect(applyTransform({ t: "generalize", granularity: 1000 }, 73000, SALT)).toBe(73000);
    expect(applyTransform({ t: "generalize", granularity: 100 }, 99, SALT)).toBe(0);
  });

  test("parses a numeric/int8 value delivered as a string", () => {
    expect(applyTransform({ t: "generalize", granularity: 1000 }, "73500", SALT)).toBe(73000);
  });

  test("buckets negatives by flooring", () => {
    expect(applyTransform({ t: "generalize", granularity: 100 }, -150, SALT)).toBe(-200);
  });
});

describe("masking/transforms: NULL handling", () => {
  test("NULL passes through as NULL for every rule kind", () => {
    const RULES: MaskRule[] = [
      "full-redact",
      "null-out",
      "consistent-hash",
      { t: "partial", keepEnd: 4 },
      { t: "generalize", granularity: "year" },
      { t: "generalize", granularity: 1000 },
    ];
    for (const rule of RULES) {
      expect(applyTransform(rule, null, SALT)).toBeNull();
      expect(applyTransform(rule, undefined, SALT)).toBeUndefined();
    }
  });
});

describe("masking/transforms: fail-closed on unknown rule kind", () => {
  test("an out-of-catalog transform kind throws (masker turns this into reject)", () => {
    expect(() =>
      // Cast through unknown: simulates a stale engine receiving a rule kind
      // from a newer cloud that this engine version does not know.
      applyTransform("format-preserving-fake" as never, "ada@acme.io", SALT),
    ).toThrow(UnknownTransformError);
    expect(() =>
      applyTransform({ t: "pseudonymize" } as never, "ada@acme.io", SALT),
    ).toThrow(UnknownTransformError);
  });

  test("isTransformKind accepts catalog KINDS and rejects others", () => {
    for (const k of ["full-redact", "null-out", "consistent-hash", "partial", "generalize"]) {
      expect(isTransformKind(k)).toBe(true);
    }
    // keep-last-4 is retired — absorbed by partial{keepEnd:4}.
    expect(isTransformKind("keep-last-4")).toBe(false);
    expect(isTransformKind("format-preserving-fake")).toBe(false);
    expect(isTransformKind("")).toBe(false);
    expect(isTransformKind(42)).toBe(false);
    expect(isTransformName("partial")).toBe(true); // deprecated alias still works
  });

  test("ruleKind returns the preset string or the object discriminant", () => {
    expect(ruleKind("full-redact")).toBe("full-redact");
    expect(ruleKind({ t: "partial", keepEnd: 4 })).toBe("partial");
    expect(ruleKind({ t: "generalize", granularity: "year" })).toBe("generalize");
  });

  test("TRANSFORM_KINDS / TRANSFORM_NAMES enumerate the five kinds", () => {
    expect([...TRANSFORM_KINDS]).toEqual([
      "full-redact",
      "null-out",
      "consistent-hash",
      "partial",
      "generalize",
    ]);
    expect(TRANSFORM_NAMES).toBe(TRANSFORM_KINDS); // back-compat alias
  });
});
