import { beforeEach, describe, expect, it, vi } from "vitest";

// The boot-side wrapper: query stored key ids, then report. Covers the three
// outcomes the operator actually sees at boot, plus the deliberate non-fatal
// posture — assertKmsLiveness THROWS on failure because it means the whole
// region is down; a stranded row means only SOME customers are down, so
// refusing to boot would take the healthy ones down too AND block the deploy
// carrying the fix.

const rowsMock = vi.fn();
const captureErrorMock = vi.fn();

vi.mock("@midplane-cloud/db", () => ({
  projectDatabases: { kmsKeyId: "kms_key_id", projectId: "project_id" },
  projects: { id: "id", region: "region" },
  getDb: () => ({
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            groupBy: () => rowsMock(),
          }),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/analytics", () => ({
  get captureError() {
    return captureErrorMock;
  },
}));

const CMK = "arn:aws:kms:eu-central-1:1:alias/midplane-prod-eu";

describe("checkKmsKeyCoverage / reportKmsKeyCoverage", () => {
  beforeEach(() => {
    rowsMock.mockReset();
    captureErrorMock.mockReset();
    vi.restoreAllMocks();
  });

  it("reports the EU regression: env rows with the dev key dropped", async () => {
    rowsMock.mockResolvedValue([
      { kmsKeyId: "env:eu", rows: 3 },
      { kmsKeyId: CMK, rows: 3 },
    ]);
    const { checkKmsKeyCoverage } = await import("@/lib/assert-kms-key-coverage");
    const report = await checkKmsKeyCoverage("eu", {
      MIDPLANE_KMS_MODE: "kms",
      MIDPLANE_KMS_KEY_EU: CMK,
    });
    expect(report.checked).toBe(2);
    expect(report.stranded).toEqual([
      { kmsKeyId: "env:eu", rows: 3, missingEnvVar: "MIDPLANE_KMS_DEV_KEY_EU" },
    ]);
    expect(report.unprobedCmks).toEqual([]);
  });

  it("logs kms.key_coverage_stranded and captures when rows are stranded", async () => {
    rowsMock.mockResolvedValue([{ kmsKeyId: "env:eu", rows: 3 }]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { reportKmsKeyCoverage } = await import("@/lib/assert-kms-key-coverage");
    await reportKmsKeyCoverage("eu", { MIDPLANE_KMS_MODE: "kms" });

    const logged = JSON.parse(err.mock.calls[0]![0] as string);
    expect(logged.event).toBe("kms.key_coverage_stranded");
    expect(logged.affected_rows).toBe(3);
    expect(logged.level).toBe("error");
    // The console line alone is what failed last time — nobody was looking.
    expect(captureErrorMock).toHaveBeenCalledWith(
      "kms.key_coverage_stranded",
      expect.any(Error),
      expect.objectContaining({ properties: { region: "eu" } }),
    );
  });

  it("logs kms.key_coverage_ok when every key id is serveable", async () => {
    rowsMock.mockResolvedValue([{ kmsKeyId: CMK, rows: 6 }]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { reportKmsKeyCoverage } = await import("@/lib/assert-kms-key-coverage");
    await reportKmsKeyCoverage("eu", { MIDPLANE_KMS_KEY_EU: CMK });

    const logged = JSON.parse(log.mock.calls[0]![0] as string);
    expect(logged.event).toBe("kms.key_coverage_ok");
    expect(logged.distinct_key_ids).toBe(1);
    expect(logged.unprobed_cmks).toBeUndefined();
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  it("surfaces unprobed CMKs on the ok path without failing", async () => {
    const OLD = `${CMK}-old`;
    rowsMock.mockResolvedValue([
      { kmsKeyId: CMK, rows: 6 },
      { kmsKeyId: OLD, rows: 1 },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { reportKmsKeyCoverage } = await import("@/lib/assert-kms-key-coverage");
    await reportKmsKeyCoverage("eu", { MIDPLANE_KMS_KEY_EU: CMK });

    const logged = JSON.parse(log.mock.calls[0]![0] as string);
    expect(logged.event).toBe("kms.key_coverage_ok");
    expect(logged.unprobed_cmks).toEqual([{ kmsKeyId: OLD, rows: 1 }]);
    expect(captureErrorMock).not.toHaveBeenCalled();
  });

  // A DB blip at boot must not take the process down over a diagnostic.
  it("warns and continues when the query throws", async () => {
    rowsMock.mockRejectedValue(new Error("connection refused"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { reportKmsKeyCoverage } = await import("@/lib/assert-kms-key-coverage");
    await expect(
      reportKmsKeyCoverage("eu", { MIDPLANE_KMS_KEY_EU: CMK }),
    ).resolves.toBeUndefined();

    const logged = JSON.parse(warn.mock.calls[0]![0] as string);
    expect(logged.event).toBe("kms.key_coverage_check_failed");
    expect(logged.reason).toBe("connection refused");
  });
});
