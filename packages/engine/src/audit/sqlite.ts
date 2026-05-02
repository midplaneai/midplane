// bun:sqlite audit writer — the local durable buffer.
//
// Day-0 spike finding: bun:sqlite (NOT better-sqlite3) — better-sqlite3
// fails to load native bindings under Bun (Bun issue #4290). bun:sqlite has
// a similar enough API. Engine package is Bun-runtime primary.
//
// Schema is loaded from `schema.sql` at construction. WAL mode is set
// inline so concurrent reads while a single writer commits work cleanly.

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AuditWriter } from "./index.ts";
import { AuditEvent } from "./types.ts";
import { AuditUnavailableError } from "../errors.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "schema.sql");

const INSERT_SQL = `
  INSERT INTO audit_events (
    id, query_id, tenant_id, database,
    agent_name, agent_version, agent_intent,
    ts, event_type, payload, schema_version
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const READ_SINCE_SQL = `
  SELECT id, query_id, tenant_id, database,
         agent_name, agent_version, agent_intent,
         ts, event_type, payload, schema_version
  FROM audit_events
  WHERE id > ?
  ORDER BY id
  LIMIT ?
`;

const DELETE_THROUGH_SQL = `
  DELETE FROM audit_events WHERE id <= ?
`;

// Row shape returned by readSince — payload is JSON-parsed (TEXT in storage).
// Mirrors the columns documented in schema.sql.
export interface AuditEventRow {
  id: string;
  query_id: string;
  tenant_id: string;
  database: string;
  agent_name: string | null;
  agent_version: string | null;
  agent_intent: string | null;
  ts: number;
  event_type: string;
  payload: unknown;
  schema_version: number;
}

interface RawAuditRow {
  id: string;
  query_id: string;
  tenant_id: string;
  database: string;
  agent_name: string | null;
  agent_version: string | null;
  agent_intent: string | null;
  ts: number;
  event_type: string;
  payload: string;
  schema_version: number;
}

export class SqliteAuditWriter implements AuditWriter {
  private db: Database;
  private insertStmt: ReturnType<Database["prepare"]>;
  private readSinceStmt: ReturnType<Database["prepare"]>;
  private deleteThroughStmt: ReturnType<Database["prepare"]>;

  constructor(path: string, opts: { create?: boolean } = {}) {
    // bun:sqlite requires an explicit readwrite/readonly flag whenever
    // `create` is false; passing `{ create: false }` alone trips its
    // validation. With `create: true` (our default) the readwrite mode
    // is implied. Callers like the audit CLI pass `create: false` to
    // surface a friendly error on a typo'd DB_PATH instead of silently
    // creating an empty file.
    this.db = new Database(
      path,
      opts.create === false
        ? { readwrite: true, create: false }
        : { create: true },
    );
    this.applySchema();
    this.insertStmt = this.db.prepare(INSERT_SQL);
    this.readSinceStmt = this.db.prepare(READ_SINCE_SQL);
    this.deleteThroughStmt = this.db.prepare(DELETE_THROUGH_SQL);
  }

  private applySchema(): void {
    // Migrate pre-existing audit DBs in place BEFORE running the bundled DDL,
    // because schema.sql declares indexes/columns that would crash against a
    // legacy table shape. The CREATE TABLE in schema.sql is `IF NOT EXISTS`,
    // so it's a no-op once the legacy table exists.
    const tableExists =
      (this.db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='audit_events'",
        )
        .get()?.name ?? null) !== null;
    if (tableExists) {
      // 0.1 → 0.2: add `database` column.
      if (!this.hasColumn("audit_events", "database")) {
        this.db.run(
          "ALTER TABLE audit_events ADD COLUMN database TEXT NOT NULL DEFAULT '__default__'",
        );
      }
      // 0.2 → 0.3: replace single `agent_identity` column with split
      // `agent_name`/`agent_version`, and add `agent_intent`. We add the
      // new columns first; the legacy column is dropped last so a
      // partially-migrated DB can be re-run idempotently. SQLite's ALTER
      // TABLE DROP COLUMN landed in 3.35 (March 2021) — Bun ships well past
      // that, so DROP is the cleanest path. Old rows lose their
      // agent_identity value, which was always NULL in 0.1.x/0.2.x because
      // no transport ever populated it.
      if (!this.hasColumn("audit_events", "agent_name")) {
        this.db.run("ALTER TABLE audit_events ADD COLUMN agent_name TEXT");
      }
      if (!this.hasColumn("audit_events", "agent_version")) {
        this.db.run("ALTER TABLE audit_events ADD COLUMN agent_version TEXT");
      }
      if (!this.hasColumn("audit_events", "agent_intent")) {
        this.db.run("ALTER TABLE audit_events ADD COLUMN agent_intent TEXT");
      }
      if (this.hasColumn("audit_events", "agent_identity")) {
        this.db.run("ALTER TABLE audit_events DROP COLUMN agent_identity");
      }
      // 0.3 → 0.4: collapse the three resolution channels into a single
      // structured `intent` tool arg, dropping the `intent_source` column
      // (always one source now). Old rows lose their intent_source value,
      // which was always one of mcp_meta/sql_comment/http_header — readers
      // that grouped on it just see `agent_intent` IS NOT NULL going
      // forward.
      //
      // After dropping the column, backfill `schema_version = 3` on every
      // row that still claims v2: the row no longer matches the v2 wire
      // contract (which required intent_source), so leaving it stamped v2
      // would make a v2-pinned parser read garbage. Setting v3 forces the
      // parser into its forward-compat branch instead. v1 rows (pre-0.3,
      // no agent_* fields at all) are left as-is — they predate this
      // column entirely and are still self-consistent.
      if (this.hasColumn("audit_events", "intent_source")) {
        this.db.run("ALTER TABLE audit_events DROP COLUMN intent_source");
        this.db.run(
          "UPDATE audit_events SET schema_version = 3 WHERE schema_version = 2",
        );
      }
    }

    // PRAGMAs in the schema file run during table create. We also explicitly
    // ensure WAL mode in case the file pre-existed without it.
    const ddl = readFileSync(SCHEMA_PATH, "utf8");
    // Strip the commented-out Postgres section so SQLite doesn't choke.
    const sqliteOnly = stripPostgresSection(ddl);
    this.db.run(sqliteOnly);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
  }

  private hasColumn(table: string, col: string): boolean {
    const rows = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    return rows.some((r) => r.name === col);
  }

  async write(event: AuditEvent): Promise<void> {
    // Validate the event against the locked zod union before writing.
    // A schema mismatch is a hard error — never silently degrade audit data.
    const parsed = AuditEvent.safeParse(event);
    if (!parsed.success) {
      throw new AuditUnavailableError(
        `audit event failed schema validation: ${parsed.error.message}`,
        parsed.error,
      );
    }

    try {
      this.insertStmt.run(
        event.id,
        event.query_id,
        event.tenant_id,
        event.database,
        event.agent_name,
        event.agent_version,
        event.agent_intent,
        event.ts,
        event.event_type,
        JSON.stringify(event.payload),
        event.schema_version,
      );
    } catch (err) {
      throw new AuditUnavailableError(
        `sqlite write failed: ${(err as Error).message}`,
        err,
      );
    }
  }

  // Read events with id strictly greater than `cursor`, ordered by id, capped
  // at `limit`. Cursor "0" (or any non-ULID lex-smaller value) reads from the
  // beginning. Payload column is JSON-parsed before return.
  readSince(cursor: string, limit: number): AuditEventRow[] {
    const rows = this.readSinceStmt.all(cursor, limit) as RawAuditRow[];
    return rows.map((r) => ({
      id: r.id,
      query_id: r.query_id,
      tenant_id: r.tenant_id,
      database: r.database,
      agent_name: r.agent_name,
      agent_version: r.agent_version,
      agent_intent: r.agent_intent,
      ts: r.ts,
      event_type: r.event_type,
      payload: JSON.parse(r.payload),
      schema_version: r.schema_version,
    }));
  }

  // Delete every row with id <= `id` (inclusive). Returns rows affected.
  // Idempotent: a second call with the same id returns 0.
  deleteThrough(id: string): number {
    const result = this.deleteThroughStmt.run(id);
    return Number(result.changes);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // For test inspection only.
  _readAll(): unknown[] {
    return this.db.query("SELECT * FROM audit_events ORDER BY ts").all();
  }

  _count(): number {
    const row = this.db.query("SELECT COUNT(*) AS c FROM audit_events").get() as { c: number };
    return row.c;
  }
}

function stripPostgresSection(ddl: string): string {
  // Schema file delimits the Postgres mirror block with a comment header.
  // Drop everything from the HOSTED Postgres header onward — those lines
  // are commented but the bun:sqlite DDL parser still runs over them.
  const marker = "-- HOSTED Postgres mirror";
  const idx = ddl.indexOf(marker);
  return idx >= 0 ? ddl.slice(0, idx) : ddl;
}
