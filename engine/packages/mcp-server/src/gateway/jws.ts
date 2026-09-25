// Compact JWS (RFC 7515) with exactly one algorithm: EdDSA over Ed25519 (RFC 8037).
//
// Hand-rolled on purpose. The link signs five kinds of object — policy
// bundles, the enrollment response, approval outcomes, request tokens and
// enrollment proofs — and each has one fixed header shape. A general JOSE
// library brings algorithm negotiation, embedded keys (`jwk`, `jku`, `x5u`)
// and `crit` header processing, which is exactly the surface the well-known
// JWT bugs live in. Here the verifier knows the one algorithm and the exact
// header keys up front, and anything else is refused.
//
// Signatures cover the exact bytes received (`b64(header) "." b64(payload)`),
// so nothing is ever re-serialized before verification.

import { sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { b64urlDecode, b64urlEncode } from "./b64.ts";

export type JwsErrorCode = "malformed" | "oversize" | "header" | "signature";

export class JwsError extends Error {
  constructor(
    public readonly code: JwsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "JwsError";
  }
}

export interface ParsedJws {
  header: Record<string, unknown>;
  payload: Buffer;
  /** ASCII `b64(header) "." b64(payload)` — the bytes the signature covers. */
  signingInput: Buffer;
  signature: Buffer;
}

/** The fixed header shape every object on the link uses. `keyParam` is `kid`
 *  (a key the verifier already holds) everywhere except the enrollment proof,
 *  which carries the new public key itself as `jwk`. */
export interface HeaderShape {
  typ: string;
  keyParam: "kid" | "jwk";
}

export function signJws(
  header: { alg: "EdDSA"; typ: string; kid?: string; jwk?: Record<string, string> },
  payload: Uint8Array | string,
  privateKey: KeyObject,
): string {
  const h = b64urlEncode(JSON.stringify(header));
  const p = b64urlEncode(payload);
  const input = Buffer.from(`${h}.${p}`, "ascii");
  const sig = edSign(null, input, privateKey);
  return `${h}.${p}.${b64urlEncode(sig)}`;
}

/** Split and decode a compact JWS. Structural only — no header or signature
 *  checks; callers follow with {@link checkHeader} and {@link verifyJws}. */
export function parseJws(token: string, maxBytes: number): ParsedJws {
  if (typeof token !== "string") {
    throw new JwsError("malformed", "JWS must be a string");
  }
  if (token.length > maxBytes) {
    throw new JwsError("oversize", `JWS exceeds ${maxBytes} bytes`);
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new JwsError("malformed", "compact JWS must have exactly three parts");
  }
  const [h, p, s] = parts as [string, string, string];
  if (h.length === 0 || s.length === 0) {
    throw new JwsError("malformed", "empty JWS header or signature");
  }

  let headerBytes: Buffer;
  let payload: Buffer;
  let signature: Buffer;
  try {
    headerBytes = b64urlDecode(h);
    payload = b64urlDecode(p);
    signature = b64urlDecode(s);
  } catch (err) {
    throw new JwsError("malformed", `JWS part is not base64url: ${(err as Error).message}`);
  }

  return {
    header: parseJsonObject(headerBytes, "JWS header"),
    payload,
    signingInput: Buffer.from(`${h}.${p}`, "ascii"),
    signature,
  };
}

/** Exact-match header check: `alg` is EdDSA, `typ` is the expected value, the
 *  key parameter is present, and there is NOTHING else. An extra member —
 *  `crit`, `jku`, `x5u`, a second key — is a refusal, not something to ignore. */
export function checkHeader(header: Record<string, unknown>, shape: HeaderShape): void {
  const keys = Object.keys(header).sort();
  const want = ["alg", shape.keyParam, "typ"].sort();
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) {
    throw new JwsError(
      "header",
      `JWS header must have exactly ${want.join(", ")}; got ${keys.join(", ") || "(none)"}`,
    );
  }
  if (header.alg !== "EdDSA") {
    throw new JwsError("header", `JWS alg must be EdDSA, got ${String(header.alg)}`);
  }
  if (header.typ !== shape.typ) {
    throw new JwsError("header", `JWS typ must be ${shape.typ}, got ${String(header.typ)}`);
  }
  if (shape.keyParam === "kid") {
    if (typeof header.kid !== "string" || header.kid.length === 0) {
      throw new JwsError("header", "JWS kid must be a non-empty string");
    }
  } else if (typeof header.jwk !== "object" || header.jwk === null || Array.isArray(header.jwk)) {
    throw new JwsError("header", "JWS jwk must be an object");
  }
}

/** Ed25519 verify. False for any failure, including a wrong-length signature
 *  (which some runtimes throw on rather than reject). */
export function verifyJws(parsed: ParsedJws, publicKey: KeyObject): boolean {
  if (parsed.signature.length !== 64) return false;
  try {
    return edVerify(null, parsed.signingInput, publicKey, parsed.signature);
  } catch {
    return false;
  }
}

/** Parse bytes that must hold a JSON object — a JWS header or payload.
 *  `what` names it in the error, e.g. "JWS header", "bundle payload". */
export function parseJsonObject(bytes: Buffer, what: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new JwsError("malformed", `${what} is not JSON`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new JwsError("malformed", `${what} is not a JSON object`);
  }
  return v as Record<string, unknown>;
}
