// Protocol branches the main suites don't reach: the control plane's encoder
// refusing a malformed bundle before signing it, signed-but-broken payloads,
// header members of the wrong type, enrollment responses whose key list or kid
// doesn't line up, and request-token claims that are present but invalid.

import { describe, expect, test } from "bun:test";
import { sign } from "node:crypto";
import {
  BUNDLE_TYP,
  ENROLL_RESPONSE_TYP,
  MAX_BUNDLE_BYTES,
  REQUEST_TOKEN_TYP,
  RequestTokenError,
  b64urlEncode,
  encodeBundle,
  encodeEnrollmentResponse,
  mintEnrollmentToken,
  mintRequestToken,
  parseEnrollmentToken,
  verifyBundle,
  verifyEnrollmentResponse,
  verifyRequestToken,
  type BundleExpectations,
} from "../../src/gateway/protocol.ts";
import { ISSUER, PROJECT, bundle, craftJws, decodePayload, testKey } from "./_fixtures.ts";

const signer = testKey();
const signWith = (k = signer) => (input: Buffer) => sign(null, input, k.privateKey);

function expectations(): BundleExpectations {
  return { signer: { kid: signer.kid, publicKey: signer.publicKey }, issuer: ISSUER, projectId: PROJECT, current: null, minVersion: 1 };
}

describe("encodeBundle (control-plane side) refuses what no gateway should be sent", () => {
  test("every malformed claim, a core field smuggled in as `extra`, and an oversize policy", () => {
    const base = { iss: ISSUER, project_id: PROJECT, version: 2, iat: 1_790_000_000, paused: false, policy: "x" };
    const s = { kid: signer.kid, privateKey: signer.privateKey };
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ iss: "" }, /iss is required/],
      [{ project_id: "" }, /project_id is required/],
      [{ version: 0 }, /positive integer/],
      [{ version: 1.5 }, /positive integer/],
      [{ iat: 1.5 }, /iat must be an integer/],
      [{ paused: "false" }, /paused must be a boolean/],
      [{ policy: 42 }, /policy must be a string/],
    ];
    for (const [over, msg] of cases) {
      expect(() => encodeBundle({ ...base, ...over } as never, s)).toThrow(msg);
    }
    // A later envelope field can ride in `extra`; a core one can't be overridden that way.
    expect(() => encodeBundle(base, s, { paused: true })).toThrow(/shadows a core field/);
    expect(() => encodeBundle({ ...base, policy: "a".repeat(MAX_BUNDLE_BYTES) }, s)).toThrow(/exceeds/);
  });
});

describe("signed but broken", () => {
  test("mistyped v1 fields, non-object payloads and wrong-typed header members are rejected, never applied", () => {
    const good = decodePayload(bundle(signer, { version: 2 }));
    const reason = (jws: string) => {
      const v = verifyBundle(jws, expectations());
      return v.kind === "reject" ? v.reason : v.kind;
    };
    const header = { alg: "EdDSA", typ: BUNDLE_TYP, kid: signer.kid };

    for (const over of [{ crit: "paused" }, { crit: [1] }, { iat: "now" }, { policy: { databases: [] } }]) {
      expect(reason(craftJws(header, { ...good, ...over }, signWith()))).toBe("malformed");
    }
    // Validly signed, but the payload is JSON that isn't an object.
    expect(reason(craftJws(header, "[1,2,3]", signWith()))).toBe("malformed");
    expect(reason(craftJws(header, "not json", signWith()))).toBe("malformed");
    // Header present with the right keys but the wrong types.
    expect(reason(craftJws({ ...header, kid: "" }, good, signWith()))).toBe("header");
    expect(reason(craftJws({ ...header, kid: 7 }, good, signWith()))).toBe("header");
    // A header that is JSON but not an object.
    const [, p, s] = bundle(signer, { version: 2 }).split(".");
    expect(reason(`${b64urlEncode("[]")}.${p}.${s}`)).toBe("malformed");
    // A signature of the wrong length is a signature failure, not a crash.
    expect(reason(`${bundle(signer, { version: 2 }).split(".").slice(0, 2).join(".")}.${b64urlEncode(Buffer.alloc(63))}`)).toBe(
      "signature",
    );
  });

  test("request-token claims that are present but invalid fail as claims; method case doesn't matter", () => {
    const gw = testKey();
    const now = 1_790_000_000;
    const binding = { audience: ISSUER, method: "get", path: "/api/gateway/v1/bundle" };
    const token = mintRequestToken({ ...binding, gatewayId: "01GW", privateKey: gw.privateKey, now });
    expect(verifyRequestToken(token, gw.publicKey, { ...binding, method: "GET", now }).gatewayId).toBe("01GW");

    const claims = decodePayload(token);
    const code = (over: Record<string, unknown>) => {
      const t = craftJws({ alg: "EdDSA", typ: REQUEST_TOKEN_TYP, kid: "01GW" }, { ...claims, ...over }, signWith(gw));
      try {
        verifyRequestToken(t, gw.publicKey, { ...binding, now });
        return "ok";
      } catch (err) {
        if (err instanceof RequestTokenError) return err.code;
        throw err;
      }
    };
    expect(code({ jti: "short" })).toBe("claims");
    expect(code({ jti: "x".repeat(65) })).toBe("claims");
    expect(code({ iat: "1790000000" })).toBe("claims");
    expect(code({ htu: undefined })).toBe("claims");
    expect(code({ exp: now })).toBe("claims"); // exp must be after iat
  });
});

describe("verifyEnrollmentResponse — key list and kid", () => {
  const bundleKey = testKey();
  const gateway = testKey();
  const { pin } = parseEnrollmentToken(mintEnrollmentToken(bundleKey.raw));
  const claims = {
    iss: ISSUER,
    project_id: PROJECT,
    gateway_id: "01GW",
    gateway_key: b64urlEncode(gateway.raw),
    signing_keys: [{ kid: bundleKey.kid, x: b64urlEncode(bundleKey.raw) }],
    min_version: 1,
    poll_seconds: 15,
    iat: 1_790_000_000,
  };
  const verify = (jws: string) => verifyEnrollmentResponse(jws, { pin, gatewayPublicKeyRaw: gateway.raw });
  const signed = (payload: Record<string, unknown> | string, kid = bundleKey.kid) =>
    craftJws({ alg: "EdDSA", typ: ENROLL_RESPONSE_TYP, kid }, payload, signWith(bundleKey));

  test("no keys, junk keys, a mislabelled kid and a non-JSON payload are all refused", () => {
    expect(() => verify(signed({ v: 1, ...claims, signing_keys: [] }))).toThrow(/no signing_keys/);
    // Entries that aren't well-formed keys are skipped, so the pinned one is never found.
    expect(() => verify(signed({ v: 1, ...claims, signing_keys: [null, { kid: 1, x: 2 }, { kid: "k", x: "!!" }] }))).toThrow(
      /not signed by the key pinned/,
    );
    // The pinned key listed under a kid that isn't derived from it.
    expect(() => verify(signed({ v: 1, ...claims, signing_keys: [{ kid: "AAAAAAAAAAAAAAAA", x: b64urlEncode(bundleKey.raw) }] }, "AAAAAAAAAAAAAAAA"))).toThrow(
      /kid does not match/,
    );
    // The header names a different kid than the pinned key's.
    expect(() => verify(signed({ v: 1, ...claims }, "BBBBBBBBBBBBBBBB"))).toThrow(/kid does not match/);
    expect(() => verify(signed("not json"))).toThrow(/not JSON/);
    // A well-formed response still verifies (the helper isn't what's failing).
    expect(verify(encodeEnrollmentResponse(claims, { kid: bundleKey.kid, privateKey: bundleKey.privateKey })).gatewayId).toBe("01GW");
  });
});
