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
  INSERT INTO audit_events (id, query_id, tenant_id, agent_identity, ts, event_type, payload, schema_version)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`;

const READ_SINCE_SQL = `
  SELECT id, query_id, tenant_id, agent_identity, ts, event_type, payload, schema_version
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
  agent_identity: string | null;
  ts: number;
  event_type: string;
  payload: unknown;
  schema_version: number;
}

interface RawAuditRow {
  id: string;
  query_id: string;
  tenant_id: string;
  agent_identity: string | null;
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
    this.db = new Database(path, { create: opts.create ?? true });
    this.applySchema();
    this.insertStmt = this.db.prepare(INSERT_SQL);
    this.readSinceStmt = this.db.prepare(READ_SINCE_SQL);
    this.deleteThroughStmt = this.db.prepare(DELETE_THROUGH_SQL);
  }

  private applySchema(): void {
    // PRAGMAs in the schema file run during table create. We also explicitly
    // ensure WAL mode in case the file pre-existed without it.
    const ddl = readFileSync(SCHEMA_PATH, "utf8");
    // Strip the commented-out Postgres section so SQLite doesn't choke.
    const sqliteOnly = stripPostgresSection(ddl);
    this.db.run(sqliteOnly);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
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
        event.agent_identity,
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
      agent_identity: r.agent_identity,
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
