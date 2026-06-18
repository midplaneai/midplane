import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadOrCreateInstallId, resolveInstallIdPath } from "../../src/telemetry/install-id.ts";
import { InstallId } from "../../src/telemetry/schema.ts";

function freshTmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "midplane-tel-"));
  return join(dir, "audit.db");
}

describe("install-id", () => {
  test("missing → generates ULID and persists", () => {
    const dbPath = freshTmpDb();
    const result = loadOrCreateInstallId(dbPath);

    expect(result.generated).toBe(true);
    expect(InstallId.safeParse(result.id).success).toBe(true);
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path, "utf8").trim()).toBe(result.id);
  });

  test("existing valid file → reads it back", () => {
    const dbPath = freshTmpDb();
    const path = resolveInstallIdPath(dbPath);
    const id = "01H8K2J9XQVWZ7PCQ3F0R2N5T8";
    writeFileSync(path, `${id}\n`, "utf8");

    const result = loadOrCreateInstallId(dbPath);
    expect(result.generated).toBe(false);
    expect(result.id).toBe(id);
  });

  test("corrupt file → regenerates", () => {
    const dbPath = freshTmpDb();
    const path = resolveInstallIdPath(dbPath);
    writeFileSync(path, "not-a-ulid", "utf8");

    const result = loadOrCreateInstallId(dbPath);
    expect(result.generated).toBe(true);
    expect(InstallId.safeParse(result.id).success).toBe(true);
    expect(readFileSync(path, "utf8").trim()).toBe(result.id);
  });

  test("install-id sits next to the audit DB", () => {
    const dbPath = "/tmp/midplane-fixed/audit.db";
    expect(resolveInstallIdPath(dbPath)).toBe("/tmp/midplane-fixed/install-id");
  });
});
