// Live round-trip against a real AWS KMS CMK. Gated on:
//   - E2E_LIVE=1
//   - MIDPLANE_KMS_KEY_EU set to a CMK ARN (alias is fine) in eu-central-1
//   - AWS credentials in env (AWS_PROFILE / AWS_ACCESS_KEY_ID / etc.) with
//     kms:GenerateDataKey + kms:Decrypt on the key
//
// Mirrors env-mode.test.ts shape so the two modes drift in lockstep. This is
// the only test that exercises the AWS SDK path; everything else stubs at
// the version-byte check (see kms-mode.test.ts).
//
// Why also assert against US: if MIDPLANE_KMS_KEY_US is set we round-trip
// there too, so a partial deploy that only provisioned one region is caught
// before signups open in the other.

import { describe, expect, it } from "vitest";

import { decryptDsn, encryptDsn, makeKmsContext } from "../src/index.ts";

const LIVE =
  process.env.E2E_LIVE === "1" && Boolean(process.env.MIDPLANE_KMS_KEY_EU);

function liveCtx() {
  return makeKmsContext({
    MIDPLANE_KMS_MODE: "kms",
    MIDPLANE_KMS_KEY_EU: process.env.MIDPLANE_KMS_KEY_EU,
    MIDPLANE_KMS_KEY_US: process.env.MIDPLANE_KMS_KEY_US,
  } as NodeJS.ProcessEnv);
}

describe.skipIf(!LIVE)("kms-mode KMS round-trip (live)", () => {
  it("encrypts and decrypts a DSN with the EU CMK", async () => {
    const dsn = "postgres://user:pass@host:5432/db?sslmode=require";
    const { ciphertext, kmsKeyId } = await encryptDsn(
      liveCtx(),
      dsn,
      "cust_01HX",
      "eu",
    );
    expect(kmsKeyId).toMatch(/^arn:aws:kms:|^alias\//);
    expect(ciphertext[0]).toBe(0x02);
    expect(ciphertext.length).toBeGreaterThan(dsn.length);

    const out = await decryptDsn(
      liveCtx(),
      ciphertext,
      "cust_01HX",
      "eu",
      kmsKeyId,
    );
    expect(out).toBe(dsn);
  });

  it("ciphertext is non-deterministic (fresh data key per encrypt)", async () => {
    const a = await encryptDsn(liveCtx(), "x", "c", "eu");
    const b = await encryptDsn(liveCtx(), "x", "c", "eu");
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("rejects decrypt with wrong customer (EncryptionContext mismatch at KMS)", async () => {
    const { ciphertext, kmsKeyId } = await encryptDsn(
      liveCtx(),
      "postgres://x",
      "cust_A",
      "eu",
    );
    // KMS Decrypt fails closed when EncryptionContext doesn't match what was
    // passed to GenerateDataKey — this is the outer binding layer; the inner
    // AES-GCM AAD never even runs.
    await expect(
      decryptDsn(liveCtx(), ciphertext, "cust_B", "eu", kmsKeyId),
    ).rejects.toThrow();
  });

  it.skipIf(!process.env.MIDPLANE_KMS_KEY_US)(
    "encrypts and decrypts a DSN with the US CMK",
    async () => {
      const dsn = "postgres://user:pass@host:5432/db";
      const { ciphertext, kmsKeyId } = await encryptDsn(
        liveCtx(),
        dsn,
        "cust_01HX",
        "us",
      );
      expect(ciphertext[0]).toBe(0x02);
      const out = await decryptDsn(
        liveCtx(),
        ciphertext,
        "cust_01HX",
        "us",
        kmsKeyId,
      );
      expect(out).toBe(dsn);
    },
  );
});
