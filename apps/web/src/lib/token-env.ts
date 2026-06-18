// Selects the prefix family ("live" vs "test") for newly-minted tokens.
// Centralized so the project-create flow, the token-create API/Server
// Action, and the success page all derive the same environment from one
// rule:
//
//   - MIDPLANE_TOKEN_ENV=live|test takes precedence (used by staging
//     deploys that want 'live' prefixes or prod canaries that want 'test').
//   - Otherwise NODE_ENV=production → 'live', everything else → 'test'.
//
// The choice is visible in the URL itself (mp_live_… / mp_test_…), so
// scanners and operators can tell a leaked production token apart from a
// dev token at a glance.

export function tokenEnvFromConfig(env: NodeJS.ProcessEnv): "live" | "test" {
  const override = env.MIDPLANE_TOKEN_ENV;
  if (override === "live" || override === "test") return override;
  return env.NODE_ENV === "production" ? "live" : "test";
}
