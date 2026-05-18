import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decryptDsn, encryptDsn, makeKmsContext } from "../src/index.ts";

const EU_KEY = randomBytes(32).toString("hex");
const US_KEY = randomBytes(32).toString("hex");

function ctx(env: Record<string, string | undefined> = {}) {
  return makeKmsContext({
    MIDPLANE_KMS_MODE: "env",
    MIDPLANE_KMS_DEV_KEY_EU: EU_KEY,
    MIDPLANE_KMS_DEV_KEY_US: US_KEY,
    ...env,
  } as NodeJS.ProcessEnv);
}

describe("env-mode KMS round-trip", () => {
  it("encrypts and decrypts a DSN", async () => {
    const dsn = "postgres://user:pass@host:5432/db?sslmode=require";
    const { ciphertext, kmsKeyId } = await encryptDsn(
      ctx(),
      dsn,
      "cust_01HX",
      "eu",
    );
    expect(kmsKeyId).toBe("env:eu");
    expect(ciphertext.length).toBeGreaterThan(dsn.length);

    const out = await decryptDsn(ctx(), ciphertext, "cust_01HX", "eu", kmsKeyId);
    expect(out).toBe(dsn);
  });

  it("rejects decrypt with wrong customer (AAD mismatch)", async () => {
    const { ciphertext, kmsKeyId } = await encryptDsn(
      ctx(),
      "postgres://x",
      "cust_A",
      "eu",
    );
    await expect(
      decryptDsn(ctx(), ciphertext, "cust_B", "eu", kmsKeyId),
    ).rejects.toThrow();
  });

  it("rejects decrypt with wrong region (AAD mismatch + key mismatch)", async () => {
    const { ciphertext, kmsKeyId } = await encryptDsn(
      ctx(),
      "postgres://x",
      "cust_A",
      "eu",
    );
    // Forcing the kmsKeyId to env:us uses the us key + us AAD.
    await expect(
      decryptDsn(ctx(), ciphertext, "cust_A", "us", "env:us"),
    ).rejects.toThrow();
  });

  it("ciphertext is non-deterministic (fresh nonce per encrypt)", async () => {
    const a = await encryptDsn(ctx(), "x", "c", "eu");
    const b = await encryptDsn(ctx(), "x", "c", "eu");
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("rejects malformed wire bytes", async () => {
    await expect(
      decryptDsn(ctx(), Buffer.from([0x99]), "c", "eu", "env:eu"),
    ).rejects.toThrow();
  });

  it("requires per-region key when encrypting in that region", async () => {
    const onlyEu = makeKmsContext({
      MIDPLANE_KMS_MODE: "env",
      MIDPLANE_KMS_DEV_KEY_EU: EU_KEY,
    } as NodeJS.ProcessEnv);
    await expect(encryptDsn(onlyEu, "x", "c", "us")).rejects.toThrow(
      /MIDPLANE_KMS_DEV_KEY_US/,
    );
  });
});
