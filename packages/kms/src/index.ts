// Credential encryption for hosted Midplane.
//
// Trust posture: a US-region compromise must not decrypt EU DSNs and vice
// versa. One KMS key per region; the key id is stored on the project row
// so decrypts know which key to ask for. Ciphertext is bound to (customerId,
// region) via AAD so a misrouted decrypt fails closed.
//
// Two modes:
//   "env"  AES-256-GCM with a per-region symmetric key from env. Bootstrap
//          default. NOT for production — there's no envelope encryption,
//          rotation story, or HSM.
//   "kms"  AWS KMS GenerateDataKey + AES-256-GCM with the data key.
//          Scaffolded; needs prod IAM + per-region CMKs to be wired. The
//          env-mode wire format is byte-compatible with kms-mode payloads
//          minus the wrapped data key, so migrating later is a re-encrypt
//          job, not a schema break.
//
// Decrypt cache (10-min TTL, 60-min grace) lives in the router, not here.
// This package is pure encrypt/decrypt + key resolution.

import { encryptEnv, decryptEnv } from "./env-mode.ts";
import { encryptKms, decryptKms } from "./kms-mode.ts";
import type { Region, KmsMode } from "./types.ts";

export type { Region, KmsMode } from "./types.ts";

export interface EncryptResult {
  ciphertext: Buffer;
  kmsKeyId: string; // stored on the project row
}

export interface KmsContext {
  mode: KmsMode;
  // Per-region keys. For env mode this is the 32-byte hex secret.
  // For kms mode this is the CMK ARN (or alias).
  envKeys?: Partial<Record<Region, string>>;
  kmsKeys?: Partial<Record<Region, string>>;
}

export function makeKmsContext(env: NodeJS.ProcessEnv): KmsContext {
  const mode = (env.MIDPLANE_KMS_MODE ?? "env") as KmsMode;
  if (mode !== "env" && mode !== "kms") {
    throw new Error(
      `MIDPLANE_KMS_MODE must be 'env' or 'kms' (got '${mode}')`,
    );
  }
  return {
    mode,
    envKeys: {
      eu: env.MIDPLANE_KMS_DEV_KEY_EU,
      us: env.MIDPLANE_KMS_DEV_KEY_US,
    },
    kmsKeys: {
      eu: env.MIDPLANE_KMS_KEY_EU,
      us: env.MIDPLANE_KMS_KEY_US,
    },
  };
}

export async function encryptDsn(
  ctx: KmsContext,
  plaintext: string,
  customerId: string,
  region: Region,
): Promise<EncryptResult> {
  if (ctx.mode === "env") {
    const key = mustKey(ctx.envKeys, region, "MIDPLANE_KMS_DEV_KEY");
    return {
      ciphertext: encryptEnv(plaintext, key, customerId, region),
      kmsKeyId: `env:${region}`,
    };
  }
  const arn = mustKey(ctx.kmsKeys, region, "MIDPLANE_KMS_KEY");
  return encryptKms(plaintext, arn, customerId, region);
}

export async function decryptDsn(
  ctx: KmsContext,
  ciphertext: Buffer,
  customerId: string,
  region: Region,
  kmsKeyId: string,
): Promise<string> {
  if (kmsKeyId.startsWith("env:")) {
    const key = mustKey(ctx.envKeys, region, "MIDPLANE_KMS_DEV_KEY");
    return decryptEnv(ciphertext, key, customerId, region);
  }
  return decryptKms(ciphertext, kmsKeyId, customerId, region);
}

function mustKey(
  table: Partial<Record<Region, string>> | undefined,
  region: Region,
  envPrefix: string,
): string {
  const v = table?.[region];
  if (!v) {
    throw new Error(
      `${envPrefix}_${region.toUpperCase()} is not set (required for region '${region}')`,
    );
  }
  return v;
}
