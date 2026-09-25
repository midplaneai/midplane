// Request tokens and the enrollment proof.
//
// The property under test: a token authorizes exactly one request — this
// gateway, this audience, this method, path and body — within a short window,
// and nothing else. Every mismatch throws, with a code the control plane can
// map to a response (clock skew is the one it reports back in detail).

import { describe, expect, test } from "bun:test";
import { sign } from "node:crypto";
import {
  ENROLLMENT_PROOF_TYP,
  REQUEST_TOKEN_TYP,
  RequestTokenError,
  b64urlEncode,
  mintEnrollmentProof,
  mintRequestToken,
  readRequestTokenKid,
  verifyEnrollmentProof,
  verifyRequestToken,
  type RequestBinding,
} from "../../src/gateway/protocol.ts";
import { ISSUER, craftJws, decodePayload, hmacWithPublicKey, testKey } from "./_fixtures.ts";

const gw = testKey();
const GATEWAY_ID = "01J8Z7GATEWAYAAAAAAAAAAAAA";
const NOW = 1_790_000_000;
const POST: RequestBinding = {
  audience: ISSUER,
  method: "POST",
  path: "/api/gateway/v1/heartbeat",
  body: '{"state":"serving"}',
};
const GET: RequestBinding = { audience: ISSUER, method: "GET", path: "/api/gateway/v1/bundle" };

function mint(binding: RequestBinding, now = NOW): string {
  return mintRequestToken({ ...binding, gatewayId: GATEWAY_ID, privateKey: gw.privateKey, now });
}

function failure(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof RequestTokenError) return err.code;
    throw err;
  }
  return "ok";
}

describe("request tokens", () => {
  test("round trip: the kid names the gateway, verify returns jti + exp", () => {
    const token = mint(POST);
    expect(readRequestTokenKid(token)).toBe(GATEWAY_ID);
    const v = verifyRequestToken(token, gw.publicKey, { ...POST, now: NOW + 5 });
    expect(v.gatewayId).toBe(GATEWAY_ID);
    expect(v.exp).toBe(NOW + 60);
    expect(v.jti.length).toBeGreaterThanOrEqual(16);
  });

  test("a GET carries no body hash and verifies without a body", () => {
    const token = mint(GET);
    expect(decodePayload(token).bh).toBeUndefined();
    expect(failure(() => verifyRequestToken(token, gw.publicKey, { ...GET, now: NOW }))).toBe("ok");
  });

  test("every token has a fresh jti", () => {
    expect(decodePayload(mint(GET)).jti).not.toBe(decodePayload(mint(GET)).jti);
  });

  test("another gateway's key does not verify it", () => {
    expect(failure(() => verifyRequestToken(mint(POST), testKey().publicKey, { ...POST, now: NOW }))).toBe("signature");
  });

  test("bound to the audience", () => {
    expect(failure(() => verifyRequestToken(mint(POST), gw.publicKey, { ...POST, audience: "https://us.app.midplane.test", now: NOW }))).toBe("binding");
  });

  test("bound to the method and path", () => {
    expect(failure(() => verifyRequestToken(mint(POST), gw.publicKey, { ...POST, method: "PUT", now: NOW }))).toBe("binding");
    expect(failure(() => verifyRequestToken(mint(POST), gw.publicKey, { ...POST, path: "/api/gateway/v1/approvals", now: NOW }))).toBe("binding");
  });

  test("bound to the exact body", () => {
    expect(failure(() => verifyRequestToken(mint(POST), gw.publicKey, { ...POST, body: '{"state":"halted"}', now: NOW }))).toBe("binding");
    // A token minted for a bodyless request can't be attached to one with a body, and vice versa.
    expect(failure(() => verifyRequestToken(mint(GET), gw.publicKey, { ...GET, body: "", now: NOW }))).toBe("binding");
    expect(failure(() => verifyRequestToken(mint(POST), gw.publicKey, { ...POST, body: undefined, now: NOW }))).toBe("binding");
  });

  test("time window: skew tolerated up to 60 s either way, not beyond", () => {
    const token = mint(GET);
    expect(failure(() => verifyRequestToken(token, gw.publicKey, { ...GET, now: NOW - 59 }))).toBe("ok");
    expect(failure(() => verifyRequestToken(token, gw.publicKey, { ...GET, now: NOW - 61 }))).toBe("clock_skew");
    expect(failure(() => verifyRequestToken(token, gw.publicKey, { ...GET, now: NOW + 60 + 59 }))).toBe("ok");
    expect(failure(() => verifyRequestToken(token, gw.publicKey, { ...GET, now: NOW + 60 + 60 }))).toBe("clock_skew");
  });

  test("a gateway can't mint a long-lived token", () => {
    const claims = { ...decodePayload(mint(GET)), exp: NOW + 3600 };
    const token = craftJws({ alg: "EdDSA", typ: REQUEST_TOKEN_TYP, kid: GATEWAY_ID }, claims, (i) => sign(null, i, gw.privateKey));
    expect(failure(() => verifyRequestToken(token, gw.publicKey, { ...GET, now: NOW }))).toBe("claims");
  });

  test("iss/sub must name the same gateway as the kid", () => {
    const claims = { ...decodePayload(mint(GET)), sub: "01J8Z7SOMEONEELSEAAAAAAAAA" };
    const token = craftJws({ alg: "EdDSA", typ: REQUEST_TOKEN_TYP, kid: GATEWAY_ID }, claims, (i) => sign(null, i, gw.privateKey));
    expect(failure(() => verifyRequestToken(token, gw.publicKey, { ...GET, now: NOW }))).toBe("claims");
  });

  test("alg confusion and header tampering are refused before any key is loaded", () => {
    const claims = decodePayload(mint(GET));
    const hs = craftJws({ alg: "HS256", typ: REQUEST_TOKEN_TYP, kid: GATEWAY_ID }, claims, hmacWithPublicKey(gw));
    expect(failure(() => readRequestTokenKid(hs))).toBe("header");
    const none = craftJws({ alg: "none", typ: REQUEST_TOKEN_TYP, kid: GATEWAY_ID }, claims, () => Buffer.from("x"));
    expect(failure(() => readRequestTokenKid(none))).toBe("header");
    const bundleTyp = craftJws({ alg: "EdDSA", typ: "midplane-bundle+jws", kid: GATEWAY_ID }, claims, (i) => sign(null, i, gw.privateKey));
    expect(failure(() => readRequestTokenKid(bundleTyp))).toBe("header");
  });

  test("garbage is malformed", () => {
    for (const junk of ["", "Bearer x", "a.b.c", "x".repeat(9000)]) {
      expect(["malformed", "header"]).toContain(failure(() => readRequestTokenKid(junk)));
    }
  });
});

describe("enrollment proof", () => {
  const ENROLL: RequestBinding = { audience: ISSUER, method: "POST", path: "/api/gateway/v1/enroll", body: '{"token":"mpe1_x"}' };

  function proof(now = NOW): string {
    return mintEnrollmentProof({ ...ENROLL, publicKeyRaw: gw.raw, privateKey: gw.privateKey, now });
  }

  test("proves possession and returns the key to register", () => {
    const v = verifyEnrollmentProof(proof(), { ...ENROLL, now: NOW });
    expect(v.publicKeyRaw.equals(gw.raw)).toBe(true);
  });

  test("claiming someone else's public key fails: the signature is by a different key", () => {
    const victim = testKey();
    const token = mintEnrollmentProof({ ...ENROLL, publicKeyRaw: victim.raw, privateKey: gw.privateKey, now: NOW });
    expect(failure(() => verifyEnrollmentProof(token, { ...ENROLL, now: NOW }))).toBe("signature");
  });

  test("the jwk must be exactly an Ed25519 OKP key", () => {
    const claims = decodePayload(proof());
    for (const jwk of [
      { kty: "OKP", crv: "X25519", x: b64urlEncode(gw.raw) },
      { kty: "OKP", crv: "Ed25519", x: b64urlEncode(gw.raw), d: "private!" },
      { kty: "OKP", crv: "Ed25519", x: b64urlEncode(Buffer.alloc(31)) },
    ]) {
      const token = craftJws({ alg: "EdDSA", typ: ENROLLMENT_PROOF_TYP, jwk }, claims, (i) => sign(null, i, gw.privateKey));
      expect(failure(() => verifyEnrollmentProof(token, { ...ENROLL, now: NOW }))).toBe("header");
    }
  });

  test("a request token is not an enrollment proof, and vice versa", () => {
    expect(failure(() => verifyEnrollmentProof(mint(ENROLL), { ...ENROLL, now: NOW }))).toBe("header");
    expect(failure(() => readRequestTokenKid(proof()))).toBe("header");
  });

  test("bound to the enroll request like any other token", () => {
    expect(failure(() => verifyEnrollmentProof(proof(), { ...ENROLL, body: '{"token":"mpe1_y"}', now: NOW }))).toBe("binding");
    expect(failure(() => verifyEnrollmentProof(proof(), { ...ENROLL, now: NOW + 200 }))).toBe("clock_skew");
  });
});
