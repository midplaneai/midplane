// Key helpers and strict base64url.

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  b64urlDecode,
  b64urlEncode,
  generateEd25519KeyPair,
  keyId,
  keyPin,
  privateKeyFromPem,
  publicKeyFromRaw,
  publicKeyRawFromPrivate,
} from "../../src/gateway/protocol.ts";

describe("strict base64url", () => {
  test("round-trips", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(b64urlDecode(b64urlEncode(bytes)).equals(bytes)).toBe(true);
  });

  test("refuses padding, foreign characters and non-canonical trailing bits", () => {
    expect(() => b64urlDecode("AAA=")).toThrow();
    expect(() => b64urlDecode("AA+/")).toThrow();
    expect(() => b64urlDecode("A")).toThrow();
    // "AB" and "AA" both decode to 0x00 with lenient decoders; only "AA" is canonical.
    expect(b64urlDecode("AA").equals(Buffer.from([0]))).toBe(true);
    expect(() => b64urlDecode("AB")).toThrow();
  });
});

describe("Ed25519 keys", () => {
  test("PEM private key and raw public key agree", () => {
    const pair = generateEd25519KeyPair();
    expect(pair.publicKeyRaw.length).toBe(32);
    const priv = privateKeyFromPem(pair.privateKeyPem);
    expect(publicKeyRawFromPrivate(priv).equals(pair.publicKeyRaw)).toBe(true);
    expect(publicKeyFromRaw(pair.publicKeyRaw).asymmetricKeyType).toBe("ed25519");
  });

  test("kid is a prefix of the base64url pin", () => {
    const { publicKeyRaw } = generateEd25519KeyPair();
    expect(keyId(publicKeyRaw)).toHaveLength(16);
    expect(b64urlEncode(keyPin(publicKeyRaw)).startsWith(keyId(publicKeyRaw))).toBe(true);
  });

  test("a non-Ed25519 private key is refused at load", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => privateKeyFromPem(pem)).toThrow(/Ed25519/);
  });

  test("a raw public key of the wrong length is refused", () => {
    expect(() => publicKeyFromRaw(Buffer.alloc(31))).toThrow(/32 bytes/);
  });
});
