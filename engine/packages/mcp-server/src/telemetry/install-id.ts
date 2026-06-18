// Install-ID persistence. Lifetime tracks the audit DB.
//
// File layout: ${dirname(dbPath)}/install-id (single line, the ULID).
// Generated on first read; persisted atomically (tmp + rename).
// A corrupt or malformed file is treated as missing and replaced.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ulid } from "ulid";
import { InstallId } from "./schema.ts";

export interface InstallIdResult {
  id: string;
  generated: boolean;       // true if we just generated it (used for first-run notice)
  path: string;
}

export function resolveInstallIdPath(dbPath: string): string {
  return join(dirname(dbPath), "install-id");
}

export function loadOrCreateInstallId(dbPath: string): InstallIdResult {
  const path = resolveInstallIdPath(dbPath);

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8").trim();
      const parsed = InstallId.safeParse(raw);
      if (parsed.success) {
        return { id: parsed.data, generated: false, path };
      }
      // Corrupt: fall through to regenerate.
    } catch {
      // Read error: fall through to regenerate.
    }
  }

  const id = ulid();
  persistAtomically(path, id);
  return { id, generated: true, path };
}

function persistAtomically(path: string, id: string): void {
  const dir = dirname(path);
  // Ensure the directory exists. With default DB_PATH=/data/audit.db the
  // /data dir is mounted by the user; we don't create system dirs.
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // If we can't create the dir, telemetry is best-effort and degrades to
      // an in-memory ULID for the lifetime of the process.
      return;
    }
  }
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, `${id}\n`, { encoding: "utf8", mode: 0o644 });
    renameSync(tmp, path);
  } catch {
    // Persistence failed; the in-memory ID is still useful for this process.
    // Future processes will regenerate (which is fine — telemetry is opt-out
    // capable, not consent-required).
  }
}
