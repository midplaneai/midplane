// Drift guard — the cross-deployable plumbing for the masking catalog.
// findTransformDrift backs the `check:transforms` CI gate.

import { describe, expect, it } from "vitest";

import { findTransformDrift } from "../../../scripts/check-mask-transforms.ts";
import {
  MASK_TRANSFORM_KINDS,
  GENERALIZE_DATE_GRANULARITIES,
  PSEUDONYMIZE_KINDS,
  PARTIAL_MAX_KEEP,
  NOISE_MAX_RATIO,
} from "../src/policy.ts";

// The real cloud catalog vs itself — the in-sync baseline every drift case
// perturbs from.
const inSyncEnums = {
  cloudGranularities: [...GENERALIZE_DATE_GRANULARITIES],
  engineGranularities: [...GENERALIZE_DATE_GRANULARITIES],
  cloudPseudonymizeKinds: [...PSEUDONYMIZE_KINDS],
  enginePseudonymizeKinds: [...PSEUDONYMIZE_KINDS],
  cloudPartialMaxKeep: PARTIAL_MAX_KEEP,
  enginePartialMaxKeep: PARTIAL_MAX_KEEP,
  cloudNoiseMaxRatio: NOISE_MAX_RATIO,
  engineNoiseMaxRatio: NOISE_MAX_RATIO,
};

describe("findTransformDrift", () => {
  const kinds = [...MASK_TRANSFORM_KINDS];

  it("is silent when both catalogs match", () => {
    expect(findTransformDrift(kinds, kinds, inSyncEnums)).toEqual([]);
  });

  it("flags a transform the engine doesn't implement", () => {
    const problems = findTransformDrift([...kinds, "warp"], kinds, inSyncEnums);
    expect(problems.some((p) => p.includes('"warp"') && p.includes("does not implement"))).toBe(true);
  });

  it("flags a transform the cloud never offers", () => {
    const problems = findTransformDrift(kinds, [...kinds, "warp"], inSyncEnums);
    expect(problems.some((p) => p.includes('"warp"') && p.includes("never offers"))).toBe(true);
  });

  it("flags same-set / different-order", () => {
    const reordered = [kinds[1]!, kinds[0]!, ...kinds.slice(2)];
    const problems = findTransformDrift(kinds, reordered, inSyncEnums);
    expect(problems.some((p) => p.includes("different order"))).toBe(true);
  });

  it("flags a diverging pseudonymize-kind enum and a diverging bound", () => {
    expect(
      findTransformDrift(kinds, kinds, {
        ...inSyncEnums,
        enginePseudonymizeKinds: [...PSEUDONYMIZE_KINDS, "ssn"],
      }).some((p) => p.includes("pseudonymize kinds")),
    ).toBe(true);
    expect(
      findTransformDrift(kinds, kinds, { ...inSyncEnums, engineNoiseMaxRatio: 5 }).some((p) =>
        p.includes("NOISE_MAX_RATIO"),
      ),
    ).toBe(true);
  });
});
