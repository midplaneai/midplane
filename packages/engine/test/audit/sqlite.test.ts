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
    database: "__default__",
    agent_name: "claude-code",
    agent_version: "0.42.1",
    agent_intent: null,
    intent_source: null,
    ts,
    schema_version: 2,
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

  test("schema_version round-trips as integer 2", async () => {
    const w = new SqliteAuditWriter(dbPath);
    await w.write(attempted("01TESTID000000000000000002", "Q1", 1_700_000_000_000));
    const rows = w._readAll() as Array<{ schema_version: number }>;
    expect(rows[0]!.schema_version).toBe(2);
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

describe("SqliteAuditWriter — readSince / deleteThrough", () => {
  test("readSince orders by id, not insert time", async () => {
    const w = new SqliteAuditWriter(dbPath);
    // Insert with descending ids but ascending ts to confirm ordering is by id.
    await w.write(attempted("01TESTID000000000000ORDR03", "Q1", 1_700_000_000_001));
    await w.write(attempted("01TESTID000000000000ORDR01", "Q1", 1_700_000_000_002));
    await w.write(attempted("01TESTID000000000000ORDR02", "Q1", 1_700_000_000_003));

    const rows = w.readSince("0", 100);
    expect(rows.map((r) => r.id)).toEqual([
      "01TESTID000000000000ORDR01",
      "01TESTID000000000000ORDR02",
      "01TESTID000000000000ORDR03",
    ]);
    await w.close();
  });

  test("readSince cursor is strictly greater than (not inclusive)", async () => {
    const w = new SqliteAuditWriter(dbPath);
    await w.write(attempted("01TESTID000000000000CURS01", "Q1", 1_700_000_000_001));
    await w.write(attempted("01TESTID000000000000CURS02", "Q1", 1_700_000_000_002));
    await w.write(attempted("01TESTID000000000000CURS03", "Q1", 1_700_000_000_003));

    // Cursor at the middle row → only the one strictly greater comes back.
    const rows = w.readSince("01TESTID000000000000CURS02", 100);
    expect(rows.map((r) => r.id)).toEqual(["01TESTID000000000000CURS03"]);
    await w.close();
  });

  test("readSince returns payload as parsed object, not JSON string", async () => {
    const w = new SqliteAuditWriter(dbPath);
    await w.write(attempted("01TESTID000000000000PARS01", "Q1", 1_700_000_000_000));
    const rows = w.readSince("0", 10);
    expect(rows[0]!.payload).toEqual({
      sql_raw: "SELECT 1",
      sql_fingerprint: "0123456789abcdef",
    });
    await w.close();
  });

  test("readSince respects limit", async () => {
    const w = new SqliteAuditWriter(dbPath);
    for (let i = 0; i < 10; i++) {
      await w.write(
        attempted(
          `01TESTID000000000000LIMI${String(i).padStart(2, "0")}`,
          "Q1",
          1_700_000_000_000 + i,
        ),
      );
    }
    const rows = w.readSince("0", 3);
    expect(rows.length).toBe(3);
    await w.close();
  });

  test("deleteThrough is inclusive of the given id", async () => {
    const w = new SqliteAuditWriter(dbPath);
    await w.write(attempted("01TESTID000000000000DELT01", "Q1", 1_700_000_000_001));
    await w.write(attempted("01TESTID000000000000DELT02", "Q1", 1_700_000_000_002));
    await w.write(attempted("01TESTID000000000000DELT03", "Q1", 1_700_000_000_003));

    const deleted = w.deleteThrough("01TESTID000000000000DELT02");
    expect(deleted).toBe(2);
    const remaining = w.readSince("0", 100);
    expect(remaining.map((r) => r.id)).toEqual(["01TESTID000000000000DELT03"]);
    await w.close();
  });

  test("deleteThrough is idempotent — second call returns 0", async () => {
    const w = new SqliteAuditWriter(dbPath);
    await w.write(attempted("01TESTID000000000000IDEM01", "Q1", 1_700_000_000_001));
    await w.write(attempted("01TESTID000000000000IDEM02", "Q1", 1_700_000_000_002));

    const first = w.deleteThrough("01TESTID000000000000IDEM02");
    expect(first).toBe(2);
    const second = w.deleteThrough("01TESTID000000000000IDEM02");
    expect(second).toBe(0);
    await w.close();
  });
});

describe("SqliteAuditWriter — 0.1 → 0.2 migration", () => {
  test("existing audit DB without `database` column gets ALTER + default __default__", async () => {
    // Simulate a 0.1.x audit DB: build the legacy schema by hand, insert a
    // row, then open it with SqliteAuditWriter (which should ALTER it).
    const probe = new Database(dbPath);
    probe.run(`
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        query_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        agent_identity TEXT,
        ts INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1
      );
    `);
    probe.run(
      "INSERT INTO audit_events (id, query_id, tenant_id, agent_identity, ts, event_type, payload, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "01LEGACY00000000000000000A",
        "Q-LEG",
        "42",
        null,
        1_700_000_000_000,
        "ATTEMPTED",
        '{"sql_raw":"SELECT 1","sql_fingerprint":"0123456789abcdef"}',
        1,
      ],
    );
    probe.close();

    const w = new SqliteAuditWriter(dbPath);
    const rows = w.readSince("0", 100);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.database).toBe("__default__");

    // New writes also work and tag the new column.
    await w.write(attempted("01LEGACY00000000000000000B", "Q-NEW", 1_700_000_000_001));
    const after = w.readSince("0", 100);
    expect(after).toHaveLength(2);
    expect(after.map((r) => r.database)).toEqual(["__default__", "__default__"]);
    await w.close();
  });
});

describe("SqliteAuditWriter — 0.2 → 0.3 migration", () => {
  test("legacy DB with agent_identity column has it dropped + new columns added", async () => {
    // Simulate a 0.2.x audit DB shape: post-`database` ALTER but pre-split.
    const probe = new Database(dbPath);
    probe.run(`
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        query_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        database TEXT NOT NULL DEFAULT '__default__',
        agent_identity TEXT,
        ts INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1
      );
    `);
    probe.run(
      "INSERT INTO audit_events (id, query_id, tenant_id, database, agent_identity, ts, event_type, payload, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "01LEGACY00000000000000023A",
        "Q-LEG",
        "42",
        "__default__",
        null,
        1_700_000_000_000,
        "ATTEMPTED",
        '{"sql_raw":"SELECT 1","sql_fingerprint":"0123456789abcdef"}',
        1,
      ],
    );
    probe.close();

    const w = new SqliteAuditWriter(dbPath);

    // Verify the column shape changed in place.
    const probe2 = new Database(dbPath);
    const cols = probe2.query("PRAGMA table_info(audit_events)").all() as Array<{
      name: string;
    }>;
    probe2.close();
    const colNames = cols.map((c) => c.name);
    expect(colNames).not.toContain("agent_identity");
    expect(colNames).toContain("agent_name");
    expect(colNames).toContain("agent_version");
    expect(colNames).toContain("agent_intent");
    expect(colNames).toContain("intent_source");

    // Pre-existing row survives with NULL on the new columns.
    const rows = w.readSince("0", 100);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent_name).toBeNull();
    expect(rows[0]!.agent_version).toBeNull();
    expect(rows[0]!.agent_intent).toBeNull();
    expect(rows[0]!.intent_source).toBeNull();

    // New writes populate the split columns.
    await w.write(attempted("01LEGACY00000000000000023B", "Q-NEW", 1_700_000_000_001));
    const after = w.readSince("0", 100);
    expect(after[1]!.agent_name).toBe("claude-code");
    expect(after[1]!.agent_version).toBe("0.42.1");
    await w.close();
  });

  test("re-running migration on already-migrated DB is a no-op", async () => {
    // First open creates the new schema from scratch.
    const w1 = new SqliteAuditWriter(dbPath);
    await w1.write(attempted("01TESTID000000000000IDEM01", "Q1", 1_700_000_000_000));
    await w1.close();

    // Second open against the same file should not throw — every ALTER is
    // gated on hasColumn() so the migration is idempotent.
    const w2 = new SqliteAuditWriter(dbPath);
    expect(w2._count()).toBe(1);
    await w2.close();
  });
});

describe("SqliteAuditWriter — payload validation", () => {
  test("invalid event_type rejected before insert", async () => {
    const w = new SqliteAuditWriter(dbPath);
    const bad = {
      id: "01TESTID000000000000BADD01",
      query_id: "Q1",
      tenant_id: "42",
      database: "__default__",
      agent_name: null,
      agent_version: null,
      agent_intent: null,
      intent_source: null,
      ts: 1_700_000_000_000,
      schema_version: 2 as const,
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
      database: "__default__",
      agent_name: null,
      agent_version: null,
      agent_intent: null,
      intent_source: null,
      ts: 1_700_000_000_000,
      schema_version: 2,
      event_type: "ATTEMPTED",
      payload: { sql_raw: "x", sql_fingerprint: "not-hex" },
    };
    await expect(w.write(bad)).rejects.toBeInstanceOf(AuditUnavailableError);
    await w.close();
  });
});
