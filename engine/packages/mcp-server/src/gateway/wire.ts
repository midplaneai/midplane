// The gateway link's HTTP surface: routes, status conventions, error codes.
//
// Request tokens bind `htu` to the exact path string, so a route that drifts
// between gateway and control plane doesn't degrade — every request fails
// `binding`. Both sides therefore take these from here (via protocol.ts).
//
//   POST enroll            200 application/jose — the signed enrollment response
//   GET  bundle            200 application/jose — the newest bundle (stored JWS)
//                          304 — If-None-Match already names the newest version
//                          404 {error: "no_bundle"} — nothing published yet: a
//                          state, not a failure (the gateway neither backs off
//                          nor warns). Enrollment normally guarantees a bundle.
//   POST heartbeat         2xx
//   POST approvals         2xx application/jose — the outcome, SIGNED with the
//                          bundle key and bound to the statement (approval.ts)
//   POST approvals/status  2xx JSON status (read-only; never executes anything)
//
// Errors are JSON `{error: <code>}`; `clock_skew` also carries `server_time`
// (seconds since the epoch). Anything not 2xx/304 is a failure the gateway
// retries with backoff, keeping its current policy.

export const ENROLL_PATH = "/api/gateway/v1/enroll";
export const BUNDLE_PATH = "/api/gateway/v1/bundle";
export const HEARTBEAT_PATH = "/api/gateway/v1/heartbeat";
export const APPROVALS_PATH = "/api/gateway/v1/approvals";
export const APPROVALS_STATUS_PATH = "/api/gateway/v1/approvals/status";

export const LINK_ERROR = {
  unauthorized: "unauthorized",
  gatewayRevoked: "gateway_revoked",
  clockSkew: "clock_skew",
  noBundle: "no_bundle",
  enrollmentTokenInvalid: "enrollment_token_invalid",
  enrollmentTokenExpired: "enrollment_token_expired",
  enrollmentTokenUsed: "enrollment_token_used",
} as const;
export type LinkErrorCode = (typeof LINK_ERROR)[keyof typeof LINK_ERROR];

/** The ETag / If-None-Match value for a bundle version. */
export function bundleEtag(version: number): string {
  return `"${version}"`;
}

/** Response bodies are read with a cap: a bundle is at most MAX_BUNDLE_BYTES,
 *  and nothing else on the link is larger than this. */
export const MAX_LINK_RESPONSE_BYTES = 64 * 1024;
