import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decryptDsn, encryptDsn, makeKmsContext } from "../src/index.ts";

const FRA_KEY = randomBytes(32).toString("hex");
const IAD_KEY = randomBytes(32).toString("hex");

function ctx(env: Record<string, string | undefined> = {}) {
  return makeKmsContext({
    MIDPLANE_KMS_MODE: "env",
    MIDPLANE_KMS_DEV_KEY_FRA: FRA_KEY,
    MIDPLANE_KMS_DEV_KEY_IAD: IAD_KEY,
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
      "fra",
    );
    expect(kmsKeyId).toBe("env:fra");
    expect(ciphertext.length).toBeGreaterThan(dsn.length);

    const out = await decryptDsn(ctx(), ciphertext, "cust_01HX", "fra", kmsKeyId);
    expect(out).toBe(dsn);
  });

  it("rejects decrypt with wrong customer (AAD mismatch)", async () => {
    const { ciphertext, kmsKeyId } = await encryptDsn(
      ctx(),
      "postgres://x",
      "cust_A",
      "fra",
    );
    await expect(
      decryptDsn(ctx(), ciphertext, "cust_B", "fra", kmsKeyId),
    ).rejects.toThrow();
  });

  it("rejects decrypt with wrong region (AAD mismatch + key mismatch)", async () => {
    const { ciphertext, kmsKeyId } = await encryptDsn(
      ctx(),
      "postgres://x",
      "cust_A",
      "fra",
    );
    // Forcing the kmsKeyId to env:iad uses the iad key + iad AAD.
    await expect(
      decryptDsn(ctx(), ciphertext, "cust_A", "iad", "env:iad"),
    ).rejects.toThrow();
  });

  it("ciphertext is non-deterministic (fresh nonce per encrypt)", async () => {
    const a = await encryptDsn(ctx(), "x", "c", "fra");
    const b = await encryptDsn(ctx(), "x", "c", "fra");
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("rejects malformed wire bytes", async () => {
    await expect(
      decryptDsn(ctx(), Buffer.from([0x99]), "c", "fra", "env:fra"),
    ).rejects.toThrow();
  });

  it("requires per-region key when encrypting in that region", async () => {
    const onlyFra = makeKmsContext({
      MIDPLANE_KMS_MODE: "env",
      MIDPLANE_KMS_DEV_KEY_FRA: FRA_KEY,
    } as NodeJS.ProcessEnv);
    await expect(encryptDsn(onlyFra, "x", "c", "iad")).rejects.toThrow(
      /MIDPLANE_KMS_DEV_KEY_IAD/,
    );
  });
});
