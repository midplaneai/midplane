// Bootstrap-only AES-256-GCM with a per-region symmetric key.
// Not for production; see kms-mode.ts for the prod path.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { WIRE_VERSION, type Region } from "./types.ts";

const NONCE_LEN = 12;
const TAG_LEN = 16;

export function encryptEnv(
  plaintext: string,
  hexKey: string,
  customerId: string,
  region: Region,
): Buffer {
  const key = decodeKey(hexKey);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${customerId}|${region}`, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([WIRE_VERSION]), nonce, tag, ct]);
}

export function decryptEnv(
  wire: Buffer,
  hexKey: string,
  customerId: string,
  region: Region,
): string {
  if (wire.length < 1 + NONCE_LEN + TAG_LEN) {
    throw new Error("ciphertext too short");
  }
  const version = wire[0];
  if (version !== WIRE_VERSION) {
    throw new Error(`unsupported wire version: ${version}`);
  }
  const nonce = wire.subarray(1, 1 + NONCE_LEN);
  const tag = wire.subarray(1 + NONCE_LEN, 1 + NONCE_LEN + TAG_LEN);
  const ct = wire.subarray(1 + NONCE_LEN + TAG_LEN);
  const key = decodeKey(hexKey);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(`${customerId}|${region}`, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    "utf8",
  );
}

function decodeKey(hex: string): Buffer {
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) {
    throw new Error("env-mode key must be 32 bytes (64 hex chars)");
  }
  return buf;
}
