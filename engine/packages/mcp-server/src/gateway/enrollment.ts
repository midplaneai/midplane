// Enrollment: a gateway's one-time introduction to the control plane.
//
// The dashboard mints a one-time token:
//
//   mpe1_<base64url( pin[32] || secret[32] )>
//
// `pin` is sha256 of the control plane's bundle-signing public key. It is what
// makes the enrollment response trustworthy even when the gateway's egress runs
// through a TLS-inspecting proxy the host trusts: a response whose signing key
// doesn't hash to the pin a human copied from the dashboard is refused, so the
// proxy can't substitute a key of its own and sign bundles later.
//
// The enrollment response is itself a compact JWS signed with that bundle key:
//
//   header  { alg: EdDSA, typ: "midplane-enroll+jws", kid }
//   payload { v, iss, project_id, gateway_id, gateway_key, signing_keys,
//             min_version, poll_seconds, iat }
//
// `gateway_key` echoes the public key the gateway registered, binding the
// response to this enrollment. `min_version` is the project's latest bundle
// version at enrollment and becomes the gateway's floor — without it, the same
// proxy could hand a freshly enrolled gateway an old, authentic, looser bundle.

import { createHash, randomBytes, type KeyObject } from "node:crypto";
import { b64urlDecode, b64urlEncode } from "./b64.ts";
import { checkHeader, parseJsonObject, parseJws, signJws, verifyJws, JwsError } from "./jws.ts";
import { ED25519_PUBLIC_KEY_BYTES, keyId, keyPin, publicKeyFromRaw } from "./keys.ts";

export const ENROLL_TOKEN_PREFIX = "mpe1_";
export const ENROLL_RESPONSE_TYP = "midplane-enroll+jws";
const ENROLL_RESPONSE_FORMAT_VERSION = 1;
const MAX_ENROLL_RESPONSE_BYTES = 64 * 1024;
const TOKEN_BODY_BYTES = 64; // pin[32] || secret[32]

export class EnrollmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnrollmentError";
  }
}

/** Control-plane side: a fresh enrollment token pinning `bundleKeyRaw`. Store
 *  only {@link hashEnrollmentToken} of it; show the token once. */
export function mintEnrollmentToken(bundleKeyRaw: Uint8Array): string {
  const body = Buffer.concat([keyPin(bundleKeyRaw), randomBytes(32)]);
  return ENROLL_TOKEN_PREFIX + b64urlEncode(body);
}

/** Gateway side: the pin the enrollment response must match. */
export function parseEnrollmentToken(token: string): { pin: Buffer } {
  const t = token.trim();
  if (!t.startsWith(ENROLL_TOKEN_PREFIX)) {
    throw new EnrollmentError(`enrollment token must start with ${ENROLL_TOKEN_PREFIX}`);
  }
  let body: Buffer;
  try {
    body = b64urlDecode(t.slice(ENROLL_TOKEN_PREFIX.length));
  } catch {
    throw new EnrollmentError("enrollment token is not valid base64url");
  }
  if (body.length !== TOKEN_BODY_BYTES) {
    throw new EnrollmentError("enrollment token has the wrong length");
  }
  return { pin: body.subarray(0, 32) };
}

/** What the control plane stores and looks tokens up by. */
export function hashEnrollmentToken(token: string): string {
  return createHash("sha256").update(token.trim(), "utf8").digest("hex");
}

export interface SigningKeyRef {
  kid: string;
  /** base64url raw Ed25519 public key. */
  x: string;
}

export interface EnrollmentResponseClaims {
  iss: string;
  project_id: string;
  gateway_id: string;
  /** base64url raw public key the gateway registered. */
  gateway_key: string;
  signing_keys: SigningKeyRef[];
  min_version: number;
  poll_seconds: number;
  iat: number;
}

/** Control-plane side. */
export function encodeEnrollmentResponse(
  claims: EnrollmentResponseClaims,
  signer: { kid: string; privateKey: KeyObject },
): string {
  const payload = { v: ENROLL_RESPONSE_FORMAT_VERSION, ...claims };
  return signJws(
    { alg: "EdDSA", typ: ENROLL_RESPONSE_TYP, kid: signer.kid },
    JSON.stringify(payload),
    signer.privateKey,
  );
}

export interface EnrolledIdentity {
  issuer: string;
  projectId: string;
  gatewayId: string;
  /** The bundle key this gateway pins from now on. */
  signingKey: SigningKeyRef;
  minVersion: number;
  pollSeconds: number;
  enrolledAt: number;
}

/** Gateway side. Throws EnrollmentError on anything short of a response signed
 *  by the pinned key, for this gateway's key, with every field well-formed. */
export function verifyEnrollmentResponse(
  jws: string,
  expect: { pin: Uint8Array; gatewayPublicKeyRaw: Uint8Array },
): EnrolledIdentity {
  let parsed;
  try {
    parsed = parseJws(jws, MAX_ENROLL_RESPONSE_BYTES);
    checkHeader(parsed.header, { typ: ENROLL_RESPONSE_TYP, keyParam: "kid" });
  } catch (err) {
    if (err instanceof JwsError) throw new EnrollmentError(`enrollment response: ${err.message}`);
    throw err;
  }

  // The payload names the signing key(s); pick the one matching the pin, then
  // verify with it. Nothing read before the signature check is trusted after
  // it — every field is re-validated below.
  let payload: Record<string, unknown>;
  try {
    payload = parseJsonObject(parsed.payload, "enrollment response");
  } catch (err) {
    throw new EnrollmentError((err as Error).message);
  }
  const keys = payload.signing_keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new EnrollmentError("enrollment response has no signing_keys");
  }
  const pinned = keys.find((k): k is SigningKeyRef => {
    if (typeof k !== "object" || k === null) return false;
    const { kid, x } = k as Record<string, unknown>;
    if (typeof kid !== "string" || typeof x !== "string") return false;
    try {
      const raw = b64urlDecode(x);
      return raw.length === ED25519_PUBLIC_KEY_BYTES && keyPin(raw).equals(Buffer.from(expect.pin));
    } catch {
      return false;
    }
  });
  if (!pinned) {
    throw new EnrollmentError(
      "enrollment response is not signed by the key pinned in the enrollment token — refusing (is a proxy intercepting TLS?)",
    );
  }
  const pinnedRaw = b64urlDecode(pinned.x);
  if (pinned.kid !== keyId(pinnedRaw) || parsed.header.kid !== pinned.kid) {
    throw new EnrollmentError("enrollment response kid does not match the pinned key");
  }
  if (!verifyJws(parsed, publicKeyFromRaw(pinnedRaw))) {
    throw new EnrollmentError("enrollment response signature does not verify against the pinned key");
  }

  const { v, iss, project_id, gateway_id, gateway_key, min_version, poll_seconds, iat } = payload;
  if (v !== ENROLL_RESPONSE_FORMAT_VERSION) {
    throw new EnrollmentError(`enrollment response format v${String(v)} is not supported; upgrade the gateway`);
  }
  if (gateway_key !== b64urlEncode(expect.gatewayPublicKeyRaw)) {
    throw new EnrollmentError("enrollment response is for a different gateway key");
  }
  if (
    typeof iss !== "string" ||
    !/^https?:\/\/[^/]+$/.test(iss) ||
    typeof project_id !== "string" ||
    project_id.length === 0 ||
    typeof gateway_id !== "string" ||
    gateway_id.length === 0 ||
    !Number.isSafeInteger(min_version) ||
    (min_version as number) < 1 ||
    !Number.isSafeInteger(poll_seconds) ||
    (poll_seconds as number) < 1 ||
    !Number.isSafeInteger(iat)
  ) {
    throw new EnrollmentError("enrollment response is missing or has malformed fields");
  }

  return {
    issuer: iss,
    projectId: project_id,
    gatewayId: gateway_id,
    signingKey: { kid: pinned.kid, x: pinned.x },
    minVersion: min_version as number,
    pollSeconds: poll_seconds as number,
    enrolledAt: iat as number,
  };
}
