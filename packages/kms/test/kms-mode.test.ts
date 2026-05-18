// Wire-version disambiguation between env-mode (0x01) and kms-mode (0x02).
// These checks run before the AWS SDK call inside decryptKms, so they are
// fully exercisable without AWS credentials. The live round-trip against a
// real CMK lives in kms-mode.live.e2e.test.ts.

import { describe, expect, it } from "vitest";

import { decryptDsn, encryptDsn, makeKmsContext } from "../src/index.ts";
import { decryptKms } from "../src/kms-mode.ts";

const FAKE_ARN =
  "arn:aws:kms:eu-central-1:000000000000:key/00000000-0000-0000-0000-000000000000";

describe("wire-version disambiguation", () => {
  it("decryptKms refuses env-mode ciphertext (version 0x01)", async () => {
    // Produce a real env-mode ciphertext, then feed it to decryptKms.
    const envCtx = makeKmsContext({
      MIDPLANE_KMS_MODE: "env",
      MIDPLANE_KMS_DEV_KEY_EU: "a".repeat(64),
    } as NodeJS.ProcessEnv);
    const { ciphertext } = await encryptDsn(envCtx, "x", "c", "eu");
    expect(ciphertext[0]).toBe(0x01);
    await expect(decryptKms(ciphertext, FAKE_ARN, "c", "eu")).rejects.toThrow(
      /env-mode/,
    );
  });

  it("decryptKms rejects unknown wire versions", async () => {
    const wire = Buffer.from([0x99, 0x00, 0x00]);
    await expect(decryptKms(wire, FAKE_ARN, "c", "eu")).rejects.toThrow(
      /unsupported wire version/,
    );
  });

  it("decryptDsn routes env: keyIds to env-mode and rejects kms-mode bytes there", async () => {
    // A 0x02-prefixed buffer routed through the env-mode decrypt path must
    // fail at the version check, not silently AES-GCM-fail in a confusing way.
    const envCtx = makeKmsContext({
      MIDPLANE_KMS_MODE: "env",
      MIDPLANE_KMS_DEV_KEY_EU: "a".repeat(64),
    } as NodeJS.ProcessEnv);
    const fakeKmsWire = Buffer.concat([
      Buffer.from([0x02]),
      Buffer.alloc(64), // garbage payload; the version check fires first
    ]);
    await expect(
      decryptDsn(envCtx, fakeKmsWire, "c", "eu", "env:eu"),
    ).rejects.toThrow(/unsupported wire version/);
  });
});
