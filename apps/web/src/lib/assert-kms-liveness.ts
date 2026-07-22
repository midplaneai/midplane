// Boot-time KMS liveness check.
//
// assertBootEnv() only checks that the KMS *env vars are present* — not that
// the credentials, IAM policy, and CMK actually WORK. A present-but-invalid AWS
// access key (or an IAM policy whose Resource is the alias ARN instead of the
// key ARN) passes boot and then 500s EVERY createProject and DSN decrypt at
// runtime. That exact failure shipped once — the US region booted green with an
// invalid AWS key and threw `UnrecognizedClientException` on every add-database,
// invisible until a user tried to connect.
//
// This does one real encrypt-then-decrypt through the same code path production
// uses (makeKmsContext -> encryptDsn -> GenerateDataKey, then decryptDsn ->
// Decrypt; or the local AES key in env-mode) for the process's pinned region.
// Both actions are exercised on purpose: kms:GenerateDataKey and kms:Decrypt are
// DISTINCT IAM grants, so a policy that allows one but omits the other would
// boot green and 500 only on the missing path (encrypt fails add-database;
// decrypt fails every agent query that reads an existing DSN). If either fails,
// the process can't custody customer credentials — so we refuse to boot and fail
// the deploy, rather than serve a region that 500s at runtime.
//
// nodejs-only (AWS SDK + node:crypto): the caller (instrumentation.ts) guards on
// NEXT_RUNTIME and imports this dynamically so it never enters the Edge bundle.

import {
  decryptDsn,
  encryptDsn,
  makeKmsContext,
  type Region,
} from "@midplane-cloud/kms";

// Throwaway (customerId, region, plaintext) — used only as the encrypt AAD /
// KMS EncryptionContext and round-trip probe. Nothing is persisted. region
// matches the pinned region so the call satisfies a per-region
// `kms:EncryptionContext:region` policy condition (the CMKs have one).
const SMOKE_CUSTOMER_ID = "boot-smoke";
const SMOKE_PLAINTEXT = "boot-smoke";
const MAX_ATTEMPTS = 3;

// Loose env shape (mirrors assert-boot-env's EnvLike) so callers and tests can
// pass a partial object without Next's ProcessEnv NODE_ENV requirement.
type EnvLike = Record<string, string | undefined>;

// Injectable KMS ops — lets a unit test exercise the "Decrypt denied but
// GenerateDataKey allowed" case that env-mode (one symmetric key) can't model.
// Mirrors the router's DsnResolver deps pattern (decrypt.ts).
export interface KmsLivenessDeps {
  encrypt?: typeof encryptDsn;
  decrypt?: typeof decryptDsn;
}

export async function assertKmsLiveness(
  region: Region,
  env: EnvLike = process.env,
  deps: KmsLivenessDeps = {},
): Promise<void> {
  const ctx = makeKmsContext(env as NodeJS.ProcessEnv);
  const encrypt = deps.encrypt ?? encryptDsn;
  const decrypt = deps.decrypt ?? decryptDsn;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Encrypt (kms:GenerateDataKey) AND decrypt (kms:Decrypt) — both runtime
      // paths, both distinct IAM grants. Decrypt with the kmsKeyId the encrypt
      // returned, exactly as the router does when reading a stored DSN.
      const { ciphertext, kmsKeyId } = await encrypt(
        ctx,
        SMOKE_PLAINTEXT,
        SMOKE_CUSTOMER_ID,
        region,
      );
      const roundTrip = await decrypt(
        ctx,
        ciphertext,
        SMOKE_CUSTOMER_ID,
        region,
        kmsKeyId,
      );
      if (roundTrip !== SMOKE_PLAINTEXT) {
        throw new Error(
          "KMS encrypt/decrypt round-trip returned a mismatched plaintext",
        );
      }
      return; // creds + CMK + IAM grants work for BOTH encrypt and decrypt
    } catch (err) {
      lastErr = err;
      // env-mode failures (a malformed dev key) are deterministic — retrying
      // wouldn't help. kms-mode failures may be a transient AWS/network blip,
      // so back off and retry a couple times before failing the boot.
      if (ctx.mode !== "kms" || attempt === MAX_ATTEMPTS) break;
      await sleep(250 * attempt);
    }
  }
  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `Boot-time KMS liveness check failed for region '${region}': ${reason}\n` +
      `The app encrypts and decrypts customer DSNs through KMS — it cannot run if KMS ` +
      `is unusable, so it is refusing to boot rather than 500 every request.\n` +
      `In kms-mode this is usually invalid AWS credentials, or an IAM policy that does ` +
      `not grant BOTH kms:GenerateDataKey and kms:Decrypt on the region CMK (the policy ` +
      `Resource must be the KEY ARN, not an alias ARN). In env-mode it usually means ` +
      `MIDPLANE_KMS_DEV_KEY_${region.toUpperCase()} is not a 32-byte hex value.`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
