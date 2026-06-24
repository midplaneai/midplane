#!/usr/bin/env bun
// CI drift check for the masking transform catalog.
//
// The masking catalog has two copies across the deployable boundary:
//   - cloud:  policy.ts (packages/db/src/policy.ts) — MASK_TRANSFORM_KINDS +
//             the param enums/bounds. Validates saves, serializes the
//             column_masks YAML, drives the dashboard picker.
//   - engine: transforms.ts (engine/packages/engine/src/masking/transforms.ts)
//             — TRANSFORM_KINDS + the same enums/bounds. The values the engine
//             actually applies; an unknown name or out-of-bounds param fails
//             CLOSED at runtime.
// The cloud does NOT import @midplane/engine (separate deployable), so the two
// catalogs are maintained by hand — exactly the situation the OSS image pin
// solves with check-image-pin.ts. This script fails CI if they diverge: a cloud
// that offers a transform (or a param range) the engine doesn't know would
// serialize a policy the engine rejects, and the reverse is dead code.
//
//   bun scripts/check-mask-transforms.ts

import {
  MASK_TRANSFORM_KINDS,
  GENERALIZE_DATE_GRANULARITIES as CLOUD_GRANULARITIES,
  PSEUDONYMIZE_KINDS as CLOUD_PSEUDONYMIZE_KINDS,
  PARTIAL_MAX_KEEP as CLOUD_PARTIAL_MAX_KEEP,
  NOISE_MAX_RATIO as CLOUD_NOISE_MAX_RATIO,
} from "../packages/db/src/policy.ts";
import {
  TRANSFORM_KINDS,
  GENERALIZE_DATE_GRANULARITIES as ENGINE_GRANULARITIES,
  PSEUDONYMIZE_KINDS as ENGINE_PSEUDONYMIZE_KINDS,
  PARTIAL_MAX_KEEP as ENGINE_PARTIAL_MAX_KEEP,
  NOISE_MAX_RATIO as ENGINE_NOISE_MAX_RATIO,
} from "../engine/packages/engine/src/masking/transforms.ts";

// Pure + unit-testable: return human-readable problems, empty when in sync.
// Order is significant (stable UI ordering + deterministic serialization), so a
// same-set/different-order mismatch is also a drift. Beyond the kind catalog,
// the param enums/bounds must match too — a cloud that allows `noise{ratio:20}`
// the engine caps at 10 would serialize a policy the engine rejects.
export function findTransformDrift(
  cloud: readonly string[],
  engine: readonly string[],
  enums: {
    cloudGranularities: readonly string[];
    engineGranularities: readonly string[];
    cloudPseudonymizeKinds: readonly string[];
    enginePseudonymizeKinds: readonly string[];
    cloudPartialMaxKeep: number;
    enginePartialMaxKeep: number;
    cloudNoiseMaxRatio: number;
    engineNoiseMaxRatio: number;
  },
): string[] {
  const problems: string[] = [];

  const orderedListDrift = (label: string, a: readonly string[], b: readonly string[]) => {
    const aSet = new Set(a);
    const bSet = new Set(b);
    for (const t of a) {
      if (!bSet.has(t)) problems.push(`cloud ${label} has "${t}" the engine does not implement`);
    }
    for (const t of b) {
      if (!aSet.has(t)) problems.push(`engine ${label} has "${t}" the cloud never offers`);
    }
    if (a.join(",") !== b.join(",") && [...aSet].every((x) => bSet.has(x)) && [...bSet].every((x) => aSet.has(x))) {
      problems.push(`${label}: same set, different order — cloud=[${a.join(", ")}] engine=[${b.join(", ")}]`);
    }
  };

  orderedListDrift("transform kinds", cloud, engine);
  orderedListDrift("generalize granularities", enums.cloudGranularities, enums.engineGranularities);
  orderedListDrift("pseudonymize kinds", enums.cloudPseudonymizeKinds, enums.enginePseudonymizeKinds);

  if (enums.cloudPartialMaxKeep !== enums.enginePartialMaxKeep) {
    problems.push(
      `PARTIAL_MAX_KEEP differs — cloud=${enums.cloudPartialMaxKeep} engine=${enums.enginePartialMaxKeep}`,
    );
  }
  if (enums.cloudNoiseMaxRatio !== enums.engineNoiseMaxRatio) {
    problems.push(
      `NOISE_MAX_RATIO differs — cloud=${enums.cloudNoiseMaxRatio} engine=${enums.engineNoiseMaxRatio}`,
    );
  }

  return problems;
}

function main(): void {
  const problems = findTransformDrift([...MASK_TRANSFORM_KINDS], [...TRANSFORM_KINDS], {
    cloudGranularities: [...CLOUD_GRANULARITIES],
    engineGranularities: [...ENGINE_GRANULARITIES],
    cloudPseudonymizeKinds: [...CLOUD_PSEUDONYMIZE_KINDS],
    enginePseudonymizeKinds: [...ENGINE_PSEUDONYMIZE_KINDS],
    cloudPartialMaxKeep: CLOUD_PARTIAL_MAX_KEEP,
    enginePartialMaxKeep: ENGINE_PARTIAL_MAX_KEEP,
    cloudNoiseMaxRatio: CLOUD_NOISE_MAX_RATIO,
    engineNoiseMaxRatio: ENGINE_NOISE_MAX_RATIO,
  });
  if (problems.length > 0) {
    console.error("✗ masking transform drift between cloud and engine:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      "\nFix: edit the catalog in packages/db/src/policy.ts (MASK_TRANSFORM_KINDS +\n" +
        "enums/bounds) and engine/packages/engine/src/masking/transforms.ts\n" +
        "(TRANSFORM_KINDS + enums/bounds) so they list the same transforms, the\n" +
        "same param enums, and the same bounds in the same order. A new transform\n" +
        "also needs an applyTransform case + zod schema in the engine and a\n" +
        "published engine image before the cloud offers it.",
    );
    process.exit(1);
  }
  console.log(
    `✓ masking transforms in sync (${MASK_TRANSFORM_KINDS.length}): ${MASK_TRANSFORM_KINDS.join(", ")}`,
  );
}

if (import.meta.main) main();
