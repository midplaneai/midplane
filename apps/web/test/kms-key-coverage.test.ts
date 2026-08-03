import { describe, expect, it } from "vitest";

import {
  findStrandedKeyIds,
  findUnprobedCmks,
  requiredEnvVar,
} from "@/lib/assert-kms-key-coverage";

// Guards the trap that stranded three EU rows for ten days: decryptDsn
// dispatches on the STORED project_databases.kms_key_id, NOT on
// MIDPLANE_KMS_MODE. So a region running kms-mode still needs the env-mode dev
// key for any row written before the switch — and the boot-time KMS liveness
// probe can't see it, because it round-trips a fresh encrypt.

const CMK_ARN = "arn:aws:kms:eu-central-1:1:alias/midplane-prod-eu";

describe("requiredEnvVar", () => {
  it("maps an env: key id to the region's dev key, whatever the mode", () => {
    expect(requiredEnvVar("env:eu", "eu")).toBe("MIDPLANE_KMS_DEV_KEY_EU");
    expect(requiredEnvVar("env:us", "us")).toBe("MIDPLANE_KMS_DEV_KEY_US");
  });

  // decryptDsn hands decryptKms the row's OWN stored arn and never reads
  // MIDPLANE_KMS_KEY_<REGION> — that var is encrypt-side only. Claiming a CMK
  // row "requires" it would flag healthy rows as stranded.
  it("requires no env var for a CMK arn (decrypt never reads the CMK var)", () => {
    expect(requiredEnvVar(CMK_ARN, "eu")).toBeNull();
  });

  // The dispatch is prefix-based, so the var is chosen by the STORED id's shape
  // — a row's own region suffix never overrides the process's region.
  it("keys off the process region, not the string inside the key id", () => {
    expect(requiredEnvVar("env:us", "eu")).toBe("MIDPLANE_KMS_DEV_KEY_EU");
  });
});

describe("findStrandedKeyIds", () => {
  it("flags env-mode rows when the dev key is gone (the EU regression)", () => {
    const stranded = findStrandedKeyIds(
      [
        { kmsKeyId: "env:eu", rows: 3 },
        { kmsKeyId: CMK_ARN, rows: 3 },
      ],
      "eu",
      { MIDPLANE_KMS_MODE: "kms", MIDPLANE_KMS_KEY_EU: CMK_ARN },
    );
    expect(stranded).toEqual([
      { kmsKeyId: "env:eu", rows: 3, missingEnvVar: "MIDPLANE_KMS_DEV_KEY_EU" },
    ]);
  });

  it("passes when both key sources are configured", () => {
    expect(
      findStrandedKeyIds(
        [
          { kmsKeyId: "env:eu", rows: 3 },
          { kmsKeyId: CMK_ARN, rows: 3 },
        ],
        "eu",
        {
          MIDPLANE_KMS_MODE: "kms",
          MIDPLANE_KMS_KEY_EU: CMK_ARN,
          MIDPLANE_KMS_DEV_KEY_EU: "a".repeat(64),
        },
      ),
    ).toEqual([]);
  });

  // kms-mode being ON is exactly the state that lulled the liveness probe into
  // passing, so the check must not treat it as evidence of anything.
  it("does not let kms-mode excuse a missing dev key", () => {
    const stranded = findStrandedKeyIds([{ kmsKeyId: "env:eu", rows: 1 }], "eu", {
      MIDPLANE_KMS_MODE: "kms",
      MIDPLANE_KMS_KEY_EU: CMK_ARN,
    });
    expect(stranded).toHaveLength(1);
  });

  // The false positive this check must never produce: CMK rows decrypt via the
  // stored arn, so an unset MIDPLANE_KMS_KEY_<REGION> says nothing about them.
  // Flagging these would page an operator over perfectly healthy rows.
  it("never flags a CMK row, even with every KMS env var unset", () => {
    expect(findStrandedKeyIds([{ kmsKeyId: CMK_ARN, rows: 6 }], "eu", {})).toEqual(
      [],
    );
  });

  it("treats an empty env var as unset (a blanked secret still strands rows)", () => {
    const stranded = findStrandedKeyIds([{ kmsKeyId: "env:eu", rows: 1 }], "eu", {
      MIDPLANE_KMS_DEV_KEY_EU: "",
    });
    expect(stranded).toHaveLength(1);
  });

  it("reports nothing for a region with no rows", () => {
    expect(findStrandedKeyIds([], "eu", {})).toEqual([]);
  });
});

describe("findUnprobedCmks", () => {
  const OLD_CMK = "arn:aws:kms:eu-central-1:1:alias/midplane-prod-eu-old";

  // assertKmsLiveness only round-trips the CONFIGURED CMK, so rows on a
  // previous key have an unverified kms:Decrypt grant. Informational — the
  // grant is often fine, and boot won't decrypt customer data to find out.
  it("reports rows on a CMK the liveness probe doesn't exercise", () => {
    expect(
      findUnprobedCmks(
        [
          { kmsKeyId: CMK_ARN, rows: 5 },
          { kmsKeyId: OLD_CMK, rows: 2 },
        ],
        CMK_ARN,
      ),
    ).toEqual([{ kmsKeyId: OLD_CMK, rows: 2 }]);
  });

  it("stays quiet when every CMK row is on the configured key", () => {
    expect(findUnprobedCmks([{ kmsKeyId: CMK_ARN, rows: 5 }], CMK_ARN)).toEqual(
      [],
    );
  });

  it("ignores env-mode rows (findStrandedKeyIds owns those)", () => {
    expect(findUnprobedCmks([{ kmsKeyId: "env:eu", rows: 3 }], CMK_ARN)).toEqual(
      [],
    );
  });
});
