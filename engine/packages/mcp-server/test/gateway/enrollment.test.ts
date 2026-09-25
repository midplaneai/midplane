// Enrollment token + signed enrollment response.
//
// The property under test: a gateway accepts an identity only from the key a
// human copied (as a pin) out of the dashboard, only for its own public key,
// and takes the signed `min_version` as a floor it can never go below.

import { describe, expect, test } from "bun:test";
import { sign } from "node:crypto";
import {
  ENROLL_RESPONSE_TYP,
  ENROLL_TOKEN_PREFIX,
  EnrollmentError,
  b64urlEncode,
  encodeEnrollmentResponse,
  hashEnrollmentToken,
  mintEnrollmentToken,
  parseEnrollmentToken,
  verifyEnrollmentResponse,
  keyPin,
  type EnrollmentResponseClaims,
} from "../../src/gateway/protocol.ts";
import { ISSUER, PROJECT, craftJws, decodePayload, testKey, type TestKey } from "./_fixtures.ts";

const bundleKey = testKey();
const gateway = testKey();

function claims(over: Partial<EnrollmentResponseClaims> = {}, key: TestKey = bundleKey): EnrollmentResponseClaims {
  return {
    iss: ISSUER,
    project_id: PROJECT,
    gateway_id: "01J8Z7GATEWAYAAAAAAAAAAAAA",
    gateway_key: b64urlEncode(gateway.raw),
    signing_keys: [{ kid: key.kid, x: b64urlEncode(key.raw) }],
    min_version: 42,
    poll_seconds: 15,
    iat: 1_790_000_000,
    ...over,
  };
}

function respond(over: Partial<EnrollmentResponseClaims> = {}, key: TestKey = bundleKey): string {
  return encodeEnrollmentResponse(claims(over, key), { kid: key.kid, privateKey: key.privateKey });
}

const token = mintEnrollmentToken(bundleKey.raw);
const { pin } = parseEnrollmentToken(token);

function verify(jws: string) {
  return verifyEnrollmentResponse(jws, { pin, gatewayPublicKeyRaw: gateway.raw });
}

describe("enrollment token", () => {
  test("carries the bundle key's pin and a fresh secret", () => {
    expect(token.startsWith(ENROLL_TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBe(91);
    expect(pin.equals(keyPin(bundleKey.raw))).toBe(true);
    expect(mintEnrollmentToken(bundleKey.raw)).not.toBe(token);
  });

  test("hash is stable and ignores surrounding whitespace from a paste", () => {
    expect(hashEnrollmentToken(`  ${token}\n`)).toBe(hashEnrollmentToken(token));
    expect(hashEnrollmentToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("malformed tokens are refused", () => {
    for (const bad of ["", "mp_abc", `${ENROLL_TOKEN_PREFIX}short`, `${ENROLL_TOKEN_PREFIX}${"A".repeat(86)}=`]) {
      expect(() => parseEnrollmentToken(bad)).toThrow(EnrollmentError);
    }
  });
});

describe("verifyEnrollmentResponse", () => {
  test("a response from the pinned key for this gateway yields the identity", () => {
    const id = verify(respond());
    expect(id).toEqual({
      issuer: ISSUER,
      projectId: PROJECT,
      gatewayId: "01J8Z7GATEWAYAAAAAAAAAAAAA",
      signingKey: { kid: bundleKey.kid, x: b64urlEncode(bundleKey.raw) },
      minVersion: 42,
      pollSeconds: 15,
      enrolledAt: 1_790_000_000,
    });
  });

  test("a response signed by any other key is refused — e.g. a TLS-intercepting proxy's", () => {
    const proxy = testKey();
    expect(() => verify(respond({}, proxy))).toThrow(/not signed by the key pinned/);
  });

  test("listing the pinned key but signing with another is refused", () => {
    const proxy = testKey();
    const jws = encodeEnrollmentResponse(claims(), { kid: bundleKey.kid, privateKey: proxy.privateKey });
    expect(() => verify(jws)).toThrow(/signature/);
  });

  test("a response for a different gateway key is refused", () => {
    expect(() => verify(respond({ gateway_key: b64urlEncode(testKey().raw) }))).toThrow(/different gateway key/);
  });

  test("tampering with min_version after signing breaks the signature", () => {
    const jws = respond();
    const [h, , s] = jws.split(".");
    const payload = { ...decodePayload(jws), min_version: 1 };
    expect(() => verify(`${h}.${b64urlEncode(JSON.stringify(payload))}.${s}`)).toThrow(/signature/);
  });

  test("malformed fields are refused even when signed", () => {
    for (const over of [{ min_version: 0 }, { iss: "eu.app.midplane.test" }, { gateway_id: "" }, { poll_seconds: 0 }]) {
      expect(() => verify(respond(over as Partial<EnrollmentResponseClaims>))).toThrow(/malformed/);
    }
  });

  test("the wrong typ, or a future format, is refused", () => {
    const payload = { v: 1, ...claims() };
    const wrongTyp = craftJws({ alg: "EdDSA", typ: "midplane-bundle+jws", kid: bundleKey.kid }, payload, (i) =>
      sign(null, i, bundleKey.privateKey),
    );
    expect(() => verify(wrongTyp)).toThrow(EnrollmentError);
    const v2 = craftJws({ alg: "EdDSA", typ: ENROLL_RESPONSE_TYP, kid: bundleKey.kid }, { ...payload, v: 2 }, (i) =>
      sign(null, i, bundleKey.privateKey),
    );
    expect(() => verify(v2)).toThrow(/format v2/);
  });
});
