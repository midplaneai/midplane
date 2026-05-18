// AWS KMS envelope encryption. Per-region CMK; data-key is generated per
// encrypt call and used with AES-256-GCM. Wire format:
//   version (1) | wrappedKeyLen (2 BE) | wrappedKey (var) | nonce (12) |
//   tag (16) | ciphertext (var)
//
// AAD = `${customerId}|${region}`. EncryptionContext on KMS Decrypt mirrors
// the same pair so a leaked ciphertext misrouted to a different customer or
// region fails decryption at the KMS boundary, not just at AES-GCM.
//
// Bootstrap status: scaffolded but not exercised. The router falls back to
// env-mode in the V1 critical path. Wire prod by adding per-region CMK ARNs
// to env (MIDPLANE_KMS_KEY_EU, MIDPLANE_KMS_KEY_US) and IAM permissions
// for kms:GenerateDataKey + kms:Decrypt scoped per-region.

import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from "@aws-sdk/client-kms";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { WIRE_VERSION, type Region } from "./types.ts";
import type { EncryptResult } from "./index.ts";

const NONCE_LEN = 12;
const TAG_LEN = 16;
const KMS_VERSION = 0x02; // distinguishes from env-mode wire

const clients = new Map<Region, KMSClient>();

function clientFor(region: Region): KMSClient {
  let c = clients.get(region);
  if (!c) {
    c = new KMSClient({ region: regionToAws(region) });
    clients.set(region, c);
  }
  return c;
}

function regionToAws(region: Region): string {
  switch (region) {
    case "eu":
      return "eu-central-1";
    case "us":
      return "us-east-2";
  }
}

export async function encryptKms(
  plaintext: string,
  cmkArn: string,
  customerId: string,
  region: Region,
): Promise<EncryptResult> {
  const out = await clientFor(region).send(
    new GenerateDataKeyCommand({
      KeyId: cmkArn,
      KeySpec: "AES_256",
      EncryptionContext: { customerId, region },
    }),
  );
  if (!out.Plaintext || !out.CiphertextBlob) {
    throw new Error("KMS GenerateDataKey returned empty payload");
  }
  const dataKey = Buffer.from(out.Plaintext);
  const wrapped = Buffer.from(out.CiphertextBlob);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
  cipher.setAAD(Buffer.from(`${customerId}|${region}`, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Zero the data key on the heap as soon as we're done with it.
  dataKey.fill(0);

  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(wrapped.length, 0);
  return {
    ciphertext: Buffer.concat([
      Buffer.from([KMS_VERSION]),
      lenBuf,
      wrapped,
      nonce,
      tag,
      ct,
    ]),
    kmsKeyId: cmkArn,
  };
}

export async function decryptKms(
  wire: Buffer,
  cmkArn: string,
  customerId: string,
  region: Region,
): Promise<string> {
  if (wire.length < 1 + 2) throw new Error("ciphertext too short");
  if (wire[0] === WIRE_VERSION) {
    throw new Error(
      "ciphertext is env-mode; route via decryptEnv, not decryptKms",
    );
  }
  if (wire[0] !== KMS_VERSION) {
    throw new Error(`unsupported wire version: ${wire[0]}`);
  }
  const wrappedLen = wire.readUInt16BE(1);
  let off = 3;
  const wrapped = wire.subarray(off, off + wrappedLen);
  off += wrappedLen;
  const nonce = wire.subarray(off, off + NONCE_LEN);
  off += NONCE_LEN;
  const tag = wire.subarray(off, off + TAG_LEN);
  off += TAG_LEN;
  const ct = wire.subarray(off);

  const out = await clientFor(region).send(
    new DecryptCommand({
      CiphertextBlob: wrapped,
      KeyId: cmkArn,
      EncryptionContext: { customerId, region },
    }),
  );
  if (!out.Plaintext) throw new Error("KMS Decrypt returned empty payload");
  const dataKey = Buffer.from(out.Plaintext);
  const decipher = createDecipheriv("aes-256-gcm", dataKey, nonce);
  decipher.setAAD(Buffer.from(`${customerId}|${region}`, "utf8"));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ct),
    decipher.final(),
  ]).toString("utf8");
  dataKey.fill(0);
  return plaintext;
}
