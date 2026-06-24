// Masking transforms — unit pins for the catalog.
//
// These cover the transform-level slices of the leak matrix (the rest — alias
// / view / CTE / whole-row provenance — lives in the masker + adversarial
// suites). Focus here: determinism (and the one non-deterministic exception,
// noise), the short-value leak guard, type-domain fail-SAFE redaction, NULL
// passthrough, and fail-closed on an unknown transform.

import { describe, expect, test } from "bun:test";
import {
  applyTransform,
  isMaskRule,
  MASK_PRESETS,
  PARTIAL_MAX_KEEP,
  type MaskRule,
  type TransformContext,
  UnknownTransformError,
} from "../../src/masking/transforms.ts";
import { FIRST_NAMES, LAST_NAMES } from "../../src/masking/dictionaries.ts";

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
  test("reveals keepStart leading + keepEnd trailing characters", () => {
    expect(
      applyTransform({ t: "partial", keepStart: 2, keepEnd: 0 }, "ada@acme.io", SALT),
    ).toBe("ad•••••••••");
    expect(
      applyTransform({ t: "partial", keepEnd: 4 }, "4111111111114242", SALT),
    ).toBe("••••••••••••4242");
  });

  test("a custom glyph is honored", () => {
    expect(applyTransform({ t: "partial", keepEnd: 2, glyph: "*" }, "secret", SALT)).toBe(
      "****et",
    );
  });

  test("short-value guard: a kept span covering the whole value fully masks", () => {
    expect(applyTransform({ t: "partial", keepEnd: 4 }, "4242", SALT)).toBe("••••");
    expect(applyTransform({ t: "partial", keepStart: 2, keepEnd: 2 }, "abcd", SALT)).toBe(
      "••••",
    );
    expect(applyTransform({ t: "partial", keepEnd: 4 }, "x", SALT)).toBe("•");
    expect(applyTransform({ t: "partial", keepEnd: 4 }, "", SALT)).toBe("•");
  });

});

describe("masking/transforms: generalize", () => {
  test("dates truncate to year/month/day (identifier dies, cohort survives)", () => {
    const dob = new Date("1990-07-15T13:45:00Z");
    expect(applyTransform({ t: "generalize", granularity: "year" }, dob, SALT)).toBe(
      "1990-01-01",
    );
    expect(applyTransform({ t: "generalize", granularity: "month" }, dob, SALT)).toBe(
      "1990-07-01",
    );
    expect(applyTransform({ t: "generalize", granularity: "day" }, dob, SALT)).toBe(
      "1990-07-15",
    );
  });

  test("a 'YYYY-MM-DD' date string (pg date type) generalizes too", () => {
    expect(applyTransform({ t: "generalize", granularity: "year" }, "1990-07-15", SALT)).toBe(
      "1990-01-01",
    );
  });

  test("numerics round down to a bucket width (salary band)", () => {
    expect(applyTransform({ t: "generalize", granularity: 1000 }, 84500, SALT)).toBe(84000);
    expect(applyTransform({ t: "generalize", granularity: 1000 }, "84500", SALT)).toBe(84000);
    expect(applyTransform({ t: "generalize", granularity: 10 }, 7, SALT)).toBe(0);
  });

  test("is deterministic — grouping by the generalized column is stable", () => {
    const a = applyTransform({ t: "generalize", granularity: "month" }, "1990-07-15", SALT);
    const b = applyTransform({ t: "generalize", granularity: "month" }, "1990-07-28", SALT);
    expect(a).toBe(b);
  });

  test("out-of-domain value redacts to NULL — never leaks the original", () => {
    // A date granularity on a non-date, or a numeric granularity on non-numeric.
    expect(applyTransform({ t: "generalize", granularity: "year" }, "not-a-date", SALT)).toBeNull();
    expect(applyTransform({ t: "generalize", granularity: 1000 }, "not-a-number", SALT)).toBeNull();
  });
});

describe("masking/transforms: pseudonymize", () => {
  test("emits a realistic fake of the requested shape", () => {
    expect(applyTransform({ t: "pseudonymize", kind: "email" }, "ada@acme.io", SALT)).toMatch(
      /^[a-z]+\.[a-z]+@[a-z.]+$/,
    );
    expect(applyTransform({ t: "pseudonymize", kind: "name" }, "Ada Lovelace", SALT)).toMatch(
      /^[A-Za-z]+ [A-Za-z]+$/,
    );
    expect(applyTransform({ t: "pseudonymize", kind: "phone" }, "+1-202-555-0143", SALT)).toMatch(
      /^\+1-\d{3}-555-01\d{2}$/,
    );
  });

  test("is deterministic — same (salt, value) yields the same fake (join-safe)", () => {
    const a = applyTransform({ t: "pseudonymize", kind: "name" }, "ada@acme.io", SALT);
    const b = applyTransform({ t: "pseudonymize", kind: "name" }, "ada@acme.io", SALT);
    expect(a).toBe(b);
  });

  test("different salt yields an uncorrelated fake for the same value", () => {
    const a = applyTransform({ t: "pseudonymize", kind: "email" }, "ada@acme.io", SALT);
    const b = applyTransform({ t: "pseudonymize", kind: "email" }, "ada@acme.io", SALT_B);
    expect(a).not.toBe(b);
  });

  test("never returns the original value", () => {
    const out = applyTransform({ t: "pseudonymize", kind: "email" }, "ada@acme.io", SALT);
    expect(String(out)).not.toContain("ada@acme.io");
  });

  test("never echoes the input, even for dictionary-shaped values at any salt", () => {
    // Regression: the HMAC index can map a value already shaped like the embedded
    // dictionary data back to itself for some salts (e.g. "Frankie" → "Frankie",
    // "cameron.fletcher@example.com" → itself). A masking transform must never
    // emit the original — the collision fallback (+1 index) must engage. The old
    // code (no collision check) fails this sweep.
    for (let i = 0; i < 64; i++) {
      const ctx: TransformContext = { salt: `salt-${i}` };
      for (let j = 0; j < FIRST_NAMES.length; j++) {
        const fn = FIRST_NAMES[j]!;
        const ln = LAST_NAMES[j % LAST_NAMES.length]!;
        const full = `${fn} ${ln}`;
        const email = `${fn}.${ln}@example.com`.toLowerCase();
        expect((applyTransform({ t: "pseudonymize", kind: "first_name" }, fn, ctx) as string).toLowerCase()).not.toBe(fn.toLowerCase());
        expect((applyTransform({ t: "pseudonymize", kind: "last_name" }, ln, ctx) as string).toLowerCase()).not.toBe(ln.toLowerCase());
        expect(applyTransform({ t: "pseudonymize", kind: "name" }, full, ctx)).not.toBe(full);
        expect(applyTransform({ t: "pseudonymize", kind: "email" }, email, ctx)).not.toBe(email);
      }
    }
  });

  test("the collision fallback stays deterministic (same salt+value → same fake)", () => {
    // Whatever the collision outcome, repeated calls must agree so joins survive.
    for (const name of FIRST_NAMES.slice(0, 8)) {
      const ctx: TransformContext = { salt: "salt-1" };
      const a = applyTransform({ t: "pseudonymize", kind: "first_name" }, name, ctx);
      const b = applyTransform({ t: "pseudonymize", kind: "first_name" }, name, ctx);
      expect(a).toBe(b);
    }
  });
});

describe("masking/transforms: noise (the non-deterministic rung)", () => {
  test("stays within ±ratio of the input and preserves integer-ness", () => {
    for (let i = 0; i < 200; i++) {
      const out = applyTransform({ t: "noise", ratio: 0.2 }, 1000, SALT) as number;
      expect(out).toBeGreaterThanOrEqual(800);
      expect(out).toBeLessThanOrEqual(1200);
      expect(Number.isInteger(out)).toBe(true);
    }
  });

  test("is non-deterministic — repeated calls vary (breaks joins by design)", () => {
    const samples = new Set<number>();
    for (let i = 0; i < 50; i++) {
      samples.add(applyTransform({ t: "noise", ratio: 0.5 }, 1_000_000, SALT) as number);
    }
    expect(samples.size).toBeGreaterThan(1);
  });

  test("a non-numeric value redacts to NULL — never leaks", () => {
    expect(applyTransform({ t: "noise", ratio: 0.2 }, "not-a-number", SALT)).toBeNull();
  });
});

describe("masking/transforms: NULL handling", () => {
  test("NULL passes through as NULL for every transform", () => {
    const rules: MaskRule[] = [
      ...MASK_PRESETS,
      { t: "partial", keepEnd: 4 },
      { t: "generalize", granularity: "year" },
      { t: "pseudonymize", kind: "email" },
      { t: "noise", ratio: 0.2 },
    ];
    for (const rule of rules) {
      expect(applyTransform(rule, null, SALT)).toBeNull();
      expect(applyTransform(rule, undefined, SALT)).toBeUndefined();
    }
  });
});

describe("masking/transforms: fail-closed on unknown transform", () => {
  test("an out-of-catalog preset string throws (masker turns this into reject)", () => {
    expect(() =>
      // Cast through unknown: simulates a stale engine receiving a transform
      // name from a newer cloud that this engine version does not know.
      applyTransform("format-preserving-fake" as never, "ada@acme.io", SALT),
    ).toThrow(UnknownTransformError);
  });

  test("an out-of-catalog parametric `t` throws", () => {
    expect(() =>
      applyTransform({ t: "redact-future" } as never, "ada@acme.io", SALT),
    ).toThrow(UnknownTransformError);
  });
});

describe("masking/transforms: isMaskRule", () => {
  test("accepts catalog presets and rejects others", () => {
    expect(isMaskRule("full-redact")).toBe(true);
    expect(isMaskRule("null-out")).toBe(true);
    expect(isMaskRule("consistent-hash")).toBe(true);
    expect(isMaskRule("keep-last-4")).toBe(false); // retired — no longer a preset
    expect(isMaskRule("format-preserving-fake")).toBe(false);
    expect(isMaskRule("")).toBe(false);
    expect(isMaskRule(42)).toBe(false);
    expect(isMaskRule(null)).toBe(false);
  });

  test("accepts well-formed parametric rules and rejects malformed ones", () => {
    expect(isMaskRule({ t: "partial", keepStart: 2, keepEnd: 0 })).toBe(true);
    expect(isMaskRule({ t: "partial" })).toBe(true);
    expect(isMaskRule({ t: "partial", keepEnd: -1 })).toBe(false);
    expect(isMaskRule({ t: "partial", keepStart: PARTIAL_MAX_KEEP, keepEnd: 1 })).toBe(false);
    expect(isMaskRule({ t: "partial", glyph: "ab" })).toBe(false);
    expect(isMaskRule({ t: "generalize", granularity: "year" })).toBe(true);
    expect(isMaskRule({ t: "generalize", granularity: 1000 })).toBe(true);
    expect(isMaskRule({ t: "generalize", granularity: 0 })).toBe(false);
    expect(isMaskRule({ t: "generalize", granularity: "decade" })).toBe(false);
    expect(isMaskRule({ t: "pseudonymize", kind: "email" })).toBe(true);
    expect(isMaskRule({ t: "pseudonymize", kind: "ssn" })).toBe(false);
    expect(isMaskRule({ t: "noise", ratio: 0.2 })).toBe(true);
    expect(isMaskRule({ t: "noise", ratio: 0 })).toBe(false);
    expect(isMaskRule({ t: "noise" })).toBe(false);
    expect(isMaskRule({ t: "unknown" })).toBe(false);
  });
});
