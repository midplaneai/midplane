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

export class SqliteAuditWriter implements AuditWriter {
  private db: Database;
  private insertStmt: ReturnType<Database["prepare"]>;

  constructor(path: string, opts: { create?: boolean } = {}) {
    this.db = new Database(path, { create: opts.create ?? true });
    this.applySchema();
    this.insertStmt = this.db.prepare(INSERT_SQL);
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
