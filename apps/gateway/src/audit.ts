// The local audit log: SQLite in WAL mode with full sync, so an event is on
// disk before `append` returns. ATTEMPTED and DECIDED are written before a
// statement runs; if either write fails, it doesn't run. Each event carries
// the hash of the one before it, so a removed or edited event breaks the
// chain. No result rows are ever stored.
//
// Several processes may append to one file (two local sessions, say): each
// append takes the next sequence and the hash before it from the file, in
// its write transaction. Each file is an instance with a random id, made
// with the file: replicas sharing one gateway identity each push their own
// sequence, so a linked gateway keeps a file of its own. A file whose
// history forked from what the cloud holds under its id (a restored backup,
// a copy) gets a new one. A linked gateway owes every event to the cloud
// until the cloud acks it; local mode owes nothing, so its events count as
// acked when written, and opening a file in it releases what a linked
// gateway left owed, counting from then. Retention deletes only a prefix of
// events acked longer ago than the window, and never one a live approval
// may still need; it keeps the last one's sequence and hash as the anchor
// the chain is verified from.
//
// The cloud never sees the chain's hashes: it holds every field of an event
// but its text, and the hash before it, so with them it could test a guess
// at a literal offline. It gets each hash keyed instead, an HMAC under a
// random key made with the file, which leaves it only in an export.
//
// In local mode the same file keeps taint, which in linked mode lives in the
// cloud so every gateway instance sees it. A held write's APPROVAL events
// tie its approval id to the attempt that filed it, so a recount finds the
// statement here rather than taking one from the cloud.

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  APPROVAL_WINDOWS,
  AUDIT_GENESIS_HASH,
  type AuditEvent,
  AuditEventSchema,
  type AuditHead,
} from "@midplane/protocol";

const GENESIS = AUDIT_GENESIS_HASH;

/** An event as the file stores it: the body is what its hash covers. */
export interface AuditRow {
  seq: number;
  body: string;
  prev_hash: string;
  hash: string;
}

/** Where verification starts: the last pruned event, or nothing at all. */
export interface AuditAnchor {
  seq: number;
  hash: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The longest a held write's events are read back: its request may wait the
 * longest pending window, then run within the longest approved one, and a
 * recount or `check_approval` needs its ATTEMPTED and APPROVAL events all
 * that time. Retention never deletes an event younger than this.
 */
const APPROVAL_LIFE_MS =
  (APPROVAL_WINDOWS.pending.max + APPROVAL_WINDOWS.approved.max) * 60 * 1000;

/** How long an append waits for another process's write to finish. */
const BUSY_TIMEOUT_MS = 5_000;

const hashOf = (prev: string, body: string) =>
  createHash("sha256").update(prev).update(body).digest("hex");

/**
 * What Midplane Cloud holds of an event's hash: HMAC-SHA256 of its hex,
 * under the file's checkpoint key (32 bytes, hex).
 */
export const checkpointOf = (key: string, hash: string) =>
  createHmac("sha256", Buffer.from(key, "hex")).update(hash).digest("hex");

export type ChainCheck =
  | { ok: true; events: number; last: AuditAnchor }
  | { ok: false; seq: number; problem: string };

/**
 * Checks a run of events, one at a time, from an anchor: each follows the
 * one before it in sequence, names its hash, and hashes its own body with
 * it. The first problem sticks.
 */
export class ChainVerifier {
  private lastSeen: AuditAnchor;
  private count = 0;
  private failure: { seq: number; problem: string } | null = null;

  constructor(anchor: AuditAnchor) {
    this.lastSeen = anchor;
  }

  /** Check the next event; false once the chain is broken. */
  add(r: AuditRow): boolean {
    if (this.failure) return false;
    const last = this.lastSeen;
    let problem: string | null = null;
    if (r.seq !== last.seq + 1) {
      problem =
        r.seq <= last.seq
          ? `event ${r.seq} is out of order after ${last.seq}`
          : `events ${last.seq + 1} to ${r.seq - 1} are missing`;
    } else if (r.prev_hash !== last.hash) {
      problem = `event ${r.seq} doesn't follow the hash of event ${last.seq}`;
    } else if (r.hash !== hashOf(r.prev_hash, r.body)) {
      problem = `event ${r.seq} doesn't match its hash: it was changed`;
    }
    if (problem) {
      this.failure = { seq: r.seq, problem };
      return false;
    }
    this.lastSeen = { seq: r.seq, hash: r.hash };
    this.count++;
    return true;
  }

  result(): ChainCheck {
    return this.failure
      ? { ok: false, ...this.failure }
      : { ok: true, events: this.count, last: this.lastSeen };
  }
}

/** Check a run of events from an anchor. */
export function verifyRows(
  rows: Iterable<AuditRow>,
  anchor: AuditAnchor,
): ChainCheck {
  const v = new ChainVerifier(anchor);
  for (const r of rows) if (!v.add(r)) break;
  return v.result();
}

function readMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function readAnchor(db: DatabaseSync): AuditAnchor {
  const seq = readMeta(db, "anchor_seq");
  const hash = readMeta(db, "anchor_hash");
  return seq !== null && hash !== null
    ? { seq: Number(seq), hash }
    : { seq: 0, hash: GENESIS };
}

/** The newest event, or the anchor when every event was pruned. */
function headOf(db: DatabaseSync): AuditAnchor {
  const last = db
    .prepare("SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1")
    .get() as AuditAnchor | undefined;
  return last ?? readAnchor(db);
}

function* rowsOf(db: DatabaseSync, since = 0): Generator<AuditRow> {
  const stmt = db.prepare(
    "SELECT seq, body, prev_hash, hash FROM audit_events WHERE seq >= ? ORDER BY seq",
  );
  for (const r of stmt.iterate(since)) yield r as unknown as AuditRow;
}

/**
 * An audit file opened read-only, beside a gateway that may be writing it:
 * for `midplane audit export` and `verify`. Everything it reads comes from
 * one snapshot, taken as it opens: a prune committing meanwhile can't move
 * the anchor out from under the rows.
 */
export class AuditFileReader {
  private readonly db: DatabaseSync;
  /** Null for a file only a gateway before 0.21 has opened. */
  readonly instance: string | null;
  readonly anchor: AuditAnchor;
  /** The key of the cloud's hashes; null for a file no gateway made one in. */
  readonly checkpointKey: string | null;

  constructor(path: string) {
    try {
      this.db = new DatabaseSync(path, { readOnly: true });
      // In WAL mode a read transaction keeps the snapshot its first read
      // takes until it ends, which `close()` does.
      this.db.exec("BEGIN");
      this.instance = readMeta(this.db, "instance_id");
      this.anchor = readAnchor(this.db);
      this.checkpointKey = readMeta(this.db, "checkpoint_key");
    } catch (err) {
      throw new AuditUnavailableError(err);
    }
  }

  /** The hash Midplane Cloud holds for this one; null without a key. */
  checkpoint(hash: string): string | null {
    return this.checkpointKey === null
      ? null
      : checkpointOf(this.checkpointKey, hash);
  }

  /** Events from `since` on (all by default), in order. */
  rows(since = 0): Generator<AuditRow> {
    return rowsOf(this.db, since);
  }

  /** The event just before `seq`: where an export from `seq` starts. */
  before(seq: number): AuditAnchor {
    const row = this.db
      .prepare(
        "SELECT seq, hash FROM audit_events WHERE seq < ? ORDER BY seq DESC LIMIT 1",
      )
      .get(seq) as AuditAnchor | undefined;
    return row ?? this.anchor;
  }

  verify(): ChainCheck {
    return verifyRows(this.rows(), this.anchor);
  }

  close(): void {
    this.db.close();
  }
}

export interface AuditLogOptions {
  /**
   * Linked mode: each event is owed to the cloud until it acks it. Local
   * mode owes nothing: its events are written as acked, and opening a file
   * in it stops owing the events still waiting.
   */
  owed?: boolean;
}

export interface AuditWriter {
  append(event: AuditEvent): void;
}

/** The attempt a held write was filed from. */
export type HeldStatement = Extract<AuditEvent, { event: "ATTEMPTED" }>;

export interface HeldStatements {
  /** The statement an approval was filed for through this gateway, if any. */
  heldStatement(approvalId: string): HeldStatement | null;
  /**
   * Whether this gateway already claimed the approval: an approval runs at
   * most once here, whatever the cloud's database says.
   */
  claimedHere(approvalId: string): boolean;
}

export class AuditUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `audit log unavailable: ${(cause as Error)?.message ?? String(cause)}`,
    );
    this.name = "AuditUnavailableError";
  }
}

export class LocalAuditLog implements AuditWriter, HeldStatements {
  private readonly db: DatabaseSync;
  private readonly owed: boolean;
  private current: string;
  private readonly key: string;
  /**
   * Events recorded while linked that never reached the cloud, which opening
   * the file in local mode stopped owing. Zero in linked mode.
   */
  readonly unsent: number;
  private readonly listeners = new Set<() => void>();

  constructor(path: string, options: AuditLogOptions = {}) {
    this.owed = options.owed ?? false;
    try {
      this.db = new DatabaseSync(path);
      // Another process appending holds the write lock for a moment.
      this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = FULL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS audit_events (
          seq INTEGER PRIMARY KEY,
          query_id TEXT NOT NULL,
          event TEXT NOT NULL,
          at TEXT NOT NULL,
          body TEXT NOT NULL,
          prev_hash TEXT NOT NULL,
          hash TEXT NOT NULL,
          acked INTEGER NOT NULL DEFAULT 0,
          acked_at TEXT
        );
        CREATE TABLE IF NOT EXISTS taints (
          grant_id TEXT PRIMARY KEY,
          since TEXT NOT NULL,
          source TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS audit_events_query_idx ON audit_events (query_id);
        CREATE INDEX IF NOT EXISTS audit_events_approval_idx
          ON audit_events (json_extract(body, '$.approval_id'))
          WHERE event = 'APPROVAL';
        CREATE INDEX IF NOT EXISTS audit_events_unacked_idx
          ON audit_events (seq) WHERE acked = 0;
      `);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // Retention counts from when an event stopped being owed. A file
        // from before 0.21 lacks the column; its acked rows fall back to
        // their own time.
        const columns = this.db
          .prepare("SELECT name FROM pragma_table_info('audit_events')")
          .all() as { name: string }[];
        if (!columns.some((c) => c.name === "acked_at")) {
          this.db.exec("ALTER TABLE audit_events ADD COLUMN acked_at TEXT");
        }
        // Released events count retention from now, when they stopped
        // being owed, as acked ones count from their ack: what a linked
        // gateway left unsent gets the full window to be exported.
        const release = this.db.prepare(
          "UPDATE audit_events SET acked = 1, acked_at = ? WHERE acked = 0",
        );
        const opened = new Date().toISOString();
        const made = this.db
          .prepare(
            "INSERT INTO meta (key, value) VALUES ('instance_id', ?) ON CONFLICT (key) DO NOTHING",
          )
          .run(randomUUID());
        // A file getting its instance id now is new, or from a gateway
        // before 0.21, which never pushed and left every row at acked = 0:
        // the cloud is missing none of them, so none is owed.
        if (Number(made.changes) > 0) release.run(opened);
        // Made as the instance id is: what keys the hashes the cloud holds.
        this.db
          .prepare(
            "INSERT INTO meta (key, value) VALUES ('checkpoint_key', ?) ON CONFLICT (key) DO NOTHING",
          )
          .run(randomBytes(32).toString("hex"));
        // Local mode sends nothing, so what a linked gateway left unsent
        // here is owed no longer; the gateway says how many, once.
        this.unsent = this.owed ? 0 : Number(release.run(opened).changes);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
      this.current = readMeta(this.db, "instance_id") as string;
      this.key = readMeta(this.db, "checkpoint_key") as string;
      // Prove the file takes writes now, rather than on the first statement:
      // a read-only file still opens, and fails only when written.
      this.db
        .prepare(
          "INSERT INTO meta (key, value) VALUES ('opened_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .run(new Date().toISOString());
    } catch (err) {
      throw new AuditUnavailableError(err);
    }
  }

  /**
   * This file's instance id: made with it, and made again when the file
   * forks from what the cloud holds under it.
   */
  get instance(): string {
    return this.current;
  }

  /**
   * The hash Midplane Cloud is given for one of this file's: keyed, so the
   * cloud can't test a guess at an event's text against it.
   */
  checkpoint(hash: string): string {
    return checkpointOf(this.key, hash);
  }

  /**
   * Give the file a new instance id, after the cloud acked one of its
   * batches naming another event at a sequence it sent: the file was
   * restored from a backup, or copied to a second process. Nothing is
   * acked; the owed events go again as the new instance, a stream of their
   * own, and the export and `verify` name it from now on. The ids it had
   * stay in `previous_instances`, oldest first: the cloud's export holds
   * their events under them.
   */
  newInstance(): string {
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const set = this.db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      );
      const previous = JSON.parse(
        readMeta(this.db, "previous_instances") ?? "[]",
      ) as string[];
      const old = readMeta(this.db, "instance_id");
      if (old !== null) previous.push(old);
      set.run("previous_instances", JSON.stringify(previous));
      set.run("instance_id", id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.current = id;
    return id;
  }

  append(event: AuditEvent): void {
    const body = JSON.stringify(AuditEventSchema.parse(event));
    try {
      // The event before is read in the write transaction, from the file:
      // another process may have appended since this one last did.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // Sequences are explicit: after pruning everything, the next event
        // still follows the anchor rather than starting again at 1.
        const last = headOf(this.db);
        this.db
          .prepare(
            "INSERT INTO audit_events (seq, query_id, event, at, body, prev_hash, hash, acked, acked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            last.seq + 1,
            event.query_id,
            event.event,
            event.at,
            body,
            last.hash,
            hashOf(last.hash, body),
            this.owed ? 0 : 1,
            this.owed ? null : event.at,
          );
        this.db.exec("COMMIT");
      } catch (err) {
        // A failed COMMIT may have rolled back already.
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        throw err;
      }
    } catch (err) {
      throw new AuditUnavailableError(err);
    }
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener (the pusher) never gets in the way of a statement.
      }
    }
  }

  /** Called after each durable append; returns a function that stops it. */
  onAppend(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The oldest events the cloud doesn't have yet, in order. */
  unacked(limit: number): AuditRow[] {
    return this.db
      .prepare(
        "SELECT seq, body, prev_hash, hash FROM audit_events WHERE acked = 0 ORDER BY seq LIMIT ?",
      )
      .all(limit) as unknown as AuditRow[];
  }

  /**
   * The cloud has every event up to `seq`. Retention counts from now for
   * the events newly acked; an event acked before keeps its time.
   */
  ack(seq: number, now: Date = new Date()): void {
    this.db
      .prepare(
        "UPDATE audit_events SET acked = 1, acked_at = ? WHERE acked = 0 AND seq <= ?",
      )
      .run(now.toISOString(), seq);
  }

  /** The chain's head, and how many events are still owed. */
  head(): AuditHead {
    const owed = this.db
      .prepare("SELECT count(*) AS n FROM audit_events WHERE acked = 0")
      .get() as { n: number };
    const last = headOf(this.db);
    return {
      instance: this.current,
      seq: last.seq,
      hash: last.hash,
      unacked: Number(owed.n),
    };
  }

  /** The ATTEMPTED event of a query, if this file holds it. */
  attempted(queryId: string): HeldStatement | null {
    const row = this.db
      .prepare(
        "SELECT body FROM audit_events WHERE query_id = ? AND event = 'ATTEMPTED' ORDER BY seq LIMIT 1",
      )
      .get(queryId) as { body: string } | undefined;
    if (!row) return null;
    const event = AuditEventSchema.parse(JSON.parse(row.body));
    return event.event === "ATTEMPTED" ? event : null;
  }

  /**
   * Delete the longest run of events, from the oldest, that stopped being
   * owed longer ago than the window and are older than any live approval,
   * and keep the last one as the anchor. Only a prefix goes, so the rest
   * still verifies. Returns how many went.
   */
  prune(retentionDays: number, now: Date = new Date()): number {
    if (retentionDays <= 0) return 0;
    const cutoff = new Date(now.getTime() - retentionDays * MS_PER_DAY);
    const approvals = new Date(now.getTime() - APPROVAL_LIFE_MS);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // From the ack, not the event: a backlog the cloud took after an
      // outage is kept the full window. Rows acked before acked_at existed
      // have only their own time.
      const keep = this.db
        .prepare(
          "SELECT min(seq) AS seq FROM audit_events WHERE NOT (acked = 1 AND coalesce(acked_at, at) < ? AND at < ?)",
        )
        .get(cutoff.toISOString(), approvals.toISOString()) as {
        seq: number | null;
      };
      const last = this.db
        .prepare(
          "SELECT seq, hash FROM audit_events WHERE seq < coalesce(?, 9223372036854775807) ORDER BY seq DESC LIMIT 1",
        )
        .get(keep.seq) as AuditAnchor | undefined;
      if (!last) {
        this.db.exec("COMMIT");
        return 0;
      }
      const gone = this.db
        .prepare("DELETE FROM audit_events WHERE seq <= ?")
        .run(last.seq);
      const set = this.db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      );
      set.run("anchor_seq", String(last.seq));
      set.run("anchor_hash", last.hash);
      this.db.exec("COMMIT");
      return Number(gone.changes);
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Where verification starts: the last pruned event, or the genesis hash. */
  anchor(): AuditAnchor {
    return readAnchor(this.db);
  }

  isTainted(grantId: string): boolean {
    try {
      return (
        this.db
          .prepare("SELECT 1 FROM taints WHERE grant_id = ?")
          .get(grantId) !== undefined
      );
    } catch {
      // Can't tell: treat as tainted, which only ever narrows.
      return true;
    }
  }

  /** Durable before it returns; the caller refuses the read if it throws. */
  taint(grantId: string, source: string, at: string): void {
    this.db
      .prepare(
        "INSERT INTO taints (grant_id, since, source) VALUES (?, ?, ?) ON CONFLICT (grant_id) DO NOTHING",
      )
      .run(grantId, at, source);
  }

  heldStatement(approvalId: string): HeldStatement | null {
    const filed = this.db
      .prepare(
        "SELECT query_id FROM audit_events WHERE event = 'APPROVAL' AND json_extract(body, '$.approval_id') = ? AND json_extract(body, '$.step') = 'filed' ORDER BY seq LIMIT 1",
      )
      .get(approvalId) as { query_id: string } | undefined;
    if (!filed) return null;
    const row = this.db
      .prepare(
        "SELECT body FROM audit_events WHERE query_id = ? AND event = 'ATTEMPTED' ORDER BY seq LIMIT 1",
      )
      .get(filed.query_id) as { body: string } | undefined;
    if (!row) return null;
    const event = AuditEventSchema.parse(JSON.parse(row.body));
    return event.event === "ATTEMPTED" ? event : null;
  }

  claimedHere(approvalId: string): boolean {
    try {
      return (
        this.db
          .prepare(
            "SELECT 1 FROM audit_events WHERE event = 'APPROVAL' AND json_extract(body, '$.approval_id') = ? AND json_extract(body, '$.step') = 'claimed' LIMIT 1",
          )
          .get(approvalId) !== undefined
      );
    } catch {
      // Can't tell: treat it as used, which only ever refuses.
      return true;
    }
  }

  /** Every event in order; for tests. */
  events(): {
    seq: number;
    event: AuditEvent;
    prev_hash: string;
    hash: string;
  }[] {
    return [...rowsOf(this.db)].map((r) => ({
      seq: r.seq,
      event: AuditEventSchema.parse(JSON.parse(r.body)),
      prev_hash: r.prev_hash,
      hash: r.hash,
    }));
  }

  /**
   * True when, from the anchor on, every event follows the one before it
   * and its hash covers its body.
   */
  verifyChain(): boolean {
    return verifyRows(rowsOf(this.db), readAnchor(this.db)).ok;
  }

  close(): void {
    this.db.close();
  }
}
