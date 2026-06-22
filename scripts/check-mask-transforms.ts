#!/usr/bin/env bun
// CI drift check for the masking transform catalog.
//
// A mask rule is a param-free preset (a bare string) or a parametric transform
// (a tagged object); the unit that must agree across the deployable boundary is
// the set of transform KINDS — the preset names plus the parametric `t`
// discriminants (a rule's PARAMS don't affect skew safety; the KIND is what an
// engine must recognize to apply it). The catalog of kinds has two copies:
//   - cloud:  MASK_TRANSFORMS   (packages/db/src/policy.ts) — validates saves,
//             serializes the column_masks YAML, drives the dashboard picker.
//   - engine: TRANSFORM_NAMES   (engine/packages/engine/src/masking/transforms.ts,
//             = TRANSFORM_KINDS) — the kinds applyTransform dispatches on; an
//             unknown kind fails CLOSED at runtime.
// The cloud does NOT import @midplane/engine (separate deployable), so the two
// lists are maintained by hand — exactly the situation the OSS image pin solves
// with check-image-pin.ts. This script fails CI if they diverge: a cloud that
// offers a kind the engine doesn't know would serialize a policy the engine
// rejects, and an engine kind the cloud never offers is dead code.
//
//   bun scripts/check-mask-transforms.ts

import { MASK_TRANSFORMS, PSEUDONYMIZE_KINDS as CLOUD_PSEUDONYMIZE_KINDS } from "../packages/db/src/policy.ts";
import {
  PSEUDONYMIZE_KINDS as ENGINE_PSEUDONYMIZE_KINDS,
  TRANSFORM_NAMES,
} from "../engine/packages/engine/src/masking/transforms.ts";

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
      problems.push(`cloud MASK_TRANSFORMS has kind "${t}" the engine does not implement`);
    }
  }
  for (const t of engine) {
    if (!cloudSet.has(t)) {
      problems.push(`engine TRANSFORM_NAMES has kind "${t}" the cloud never offers`);
    }
  }
  if (problems.length === 0 && cloud.join(",") !== engine.join(",")) {
    problems.push(
      `same set, different order — cloud=[${cloud.join(", ")}] engine=[${engine.join(", ")}]`,
    );
  }
  return problems;
}

// A SECOND lockstep the kind-level check above does NOT cover: the set of
// `pseudonymize` KINDS the cloud validator accepts must equal the set of
// dictionaries the engine ships. If the cloud emitted `kind: city` and the
// engine had no `city` dictionary, the engine would fail closed (reject) — a
// confusing dead-end, not a leak, but still drift. Compare the two sets (and
// order, for the same determinism reasons as the kind list).
export function findPseudonymizeKindDrift(
  cloud: readonly string[],
  engine: readonly string[],
): string[] {
  const problems: string[] = [];
  const cloudSet = new Set(cloud);
  const engineSet = new Set(engine);
  for (const k of cloud) {
    if (!engineSet.has(k)) {
      problems.push(`cloud offers pseudonymize kind "${k}" the engine has no dictionary for`);
    }
  }
  for (const k of engine) {
    if (!cloudSet.has(k)) {
      problems.push(`engine ships pseudonymize dictionary "${k}" the cloud never offers`);
    }
  }
  if (problems.length === 0 && cloud.join(",") !== engine.join(",")) {
    problems.push(
      `pseudonymize kinds same set, different order — cloud=[${cloud.join(", ")}] engine=[${engine.join(", ")}]`,
    );
  }
  return problems;
}

function main(): void {
  const problems = [
    ...findTransformDrift([...MASK_TRANSFORMS], [...TRANSFORM_NAMES]),
    ...findPseudonymizeKindDrift(
      [...CLOUD_PSEUDONYMIZE_KINDS],
      [...ENGINE_PSEUDONYMIZE_KINDS],
    ),
  ];
  if (problems.length > 0) {
    console.error("✗ masking transform drift between cloud and engine:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      "\nFix: edit MASK_TRANSFORMS / PSEUDONYMIZE_KINDS (packages/db/src/policy.ts)\n" +
        "and TRANSFORM_KINDS / PSEUDONYMIZE_KINDS (engine/packages/engine/src/masking/\n" +
        "transforms.ts) so they list the same kinds in the same order. A new kind\n" +
        "also needs an applyTransform case in the engine and a published engine image\n" +
        "before the cloud offers it; a new pseudonymize kind needs a shipped dictionary.",
    );
    process.exit(1);
  }
  console.log(
    `✓ masking transform kinds in sync (${MASK_TRANSFORMS.length}): ${MASK_TRANSFORMS.join(", ")}\n` +
      `✓ pseudonymize kinds in sync (${CLOUD_PSEUDONYMIZE_KINDS.length}): ${CLOUD_PSEUDONYMIZE_KINDS.join(", ")}`,
  );
}

if (import.meta.main) main();
