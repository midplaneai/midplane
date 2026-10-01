import { type DatabasePolicy, DatabasePolicySchema } from "@midplane/protocol";

/** Enforcement features this core implements. */
export const CORE_FEATURES: ReadonlySet<string> = new Set([
  "table_access",
  "writes",
  "masks",
  "labels",
]);

/**
 * Top-level policy keys every engine has read since the first policy format.
 * Every other section is a feature of the same name.
 */
const BASE_KEYS: ReadonlySet<string> = new Set([
  "requires_features",
  "role",
  "limits",
]);

/**
 * The features an engine needs to enforce a policy as authored: each section
 * it names, even empty (an engine's strict schema refuses a key it doesn't
 * know, whatever its value), and its `requires_features`. Sorted.
 */
export function requiredFeatures(authored: unknown): string[] {
  if (
    authored === null ||
    typeof authored !== "object" ||
    Array.isArray(authored)
  ) {
    return [];
  }
  const out = new Set(Object.keys(authored).filter((k) => !BASE_KEYS.has(k)));
  const listed = (authored as { requires_features?: unknown })
    .requires_features;
  if (Array.isArray(listed)) {
    for (const f of listed) if (typeof f === "string") out.add(f);
  }
  return [...out].sort();
}

export type PolicyValidation =
  | { ok: true; policy: DatabasePolicy }
  | { ok: false; errors: string[] };

/**
 * Validate a policy as the gateway enforces it: the strict schema, then every
 * feature it requires. A policy this core can't fully enforce is refused
 * whole, never partly applied.
 */
export function validatePolicy(raw: unknown): PolicyValidation {
  const parsed = DatabasePolicySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(policy)"}: ${i.message}`,
      ),
    };
  }
  const missing = parsed.data.requires_features.filter(
    (f) => !CORE_FEATURES.has(f),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      errors: [`requires features this engine lacks: ${missing.join(", ")}`],
    };
  }
  return { ok: true, policy: parsed.data };
}
