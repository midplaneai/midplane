// Shared fixtures for the gateway link tests: a bundle signer, a gateway key,
// and helpers to hand-craft compact JWS values the real encoders would never
// produce (alg confusion, extra header members, forged payloads).

import { createHmac, type KeyObject } from "node:crypto";
import {
  b64urlEncode,
  encodeBundle,
  generateEd25519KeyPair,
  keyId,
  privateKeyFromPem,
  publicKeyFromRaw,
  type BundleClaims,
} from "../../src/gateway/protocol.ts";

export interface TestKey {
  kid: string;
  raw: Buffer;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function testKey(): TestKey {
  const pair = generateEd25519KeyPair();
  return {
    kid: keyId(pair.publicKeyRaw),
    raw: pair.publicKeyRaw,
    privateKey: privateKeyFromPem(pair.privateKeyPem),
    publicKey: publicKeyFromRaw(pair.publicKeyRaw),
  };
}

export const ISSUER = "https://eu.app.midplane.test";
export const PROJECT = "01J8Z6Q3PROJECTAAAAAAAAAAA";

export const POLICY_YAML = [
  "databases:",
  "  - name: main",
  "    url: ${MIDPLANE_DSN_01J8Z6R0DATABASEAAAAAAAAAA}",
  "    table_access:",
  "      default: deny",
  "      tables:",
  "        public.orders: read",
  "    guardrails:",
  "      block_unqualified_dml: true",
  "      block_ddl: true",
  "",
].join("\n");

export function bundle(
  signer: TestKey,
  over: Partial<Omit<BundleClaims, "v">> = {},
  extra: Record<string, unknown> = {},
): string {
  return encodeBundle(
    {
      iss: ISSUER,
      project_id: PROJECT,
      version: 1,
      iat: 1_790_000_000,
      paused: false,
      policy: POLICY_YAML,
      ...over,
    },
    { kid: signer.kid, privateKey: signer.privateKey },
    extra,
  );
}

/** Assemble a compact JWS from raw parts, signing with `sign` (or not at all). */
export function craftJws(
  header: Record<string, unknown>,
  payload: Record<string, unknown> | string,
  sign: (input: Buffer) => Buffer,
): string {
  const h = b64urlEncode(JSON.stringify(header));
  const p = b64urlEncode(typeof payload === "string" ? payload : JSON.stringify(payload));
  const sig = sign(Buffer.from(`${h}.${p}`, "ascii"));
  return `${h}.${p}.${b64urlEncode(sig)}`;
}

/** HMAC "signature" keyed with the public key bytes — the classic alg-confusion
 *  forgery against verifiers that let the header pick the algorithm. */
export function hmacWithPublicKey(key: TestKey) {
  return (input: Buffer) => createHmac("sha256", key.raw).update(input).digest();
}

export function decodePayload(jws: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString("utf8"));
}
