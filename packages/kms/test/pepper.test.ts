import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  hashToken,
  loadPepperFromKms,
  verifyTokenHash,
} from "../src/pepper.ts";

function envWith(pepperEu?: string, pepperUs?: string) {
  return {
    MIDPLANE_KMS_MODE: "env",
    ...(pepperEu === undefined ? {} : { MIDPLANE_TOKEN_PEPPER_EU_V1: pepperEu }),
    ...(pepperUs === undefined ? {} : { MIDPLANE_TOKEN_PEPPER_US_V1: pepperUs }),
  } as NodeJS.ProcessEnv;
}

const PEPPER_EU = randomBytes(32).toString("base64");
const PEPPER_US = randomBytes(32).toString("base64");

describe("loadPepperFromKms (env mode)", () => {
  it("returns a v1-<region> kid → 32-byte buffer map for a configured region", async () => {
    const map = await loadPepperFromKms("eu", envWith(PEPPER_EU));
    expect([...map.keys()]).toEqual(["v1-eu"]);
    expect(map.get("v1-eu")?.length).toBe(32);
  });

  it("isolates regions — eu load does not return us material", async () => {
    const map = await loadPepperFromKms("eu", envWith(PEPPER_EU, PEPPER_US));
    expect(map.has("v1-us")).toBe(false);
    expect(map.get("v1-eu")?.equals(Buffer.from(PEPPER_EU, "base64"))).toBe(
      true,
    );
  });

  it("throws when the region's pepper env var is missing", async () => {
    await expect(loadPepperFromKms("eu", envWith())).rejects.toThrow(
      /MIDPLANE_TOKEN_PEPPER_EU_V1/,
    );
  });

  it("throws when the env value decodes to the wrong length", async () => {
    const short = Buffer.alloc(16).toString("base64");
    await expect(loadPepperFromKms("eu", envWith(short))).rejects.toThrow(
      /32 bytes/,
    );
  });

  it("throws for unsupported MIDPLANE_KMS_MODE", async () => {
    await expect(
      loadPepperFromKms("eu", {
        MIDPLANE_KMS_MODE: "vault",
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/MIDPLANE_KMS_MODE/);
  });

});

describe("loadPepperFromKms (kms mode, pre-AWS validation)", () => {
  // The live round-trip against a real CMK lives in
  // kms-mode.live.e2e.test.ts. These assertions all fire before any AWS
  // call, so they run without credentials.
  it("throws when the region's CMK ARN env var is missing", async () => {
    await expect(
      loadPepperFromKms("eu", {
        MIDPLANE_KMS_MODE: "kms",
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/MIDPLANE_KMS_KEY_EU/);
  });

  it("throws when the wrapped-pepper env var is missing", async () => {
    await expect(
      loadPepperFromKms("eu", {
        MIDPLANE_KMS_MODE: "kms",
        MIDPLANE_KMS_KEY_EU: "arn:aws:kms:eu-central-1:0:key/x",
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/MIDPLANE_TOKEN_PEPPER_CT_EU_V1/);
  });

});

describe("hashToken", () => {
  it("is deterministic for the same (pepper, plaintext)", () => {
    const pepper = randomBytes(32);
    const a = hashToken(pepper, "mp_test_abcdef0123456789abcdef0123456789_AAAAAA");
    const b = hashToken(pepper, "mp_test_abcdef0123456789abcdef0123456789_AAAAAA");
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
  });

  it("yields different output for different peppers (resistance to leaked DB)", () => {
    const pepperA = randomBytes(32);
    const pepperB = randomBytes(32);
    const plaintext = "mp_test_abcdef0123456789abcdef0123456789_AAAAAA";
    expect(hashToken(pepperA, plaintext).equals(hashToken(pepperB, plaintext))).toBe(
      false,
    );
  });

  it("yields different output for different plaintexts under the same pepper", () => {
    const pepper = randomBytes(32);
    const a = hashToken(pepper, "mp_test_0000000000000000000000000000000a_AAAAAA");
    const b = hashToken(pepper, "mp_test_0000000000000000000000000000000b_AAAAAA");
    expect(a.equals(b)).toBe(false);
  });

  it("throws on wrong pepper length (boot-time sanity)", () => {
    expect(() => hashToken(Buffer.alloc(16), "x")).toThrow(/32 bytes/);
  });
});

describe("verifyTokenHash", () => {
  it("returns true for a matching (pepper, plaintext, hash) triple", () => {
    const pepper = randomBytes(32);
    const plaintext = "mp_test_aaaabbbbccccddddeeeeffff00001111_ZZZZZZ";
    const hash = hashToken(pepper, plaintext);
    expect(verifyTokenHash(pepper, plaintext, hash)).toBe(true);
  });

  it("returns false when a single bit of the expected hash is flipped", () => {
    const pepper = randomBytes(32);
    const plaintext = "mp_test_aaaabbbbccccddddeeeeffff00001111_ZZZZZZ";
    const hash = hashToken(pepper, plaintext);
    const flipped = Buffer.from(hash);
    flipped[0] = flipped[0]! ^ 0x01;
    expect(verifyTokenHash(pepper, plaintext, flipped)).toBe(false);
  });

  it("returns false for hashes of the wrong length (no early-exit on equal-length compare)", () => {
    const pepper = randomBytes(32);
    expect(verifyTokenHash(pepper, "x", Buffer.alloc(16))).toBe(false);
    expect(verifyTokenHash(pepper, "x", Buffer.alloc(33))).toBe(false);
  });

  it("returns false when the pepper used to verify differs from the one used to hash", () => {
    const pepperA = randomBytes(32);
    const pepperB = randomBytes(32);
    const plaintext = "mp_test_aaaabbbbccccddddeeeeffff00001111_ZZZZZZ";
    const hash = hashToken(pepperA, plaintext);
    expect(verifyTokenHash(pepperB, plaintext, hash)).toBe(false);
  });
});
