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

import { randomBytes } from "node:crypto";

import { decryptDsn, encryptDsn, makeKmsContext } from "../src/index.ts";
import { decryptPepperKms, encryptPepperKms } from "../src/kms-mode.ts";
import { loadPepperFromKms } from "../src/pepper.ts";

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

  it("round-trips a token pepper through the EU CMK", async () => {
    const pepper = randomBytes(32);
    const cmk = process.env.MIDPLANE_KMS_KEY_EU!;
    const ciphertext = await encryptPepperKms(pepper, cmk, "eu");
    const out = await decryptPepperKms(ciphertext, cmk, "eu");
    expect(out.equals(pepper)).toBe(true);
  });

  it("loadPepperFromKms decrypts a wrapped pepper at boot", async () => {
    const pepper = randomBytes(32);
    const cmk = process.env.MIDPLANE_KMS_KEY_EU!;
    const ciphertext = await encryptPepperKms(pepper, cmk, "eu");
    const map = await loadPepperFromKms("eu", {
      MIDPLANE_KMS_MODE: "kms",
      MIDPLANE_KMS_KEY_EU: cmk,
      MIDPLANE_TOKEN_PEPPER_CT_EU_V1: ciphertext.toString("base64"),
    } as NodeJS.ProcessEnv);
    expect(map.get("v1-eu")?.equals(pepper)).toBe(true);
  });

  it.skipIf(!process.env.MIDPLANE_KMS_KEY_US)(
    "rejects an EU pepper ciphertext Decrypt-ed under the US CMK (EncryptionContext mismatch)",
    async () => {
      // EncryptionContext is `{region, purpose: "token-pepper"}`. Cross-region
      // replay is what we care about — the same CMK family in another region
      // must not unwrap an EU pepper.
      const pepper = randomBytes(32);
      const euCmk = process.env.MIDPLANE_KMS_KEY_EU!;
      const usCmk = process.env.MIDPLANE_KMS_KEY_US!;
      const wrapped = await encryptPepperKms(pepper, euCmk, "eu");
      await expect(decryptPepperKms(wrapped, usCmk, "us")).rejects.toThrow();
    },
  );
});
