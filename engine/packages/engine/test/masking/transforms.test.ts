// Masking transforms — unit pins for the v1 catalog.
//
// These cover the transform-level slices of the leak matrix (the rest — alias
// / view / CTE / whole-row provenance — lives in the masker + adversarial
// suites once those land). Focus here: determinism, the short-value leak
// guard, NULL passthrough, and fail-closed on an unknown transform.

import { describe, expect, test } from "bun:test";
import {
  applyTransform,
  isTransformName,
  TRANSFORM_NAMES,
  UnknownTransformError,
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

describe("masking/transforms: keep-last-4", () => {
  test("reveals only the last 4 characters", () => {
    expect(applyTransform("keep-last-4", "4111111111114242", SALT)).toBe(
      "••••••••••••4242",
    );
  });

  test("a value of length <= 4 is FULLY masked — no short-value leak", () => {
    // The dangerous case: returning the whole short value would leak 100%.
    expect(applyTransform("keep-last-4", "4242", SALT)).toBe("••••");
    expect(applyTransform("keep-last-4", "12", SALT)).toBe("••");
    expect(applyTransform("keep-last-4", "x", SALT)).toBe("•");
  });

  test("empty string does not throw and reveals nothing", () => {
    expect(applyTransform("keep-last-4", "", SALT)).toBe("•");
  });
});

describe("masking/transforms: NULL handling", () => {
  test("NULL passes through as NULL for every transform", () => {
    for (const name of TRANSFORM_NAMES) {
      expect(applyTransform(name, null, SALT)).toBeNull();
      expect(applyTransform(name, undefined, SALT)).toBeUndefined();
    }
  });
});

describe("masking/transforms: fail-closed on unknown transform", () => {
  test("an out-of-catalog transform name throws (masker turns this into reject)", () => {
    expect(() =>
      // Cast through unknown: simulates a stale engine receiving a transform
      // name from a newer cloud that this engine version does not know.
      applyTransform(
        "format-preserving-fake" as never,
        "ada@acme.io",
        SALT,
      ),
    ).toThrow(UnknownTransformError);
  });

  test("isTransformName accepts catalog names and rejects others", () => {
    expect(isTransformName("full-redact")).toBe(true);
    expect(isTransformName("consistent-hash")).toBe(true);
    expect(isTransformName("keep-last-4")).toBe(true);
    expect(isTransformName("format-preserving-fake")).toBe(false);
    expect(isTransformName("")).toBe(false);
    expect(isTransformName(42)).toBe(false);
  });
});
