// The gateway link protocol, as one import.
//
// Both ends of the link use these modules: the gateway to mint request tokens
// and verify bundles, the control plane to sign bundles and verify request
// tokens. Keeping one implementation of the wire format — rather than a copy on
// each side held together by a parity test — is the point. Everything here is
// pure (node:crypto only, no I/O, no engine internals), so a consumer outside
// the engine can depend on it.

export { b64urlDecode, b64urlEncode } from "./b64.ts";
export {
  APPROVALS_PATH,
  APPROVALS_STATUS_PATH,
  BUNDLE_PATH,
  ENROLL_PATH,
  HEARTBEAT_PATH,
  LINK_ERROR,
  MAX_LINK_RESPONSE_BYTES,
  bundleEtag,
  type LinkErrorCode,
} from "./wire.ts";
export {
  ED25519_PUBLIC_KEY_BYTES,
  generateEd25519KeyPair,
  keyId,
  keyPin,
  privateKeyFromPem,
  publicKeyFromRaw,
  publicKeyRawFromPrivate,
  rawPublicKey,
  type GeneratedKeyPair,
} from "./keys.ts";
export { JwsError } from "./jws.ts";
export {
  APPROVAL_TYP,
  ApprovalOutcomeError,
  MAX_APPROVAL_OUTCOME_LIFETIME_S,
  encodeApprovalOutcome,
  sqlSha256,
  verifyApprovalOutcome,
  type ApprovalOutcomeClaims,
  type ApprovalOutcomeExpectations,
} from "./approval.ts";
export {
  BUNDLE_FIELDS_V1,
  BUNDLE_FORMAT_VERSION,
  BUNDLE_TYP,
  MAX_BUNDLE_BYTES,
  encodeBundle,
  verifyBundle,
  type BundleClaims,
  type BundleExpectations,
  type BundleRejectReason,
  type BundleSigner,
  type BundleVerdict,
} from "./bundle.ts";
export {
  ENROLLMENT_PROOF_TYP,
  MAX_CLOCK_SKEW_S,
  MAX_REQUEST_TOKEN_LIFETIME_S,
  REQUEST_TOKEN_LIFETIME_S,
  REQUEST_TOKEN_TYP,
  RequestTokenError,
  bodyHash,
  mintEnrollmentProof,
  mintRequestToken,
  readRequestTokenKid,
  verifyEnrollmentProof,
  verifyRequestToken,
  type RequestBinding,
  type RequestTokenFailure,
  type VerifiedEnrollmentProof,
  type VerifiedRequestToken,
} from "./request-token.ts";
export {
  ENROLL_RESPONSE_TYP,
  ENROLL_TOKEN_PREFIX,
  EnrollmentError,
  encodeEnrollmentResponse,
  hashEnrollmentToken,
  mintEnrollmentToken,
  parseEnrollmentToken,
  verifyEnrollmentResponse,
  type EnrolledIdentity,
  type EnrollmentResponseClaims,
  type SigningKeyRef,
} from "./enrollment.ts";
