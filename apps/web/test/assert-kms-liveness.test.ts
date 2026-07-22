// Boot-time KMS liveness check: it must actually EXERCISE the encrypt path, not
// just check env presence (that's assertBootEnv's job). We prove that with
// env-mode, which is pure local AES — no AWS, deterministic — so the test
// covers the real makeKmsContext -> encryptDsn code path a kms-mode deploy runs,
// minus the network. A working encrypt returns; a broken key throws with a
// region-tagged, actionable message.

import { describe, expect, it } from "vitest";

import { assertKmsLiveness } from "../src/lib/assert-kms-liveness.ts";

// 32-byte key = 64 hex chars (env-mode requires exactly 32 bytes).
const VALID_HEX_KEY = "a".repeat(64);

describe("assertKmsLiveness (env-mode)", () => {
  it("resolves when the region's dev key can encrypt", async () => {
    await expect(
      assertKmsLiveness("eu", {
        MIDPLANE_KMS_MODE: "env",
        MIDPLANE_KMS_DEV_KEY_EU: VALID_HEX_KEY,
      }),
    ).resolves.toBeUndefined();
  });

  it("checks the PINNED region, not just any key (us)", async () => {
    await expect(
      assertKmsLiveness("us", {
        MIDPLANE_KMS_MODE: "env",
        MIDPLANE_KMS_DEV_KEY_US: VALID_HEX_KEY,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects with a region-tagged message when the dev key is missing", async () => {
    await expect(
      assertKmsLiveness("us", {
        MIDPLANE_KMS_MODE: "env",
        MIDPLANE_KMS_DEV_KEY_EU: VALID_HEX_KEY, // wrong region on purpose
      }),
    ).rejects.toThrow(/KMS liveness check failed for region 'us'/);
  });

  it("rejects when the dev key is present but malformed (not 32 bytes)", async () => {
    await expect(
      assertKmsLiveness("eu", {
        MIDPLANE_KMS_MODE: "env",
        MIDPLANE_KMS_DEV_KEY_EU: "deadbeef", // 4 bytes, too short
      }),
    ).rejects.toThrow(/liveness check failed/);
  });

  // The check must exercise kms:Decrypt too, not just kms:GenerateDataKey — a
  // policy that grants encrypt but omits decrypt would boot green and then 500
  // every agent query that reads an existing DSN. env-mode uses one symmetric
  // key for both, so we inject a decrypt that fails while encrypt succeeds.
  it("rejects when Decrypt is denied even though encrypt succeeds", async () => {
    const env = {
      MIDPLANE_KMS_MODE: "env",
      MIDPLANE_KMS_DEV_KEY_EU: VALID_HEX_KEY,
    };
    // Sanity: the same env passes when decrypt is allowed (default deps).
    await expect(assertKmsLiveness("eu", env)).resolves.toBeUndefined();
    // ...and fails when only decrypt is denied.
    await expect(
      assertKmsLiveness("eu", env, {
        decrypt: async () => {
          throw new Error(
            "AccessDeniedException: not authorized to perform kms:Decrypt",
          );
        },
      }),
    ).rejects.toThrow(/liveness check failed for region 'eu'/);
  });
});
