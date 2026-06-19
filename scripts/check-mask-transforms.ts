#!/usr/bin/env bun
// CI drift check for the masking transform catalog.
//
// The masking transform set has two copies across the deployable boundary:
//   - cloud:  MASK_TRANSFORMS   (packages/db/src/policy.ts) — validates saves,
//             serializes the column_masks YAML, drives the dashboard picker.
//   - engine: TRANSFORM_NAMES   (engine/packages/engine/src/masking/transforms.ts)
//             — the values the engine actually applies; an unknown name fails
//             CLOSED at runtime.
// The cloud does NOT import @midplane/engine (separate deployable), so the two
// lists are maintained by hand — exactly the situation the OSS image pin solves
// with check-image-pin.ts. This script fails CI if they diverge: a cloud that
// offers a transform the engine doesn't know would serialize a policy the
// engine rejects, and an engine transform the cloud never offers is dead code.
//
//   bun scripts/check-mask-transforms.ts

import { MASK_TRANSFORMS } from "../packages/db/src/policy.ts";
import { TRANSFORM_NAMES } from "../engine/packages/engine/src/masking/transforms.ts";

// Pure + unit-testable: return human-readable problems, empty when in sync.
// Order is significant (stable UI ordering + deterministic serialization), so
// a same-set/different-order mismatch is also a drift.
export function findTransformDrift(
  cloud: readonly string[],
  engine: readonly string[],
): string[] {
  const problems: string[] = [];
  const cloudSet = new Set(cloud);
  const engineSet = new Set(engine);
  for (const t of cloud) {
    if (!engineSet.has(t)) {
      problems.push(`cloud MASK_TRANSFORMS has "${t}" the engine does not implement`);
    }
  }
  for (const t of engine) {
    if (!cloudSet.has(t)) {
      problems.push(`engine TRANSFORM_NAMES has "${t}" the cloud never offers`);
    }
  }
  if (problems.length === 0 && cloud.join(",") !== engine.join(",")) {
    problems.push(
      `same set, different order — cloud=[${cloud.join(", ")}] engine=[${engine.join(", ")}]`,
    );
  }
  return problems;
}

function main(): void {
  const problems = findTransformDrift([...MASK_TRANSFORMS], [...TRANSFORM_NAMES]);
  if (problems.length > 0) {
    console.error("✗ masking transform drift between cloud and engine:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      "\nFix: edit MASK_TRANSFORMS (packages/db/src/policy.ts) and TRANSFORM_NAMES\n" +
        "(engine/packages/engine/src/masking/transforms.ts) so they list the same\n" +
        "transforms in the same order. A new transform also needs an applyTransform\n" +
        "case in the engine and a published engine image before the cloud offers it.",
    );
    process.exit(1);
  }
  console.log(
    `✓ masking transforms in sync (${MASK_TRANSFORMS.length}): ${MASK_TRANSFORMS.join(", ")}`,
  );
}

if (import.meta.main) main();
