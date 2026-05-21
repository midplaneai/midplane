// MCP-token pepper module — sibling of index.ts (DSN encryption).
//
// The pepper is a 32-byte secret per region used as the HMAC-SHA256 key
// when hashing mcp_tokens.token_hash at rest. Trust isolation is identical
// to the DSN encryption posture: a US-region compromise must not let an
// attacker forge or invert EU token hashes. One pepper per region today
// (kid "v1-eu" / "v1-us"); rotation introduces "v2-..." kids and the
// lookup tries each kid in turn against the cached map.
//
// Mode parity with index.ts:
//   "env"  base64 secret from MIDPLANE_TOKEN_PEPPER_<REGION>_V1. Dev /
//          staging only. No envelope encryption.
//   "kms"  KMS-encrypted ciphertext from MIDPLANE_TOKEN_PEPPER_CT_<REGION>_V1
//          (base64). The per-region CMK ARN comes from MIDPLANE_KMS_KEY_<REGION>,
//          same source the DSN path reads. EncryptionContext is bound to
//          `{region, purpose: "token-pepper"}` so a DSN ciphertext can't be
//          misrouted through this path and an EU ciphertext can't be
//          Decrypt-ed under the US CMK.
//
// All exports are pure crypto + env lookup — no DB, no logging.

import { createHmac, timingSafeEqual } from "node:crypto";

import { decryptPepperKms } from "./kms-mode.ts";
import type { Region } from "./types.ts";

const PEPPER_LEN = 32;

/** Resolve the active pepper(s) for one region. Returns a `kid → 32-byte
 *  buffer` map; V1 always contains exactly one entry (`v1-<region>`),
 *  but the shape future-proofs rotation, where the lookup path tries
 *  each kid blind against `mcp_tokens.token_hash`.
 *
 *  Throws at boot if the required env var is missing or malformed —
 *  fail-fast is the desired posture so a misconfigured deploy doesn't
 *  silently accept tokens it can't actually hash. */
export async function loadPepperFromKms(
  region: Region,
  env: NodeJS.ProcessEnv,
): Promise<Map<string, Buffer>> {
  const map = new Map<string, Buffer>();
  const kid = `v1-${region}`;
  const mode = env.MIDPLANE_KMS_MODE ?? "env";
  if (mode === "env") {
    const varName = `MIDPLANE_TOKEN_PEPPER_${region.toUpperCase()}_V1`;
    const raw = env[varName];
    if (!raw) {
      throw new Error(
        `${varName} is not set (required for token pepper in region '${region}')`,
      );
    }
    const buf = Buffer.from(raw, "base64");
    if (buf.length !== PEPPER_LEN) {
      throw new Error(
        `${varName} must decode to ${PEPPER_LEN} bytes (got ${buf.length})`,
      );
    }
    map.set(kid, buf);
    return map;
  }
  if (mode === "kms") {
    const arnVar = `MIDPLANE_KMS_KEY_${region.toUpperCase()}`;
    const arn = env[arnVar];
    if (!arn) {
      throw new Error(
        `${arnVar} is not set (required for kms-mode pepper in region '${region}')`,
      );
    }
    const ctVar = `MIDPLANE_TOKEN_PEPPER_CT_${region.toUpperCase()}_V1`;
    const raw = env[ctVar];
    if (!raw) {
      throw new Error(
        `${ctVar} is not set (required for kms-mode pepper in region '${region}')`,
      );
    }
    const ciphertext = Buffer.from(raw, "base64");
    const pepper = await decryptPepperKms(ciphertext, arn, region);
    if (pepper.length !== PEPPER_LEN) {
      throw new Error(
        `${ctVar} decrypted to ${pepper.length} bytes (expected ${PEPPER_LEN})`,
      );
    }
    map.set(kid, pepper);
    return map;
  }
  throw new Error(
    `MIDPLANE_KMS_MODE must be 'env' or 'kms' (got '${mode}')`,
  );
}

/** HMAC-SHA256(pepper, plaintext) → 32-byte digest. Suitable for the
 *  `mcp_tokens.token_hash` bytea column. */
export function hashToken(pepper: Buffer, plaintext: string): Buffer {
  if (pepper.length !== PEPPER_LEN) {
    throw new Error(`pepper must be ${PEPPER_LEN} bytes (got ${pepper.length})`);
  }
  return createHmac("sha256", pepper).update(plaintext, "utf8").digest();
}

/** Constant-time comparison of HMAC(plaintext) vs expected.
 *  `timingSafeEqual` short-circuits on a length mismatch — we re-hash
 *  first so both inputs are always 32 bytes and the comparison itself
 *  is fixed-time. */
export function verifyTokenHash(
  pepper: Buffer,
  plaintext: string,
  expectedHash: Buffer,
): boolean {
  if (expectedHash.length !== PEPPER_LEN) return false;
  const actual = hashToken(pepper, plaintext);
  return timingSafeEqual(actual, expectedHash);
}
