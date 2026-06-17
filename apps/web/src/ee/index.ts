// ee/ — Enterprise Edition (commercial, NOT MIT).
//
// Open-core boundary (CI-enforced via eslint no-restricted-imports):
//   - MIT core (everything outside ee/) must NEVER import from ee/.
//   - ee/ MAY import from core.
// Deleting ee/ always leaves a working MIT build.
//
// Enterprise features are gated at runtime by eeEnabled(). The signed-license
// verifier is deferred (open-core design doc, decision D3): for now this is a
// simple env check; real ed25519 license verification lands when there is a
// paying self-host customer to enforce against. The cloud gates the same
// features per-plan via the entitlement chokepoint (hasEntitlement); this flag
// is the self-host/build-level switch.

/** Env var that enables Enterprise features for a deployment. */
export const EE_LICENSE_ENV = "MIDPLANE_EE";

/** Whether Enterprise features are enabled for this deployment (placeholder: env-only, D3). */
export function eeEnabled(): boolean {
  return process.env[EE_LICENSE_ENV] === "1";
}
