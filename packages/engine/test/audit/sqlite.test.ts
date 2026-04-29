// SqliteAuditWriter tests.
//
// Append-only invariant; concurrent reads while a writer commits;
// schema_version round-trip; payload validation rejects bad events.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SqliteAuditWriter } from "../../src/audit/sqlite.ts";
import { AuditUnavailableError } from "../../src/errors.ts";
import type { AuditEvent } from "../../src/audit/types.ts";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "midplane-sqlite-test-"));
  dbPath = join(dir, "audit.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function attempted(id: string, queryId: string, ts: number): AuditEvent {
  return {
    id,
    query_id: queryId,
    tenant_id: "42",
    agent_identity: "tok-1",
    ts,
    schema_version: 1,
    event_type: "ATTEMPTED",
    payload: {
      sql_raw: "SELECT 1",
      sql_fingerprint: "0123456789abcdef",
    },
  };
}

describe("SqliteAuditWriter — schema + basic write", () => {
  test("creates table on first construction", async () => {
    const w = new SqliteAuditWriter(dbPath);
    await w.write(attempted("01TESTID000000000000000001", "Q1", 1_700_000_000_000));
    expect(w._count()).toBe(1);
    await w.close();
  });

  test("schema_version round-trips as integer 1", async () => {
    const w = new SqliteAuditWriter(dbPath);
    await w.write(attempted("01TESTID000000000000000002", "Q1", 1_700_000_000_000));
    const rows = w._readAll() as Array<{ schema_version: number }>;
    expect(rows[0]!.schema_version).toBe(1);
    await w.close();
  });

  test("payload round-trips as JSON", async () => {
    const w = new SqliteAuditWriter(dbPath);
    await w.write(attempted("01TESTID000000000000000003", "Q1", 1_700_000_000_000));
    const rows = w._readAll() as Array<{ payload: string }>;
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      sql_raw: "SELECT 1",
      sql_fingerprint: "0123456789abcdef",
    });
    await w.close();
  });
});

describe("SqliteAuditWriter — append-only invariant", () => {
  test("inserting two events with same id throws (PK collision)", async () => {
    const w = new SqliteAuditWriter(dbPath);
    await w.write(attempted("01TESTID000000000000DUPE01", "Q1", 1_700_000_000_000));
    await expect(
      w.write(attempted("01TESTID000000000000DUPE01", "Q1", 1_700_000_000_001)),
    ).rejects.toBeInstanceOf(AuditUnavailableError);
    await w.close();
  });

  test("multiple distinct events all retained", async () => {
    const w = new SqliteAuditWriter(dbPath);
    for (let i = 0; i < 50; i++) {
      await w.write(
        attempted(`01TESTID0000000000000000${String(i).padStart(2, "0")}`, "Q1", 1_700_000_000_000 + i),
      );
    }
    expect(w._count()).toBe(50);
    await w.close();
  });
});

describe("SqliteAuditWriter — concurrent reads while writer commits (WAL)", () => {
  test("reader sees stable view while writer commits", async () => {
    const w = new SqliteAuditWriter(dbPath);
    await w.write(attempted("01TESTID000000000000READ01", "Q1", 1_700_000_000_000));

    // Open an independent reader on the same db.
    const reader = new Database(dbPath, { readonly: true });
    const readBefore = (reader.query("SELECT COUNT(*) AS c FROM audit_events").get() as { c: number }).c;

    // Writer adds more events.
    for (let i = 0; i < 10; i++) {
      await w.write(
        attempted(
          `01TESTID000000000000READ${String(i + 10).padStart(2, "0")}`,
          "Q1",
          1_700_000_000_001 + i,
        ),
      );
    }

    const readAfter = (reader.query("SELECT COUNT(*) AS c FROM audit_events").get() as { c: number }).c;
    reader.close();

    expect(readBefore).toBe(1);
    expect(readAfter).toBe(11);
    await w.close();
  });

  test("WAL mode is set on opened db", async () => {
    const w = new SqliteAuditWriter(dbPath);
    await w.write(attempted("01TESTID000000000000WAL001", "Q1", 1_700_000_000_000));
    await w.close();

    // Re-open and check pragma.
    const probe = new Database(dbPath);
    const mode = (probe.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    probe.close();
    expect(mode.toLowerCase()).toBe("wal");
  });
});

describe("SqliteAuditWriter — payload validation", () => {
  test("invalid event_type rejected before insert", async () => {
    const w = new SqliteAuditWriter(dbPath);
    const bad = {
      id: "01TESTID000000000000BADD01",
      query_id: "Q1",
      tenant_id: "42",
      agent_identity: null,
      ts: 1_700_000_000_000,
      schema_version: 1 as const,
      event_type: "BANANA" as never,
      payload: { sql_raw: "x", sql_fingerprint: "0123456789abcdef" },
    };
    await expect(w.write(bad as never)).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(w._count()).toBe(0);
    await w.close();
  });

  test("invalid fingerprint format rejected", async () => {
    const w = new SqliteAuditWriter(dbPath);
    const bad: AuditEvent = {
      id: "01TESTID000000000000BADFP1",
      query_id: "Q1",
      tenant_id: "42",
      agent_identity: null,
      ts: 1_700_000_000_000,
      schema_version: 1,
      event_type: "ATTEMPTED",
      payload: { sql_raw: "x", sql_fingerprint: "not-hex" },
    };
    await expect(w.write(bad)).rejects.toBeInstanceOf(AuditUnavailableError);
    await w.close();
  });
});
