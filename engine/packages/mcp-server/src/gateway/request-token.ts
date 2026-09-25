// Request tokens: how a gateway proves who it is on every call to the control
// plane, without a shared secret and without mTLS.
//
// A request token is a JWT (RFC 7519) signed EdDSA by the gateway's own key —
// an RFC 7523 client assertion — bound to ONE request the way DPoP (RFC 9449)
// binds proofs: method (`htm`), path (`htu`) and, when there is a body, its
// sha256 (`bh`). Lifetime is 60 s as minted and at most 120 s as accepted.
//
// Why not mTLS: the control plane's TLS is terminated by its hosting edge,
// which neither verifies nor forwards client certificates, and customer egress
// often passes a TLS-inspecting proxy, which breaks mTLS outright. A token
// passes through such a proxy — and one that is short-lived and bound to a
// single method, path and body is useless to the proxy that sees it.
//
// What this does NOT give: channel binding. A captured token replays the
// identical request until it expires. The control plane keeps a jti cache and
// every endpoint on the link is idempotent for an identical body.
//
// Two token shapes:
//
//   request token     header { alg, typ: "midplane-gw+jwt", kid: <gateway_id> }
//                     the control plane looks up the gateway's registered key
//   enrollment proof  header { alg, typ: "midplane-gw-enroll+jwt", jwk }
//                     carries the NEW public key being registered, and proves
//                     the caller holds its private half

import { createHash, randomBytes, type KeyObject } from "node:crypto";
import { b64urlDecode, b64urlEncode } from "./b64.ts";
import {
  JwsError,
  checkHeader,
  parseJsonObject,
  parseJws,
  signJws,
  verifyJws,
  type ParsedJws,
} from "./jws.ts";
import { ED25519_PUBLIC_KEY_BYTES, publicKeyFromRaw } from "./keys.ts";

export const REQUEST_TOKEN_TYP = "midplane-gw+jwt";
export const ENROLLMENT_PROOF_TYP = "midplane-gw-enroll+jwt";
/** What the gateway mints. */
export const REQUEST_TOKEN_LIFETIME_S = 60;
/** The most the control plane accepts, so a gateway can't mint long-lived
 *  tokens and turn a leak into a standing credential. */
export const MAX_REQUEST_TOKEN_LIFETIME_S = 120;
/** Tolerated clock difference between gateway and control plane. */
export const MAX_CLOCK_SKEW_S = 60;
const MAX_TOKEN_BYTES = 8 * 1024;

export type RequestTokenFailure =
  | "malformed"
  | "header"
  | "signature"
  | "claims"
  | "binding"
  | "clock_skew";

export class RequestTokenError extends Error {
  constructor(
    public readonly code: RequestTokenFailure,
    message: string,
  ) {
    super(message);
    this.name = "RequestTokenError";
  }
}

/** The request a token is minted for — and, on the control plane, the request
 *  it arrived on. `path` is the URL path only (no origin, no query); the origin
 *  is pinned by `audience`. `body` is the exact bytes sent, or undefined for a
 *  request without one. */
export interface RequestBinding {
  audience: string;
  method: string;
  path: string;
  body?: Uint8Array | string;
}

export function mintRequestToken(
  opts: RequestBinding & { gatewayId: string; privateKey: KeyObject; now?: number },
): string {
  const claims = {
    iss: opts.gatewayId,
    sub: opts.gatewayId,
    ...bindingClaims(opts),
  };
  return signJws(
    { alg: "EdDSA", typ: REQUEST_TOKEN_TYP, kid: opts.gatewayId },
    JSON.stringify(claims),
    opts.privateKey,
  );
}

export function mintEnrollmentProof(
  opts: RequestBinding & { publicKeyRaw: Uint8Array; privateKey: KeyObject; now?: number },
): string {
  return signJws(
    {
      alg: "EdDSA",
      typ: ENROLLMENT_PROOF_TYP,
      jwk: { kty: "OKP", crv: "Ed25519", x: b64urlEncode(opts.publicKeyRaw) },
    },
    JSON.stringify(bindingClaims(opts)),
    opts.privateKey,
  );
}

/** First half of verification on the control plane: parse, check the header,
 *  and return the claimed gateway id so the caller can load that gateway's key
 *  (and its revocation state). Nothing is trusted yet. */
export function readRequestTokenKid(token: string): string {
  const parsed = parseToken(token, REQUEST_TOKEN_TYP, "kid");
  return parsed.header.kid as string;
}

export interface VerifiedRequestToken {
  gatewayId: string;
  jti: string;
  /** Expiry, seconds since the epoch — how long the caller's jti cache must
   *  remember this token. */
  exp: number;
}

/** Second half: verify the token against the gateway's registered public key
 *  and the request it arrived on. Throws RequestTokenError. */
export function verifyRequestToken(
  token: string,
  publicKey: KeyObject,
  expect: RequestBinding & { now?: number },
): VerifiedRequestToken {
  const parsed = parseToken(token, REQUEST_TOKEN_TYP, "kid");
  if (!verifyJws(parsed, publicKey)) {
    throw new RequestTokenError("signature", "request token signature does not verify");
  }
  const claims = parseJsonObject(parsed.payload, "request token");
  const kid = parsed.header.kid as string;
  if (claims.iss !== kid || claims.sub !== kid) {
    throw new RequestTokenError("claims", "request token iss/sub must equal its kid");
  }
  const { jti, exp } = checkBindingClaims(claims, expect);
  return { gatewayId: kid, jti, exp };
}

export interface VerifiedEnrollmentProof {
  /** The raw public key the enrolling gateway proved it holds. */
  publicKeyRaw: Buffer;
  jti: string;
  exp: number;
}

export function verifyEnrollmentProof(
  token: string,
  expect: RequestBinding & { now?: number },
): VerifiedEnrollmentProof {
  const parsed = parseToken(token, ENROLLMENT_PROOF_TYP, "jwk");
  const jwk = parsed.header.jwk as Record<string, unknown>;
  const jwkKeys = Object.keys(jwk).sort();
  if (
    jwkKeys.join(",") !== "crv,kty,x" ||
    jwk.kty !== "OKP" ||
    jwk.crv !== "Ed25519" ||
    typeof jwk.x !== "string"
  ) {
    throw new RequestTokenError("header", "enrollment proof jwk must be exactly {kty: OKP, crv: Ed25519, x}");
  }
  let publicKeyRaw: Buffer;
  let publicKey: KeyObject;
  try {
    publicKeyRaw = b64urlDecode(jwk.x);
    if (publicKeyRaw.length !== ED25519_PUBLIC_KEY_BYTES) throw new Error("wrong length");
    publicKey = publicKeyFromRaw(publicKeyRaw);
  } catch {
    throw new RequestTokenError("header", "enrollment proof jwk.x is not an Ed25519 public key");
  }
  if (!verifyJws(parsed, publicKey)) {
    throw new RequestTokenError("signature", "enrollment proof signature does not verify");
  }
  const claims = parseJsonObject(parsed.payload, "enrollment proof");
  const { jti, exp } = checkBindingClaims(claims, expect);
  return { publicKeyRaw, jti, exp };
}

/** sha256 of the request body, as it appears in `bh`. */
export function bodyHash(body: Uint8Array | string): string {
  return b64urlEncode(createHash("sha256").update(body).digest());
}

function bindingClaims(opts: RequestBinding & { now?: number }): Record<string, unknown> {
  const iat = Math.floor(opts.now ?? Date.now() / 1000);
  return {
    aud: opts.audience,
    iat,
    exp: iat + REQUEST_TOKEN_LIFETIME_S,
    jti: b64urlEncode(randomBytes(16)),
    htm: opts.method.toUpperCase(),
    htu: opts.path,
    ...(opts.body !== undefined ? { bh: bodyHash(opts.body) } : {}),
  };
}

function parseToken(token: string, typ: string, keyParam: "kid" | "jwk"): ParsedJws {
  try {
    const parsed = parseJws(token, MAX_TOKEN_BYTES);
    checkHeader(parsed.header, { typ, keyParam });
    return parsed;
  } catch (err) {
    if (err instanceof JwsError) {
      throw new RequestTokenError(err.code === "header" ? "header" : "malformed", err.message);
    }
    throw err;
  }
}

function checkBindingClaims(
  claims: Record<string, unknown>,
  expect: RequestBinding & { now?: number },
): { jti: string; exp: number } {
  const { aud, iat, exp, jti, htm, htu, bh } = claims;
  if (
    typeof aud !== "string" ||
    !Number.isSafeInteger(iat) ||
    !Number.isSafeInteger(exp) ||
    typeof jti !== "string" ||
    jti.length < 16 ||
    jti.length > 64 ||
    typeof htm !== "string" ||
    typeof htu !== "string"
  ) {
    throw new RequestTokenError("claims", "request token is missing aud, iat, exp, jti, htm or htu");
  }
  if (aud !== expect.audience) {
    throw new RequestTokenError("binding", "request token audience does not match");
  }
  if (htm !== expect.method.toUpperCase() || htu !== expect.path) {
    throw new RequestTokenError("binding", "request token is bound to a different method or path");
  }
  if (expect.body === undefined) {
    if (bh !== undefined) {
      throw new RequestTokenError("binding", "request token carries a body hash but the request has no body");
    }
  } else if (bh !== bodyHash(expect.body)) {
    throw new RequestTokenError("binding", "request token body hash does not match the body");
  }

  const iatN = iat as number;
  const expN = exp as number;
  if (expN <= iatN || expN - iatN > MAX_REQUEST_TOKEN_LIFETIME_S) {
    throw new RequestTokenError("claims", `request token lifetime must be 1–${MAX_REQUEST_TOKEN_LIFETIME_S} s`);
  }
  const now = Math.floor(expect.now ?? Date.now() / 1000);
  if (iatN > now + MAX_CLOCK_SKEW_S || expN <= now - MAX_CLOCK_SKEW_S) {
    throw new RequestTokenError("clock_skew", "request token is outside the accepted time window");
  }
  return { jti, exp: expN };
}
